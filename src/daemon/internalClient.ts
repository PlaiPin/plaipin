// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// The daemon's "internal client": a single persistent WebSocket connection to
// the codex app-server it spawned. This connection:
//   - issues `initialize` to handshake
//   - subscribes to per-thread events via `thread/resume` (see below)
//   - observes server notifications (broad-scope from any client; per-thread
//     scoped to threads we have explicitly resumed)
//   - relays ESP32-injected decisions back to server-initiated ServerRequests
//   - issues lightweight queries (thread/list, getConversationSummary) for
//     snapshot recovery
//
// Subscription model:
//
//   The codex app-server fans out notifications by scope:
//     - Broad-scope (every client gets these regardless of subscription):
//         thread/started, thread/closed, thread/status/changed,
//         thread/name/updated, remoteControl/*, account/rateLimits/*
//     - Per-thread-scoped (only clients that called thread/resume for that
//       thread):
//         turn/started, turn/completed, turn/diff/updated, turn/plan/updated,
//         item/started, item/completed, item/agentMessage/delta,
//         item/commandExecution/outputDelta, item/fileChange/patchUpdated,
//         serverRequest/resolved, plus most other turn-internal events
//
//   Without thread/resume the internal client only sees broad-scope
//   events, missing all turn-related activity. Resume is idempotent per
//   (client, thread); multiple subscribers (e.g. Codex.app + this daemon)
//   are fine.

import pino from "pino";
import { RpcClient } from "../shared/rpc.js";
import type {
  InitializeResponse,
  ThreadListResponse,
  ThreadListParams,
  ThreadResumeResponse,
} from "../shared/protocol.js";
import { OPT_OUT_NOTIFICATION_METHODS } from "../shared/protocol.js";
import { synthesizeFromResume, type Dispatcher } from "./synthesizeFromResume.js";

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

/**
 * Detect the specific "rollout file not yet persisted" error returned by
 * the server when we call thread/resume on a freshly-created thread. The
 * server's error message contains the literal phrase "no rollout found";
 * code is generic JSON-RPC InvalidParams (-32602) so we have to match on
 * the message. Acceptable: this string is server-side and won't change
 * casually.
 */
function isNoRolloutFoundError(err: Error): boolean {
  return /no rollout found/i.test(err.message);
}

export interface InternalClientOptions {
  /** Path to the unix socket. */
  socketPath: string;
  /** Used in the ClientInfo. */
  daemonVersion: string;
  /**
   * Dispatcher to feed synthetic notifications through when a
   * `thread/resume` returns a snapshot. Same function that handles live
   * notifications — `notify.ts`'s exported dispatcher. Idempotent at
   * the state-model level so live + replay overlap is safe.
   */
  dispatch: Dispatcher;
}

export class InternalClient {
  readonly rpc: RpcClient;
  private opts: InternalClientOptions;
  initialized = false;
  serverInfo: InitializeResponse | null = null;
  /**
   * Threads we've sent thread/resume for. Tracked locally so we never
   * double-resume; thread/resume is idempotent on the server but doing
   * it twice still costs an RPC round-trip.
   */
  private subscribedThreads = new Set<string>();
  /**
   * In-flight resume promises, keyed by threadId. Lets concurrent
   * `resumeThread` calls for the same thread coalesce onto a single
   * RPC instead of racing.
   */
  private inflightResume = new Map<string, Promise<void>>();

  constructor(opts: InternalClientOptions) {
    this.opts = opts;
    this.rpc = new RpcClient({ label: "internal", requestTimeoutMs: 15_000 });
  }

  async connect(): Promise<void> {
    await this.rpc.connect(this.opts.socketPath);
    log.info({ socket: this.opts.socketPath }, "internal client WS open");
    this.serverInfo = await this.rpc.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "plaipin",
        title: "PlaiPin Daemon",
        version: this.opts.daemonVersion,
      },
      capabilities: {
        // Tell the server to stop sending notifications we'd just drop.
        // See protocol.ts for the curated list and rationale.
        optOutNotificationMethods: [...OPT_OUT_NOTIFICATION_METHODS],
        // Unlock experimental methods (e.g. for future stats RPCs).
        experimentalApi: true,
      },
    });
    this.rpc.notify("initialized", {});
    this.initialized = true;
    log.info(
      {
        codexHome: this.serverInfo.codexHome,
        ua: this.serverInfo.userAgent,
        optedOut: OPT_OUT_NOTIFICATION_METHODS.length,
      },
      "internal client initialized",
    );
  }

  async listThreads(params: ThreadListParams = { limit: 10 }): Promise<ThreadListResponse> {
    return this.rpc.request<ThreadListResponse>("thread/list", params);
  }

  /**
   * Subscribe to a thread's per-thread event scope AND replay its history.
   *
   * Adopts the secondary-observer pattern: `thread/resume` returns a
   * snapshot of the thread's current state when we don't pass
   * `excludeTurns: true`. We synthesize notifications for every turn +
   * item in the snapshot and feed them through the same dispatcher live
   * events use. Idempotency in the dispatcher (`state.ts`'s
   * `seenTurns` / `completedTurns` / `itemStatus`) makes the overlap
   * between live events and replay safe.
   *
   * Without this, fresh threads' first turn was invisible: per-thread
   * events fire only to subscribed clients, and our subscribe was racing
   * Codex.app's `thread/start` (which auto-subscribes the creator
   * atomically). Snapshot replay closes the race regardless of arrival
   * order.
   *
   * Idempotent at the call level: returns immediately if we already
   * hold a subscription, and coalesces concurrent calls onto a single
   * RPC.
   *
   * Retry semantics: the server can transiently return "no rollout
   * found" if our resume call beats the rollout file's persistence to
   * disk. Retry with exponential backoff. All other errors fail
   * immediately.
   */
  async resumeThread(threadId: string): Promise<void> {
    if (this.subscribedThreads.has(threadId)) return;
    const existing = this.inflightResume.get(threadId);
    if (existing) return existing;
    const p = this.resumeThreadWithRetry(threadId).finally(() => {
      this.inflightResume.delete(threadId);
    });
    this.inflightResume.set(threadId, p);
    return p;
  }

  private static readonly RESUME_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

  private async resumeThreadWithRetry(threadId: string): Promise<void> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= InternalClient.RESUME_RETRY_DELAYS_MS.length; attempt++) {
      try {
        // No `excludeTurns: true` — we want the full snapshot.
        const response = await this.rpc.request<ThreadResumeResponse>("thread/resume", {
          threadId,
        });
        this.subscribedThreads.add(threadId);
        // Replay snapshot through the dispatcher. Idempotent w.r.t. live
        // events that arrived during the resume RPC's flight time.
        if (response?.thread) {
          const stats = synthesizeFromResume(response.thread, this.opts.dispatch);
          if (stats.turns > 0) {
            log.info(
              { threadId, replayedTurns: stats.turns, replayedItems: stats.items },
              "thread snapshot replayed",
            );
          }
        }
        return;
      } catch (e) {
        lastErr = e as Error;
        if (!isNoRolloutFoundError(lastErr) || attempt === InternalClient.RESUME_RETRY_DELAYS_MS.length) {
          throw lastErr;
        }
        const delayMs = InternalClient.RESUME_RETRY_DELAYS_MS[attempt]!;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    /* unreachable */ throw lastErr ?? new Error("resume retry exhausted");
  }

  /**
   * Best-effort unsubscribe; safe to call for threads we never subscribed.
   * Server cleans up any subscriptions when the client disconnects, so
   * failures here are non-fatal.
   */
  async unsubscribeThread(threadId: string): Promise<void> {
    if (!this.subscribedThreads.has(threadId)) return;
    this.subscribedThreads.delete(threadId);
    try {
      await this.rpc.request("thread/unsubscribe", { threadId });
    } catch {
      /* server-side cleanup will happen on close anyway */
    }
  }

  isSubscribedToThread(threadId: string): boolean {
    return this.subscribedThreads.has(threadId);
  }

  /** Number of threads we currently hold subscriptions for. */
  get subscriptionCount(): number {
    return this.subscribedThreads.size;
  }

  close(): void {
    this.rpc.close();
  }
}
