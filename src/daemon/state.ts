// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Per-thread state model. Driven by the JSON-RPC notification stream coming
// from the internal client. Tracks active turn, pending approvals, simple
// status, and is the authoritative source for derived ESP32 events.

import { EventEmitter } from "node:events";
import type { RequestId } from "../shared/rpc.js";
import type {
  AgentMessageDeltaParams,
  AgentMessageItem,
  CommandExecutionItem,
  CommandExecutionOutputDeltaParams,
  ErrorNotificationParams,
  FileChangePatchUpdatedParams,
  FileUpdateChange,
  ItemCompletedParams,
  ItemStartedParams,
  ServerRequestResolvedParams,
  ThreadNameUpdatedParams,
  ThreadStartedParams,
  ThreadStatusChangedParams,
  ThreadTokenUsageUpdatedParams,
  TurnCompletedParams,
  TurnStartedParams,
  UserMessageItem,
} from "../shared/protocol.js";

interface PatchSnapshot {
  added: number;
  removed: number;
  files: number;
}

export type ThreadStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "running_command"
  | "awaiting_user"
  | "errored";

/**
 * Per-item lifecycle phase, with `source` on the completed phase to
 * distinguish a tentative payload (delivered via snapshot replay of an
 * active turn) from an authoritative one (live tail OR snapshot of a
 * terminal turn). The dispatcher's `onItemCompleted` enforces a
 * transition table that allows exactly one `snapshot → live` upgrade
 * per item id, re-emitting `item_completed` with the refined payload.
 *
 * Locked by `state.dispatcher.test.ts`.
 */
export type ItemStatus =
  | { phase: "started" }
  | { phase: "completed"; source: "snapshot" | "live" };

export interface PendingApproval {
  requestId: RequestId;
  method: string;
  params: unknown;
  receivedAt: number;
}

export interface TurnState {
  turnId: string;
  startedAt: number;
  hasAgentMessage: boolean;
  hasCommandRunning: boolean;
  status: string;
  error: unknown | null;
}

/**
 * Per-thread + global running counters surfaced to the ESP32 as stats_updated.
 *
 * `tokens` mirror what the server sends in `thread/tokenUsage/updated`: the
 * server publishes running TOTALS, not deltas, so we overwrite each time
 * (NOT increment) — see `onTokenUsageUpdated`.
 *
 * Everything else is incremented on the corresponding event. We don't track
 * lines-of-code yet (would require parsing each FileChangePatchUpdated's
 * `changes` payload); for now `filesChanged` is a count of patch updates,
 * which is a useful signal on its own.
 */
/**
 * Per-bucket token counters surfaced to the ESP32. Mirrors codex's
 * TokenUsageBreakdown — field names verbatim — so future schema audits
 * are a one-liner. See `src/shared/protocol.ts` for the source schema.
 *
 * `prompt` retained as an alias for `inputTokens` for backwards-compat
 * in the wire snapshot; new code should prefer the explicit names.
 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

export interface ConvStats {
  tokens: TokenStats;
  turnsStarted: number;
  turnsCompleted: number;
  turnsErrored: number;
  commandsStarted: number;
  commandsCompleted: number;
  /** Distinct file paths the agent has patched, summed across patch items. */
  filesChanged: number;
  /** Lines added / removed parsed from FileUpdateChange.diff strings. */
  loc: { added: number; removed: number };
  approvalsReceived: number;
  approvalsResolved: number;
}

export interface GlobalStats {
  threadsTotal: number;
  threadsEphemeral: number;
  tokens: TokenStats;
  turnsStarted: number;
  turnsCompleted: number;
  turnsErrored: number;
  commandsStarted: number;
  commandsCompleted: number;
  filesChanged: number;
  loc: { added: number; removed: number };
  approvalsReceived: number;
  approvalsResolved: number;
  daemonStartedAt: number;
  uptimeMs: number;
}

export interface ConversationState {
  threadId: string;
  name: string | null;
  status: ThreadStatus;
  activeTurn: TurnState | null;
  pendingApprovals: Map<RequestId, PendingApproval>;
  lastActivityAt: number;
  /**
   * Last time *this daemon process* observed a real user-activity event
   * (turn started, prompt, agent stream, command, approval). Distinct
   * from `lastActivityAt`, which we also seed from the disk hydration
   * sweep so threads sort sensibly by recency.
   *
   * `null` until the first live event arrives. `recomputeActive` ignores
   * threads with `null` here — otherwise on a fresh daemon start the disk
   * hydration would elect whichever thread was most recently mutated to
   * disk as "active", regardless of which thread the user has open in
   * Codex.app. The codex app-server has no notification announcing user
   * navigation (Codex.app's `thread/resume` is a private client→server
   * call), so "active=null until something happens" is the only correct
   * behavior we can implement.
   */
  lastLiveActivityAt: number | null;
  lastFocusedAt: number | null;
  /** Last completed turn id (for "happy"/"sad" mood transitions) */
  lastCompletedTurn: { turnId: string; status: string; at: number } | null;
  tokenUsage: { prompt?: number; completion?: number } | null;
  /**
   * `true` for system-internal threads (auto-naming, compaction, etc.).
   * These should not surface in the ESP32 view nor influence pet mood.
   */
  ephemeral: boolean;
  /** Server marked this thread compacted — surface as a status hint. */
  lastCompactedAt: number | null;
  /**
   * Set when a turn completes successfully on this thread; cleared when a
   * new turn starts OR after PetMachine's review window expires. Drives
   * the canonical `review` pet state.
   */
  unreadSince: number | null;
  /**
   * Set when a turn errors on this thread; cleared when a new turn starts
   * OR after PetMachine's failed window expires. Drives the canonical
   * `failed` pet state.
   */
  failedSince: number | null;
  /**
   * Idempotency + refinement tracking. Locked by
   * `state.dispatcher.test.ts`.
   *
   * Codex's notification stream and `thread/resume`'s snapshot response
   * can deliver the same logical event twice. Two cases:
   *
   *   1. EXACT duplicates (e.g. live `turn/completed` arrives, then we
   *      replay a snapshot containing the same completed turn). Drop
   *      the second occurrence — `seenTurns` / `completedTurns` /
   *      itemStatus dedup handles this.
   *
   *   2. SNAPSHOT → LIVE refinement: when our daemon subscribes to a
   *      thread mid-turn, the resume snapshot returns in-flight items
   *      with their *partial* state at snapshot time. The synthesizer
   *      dispatches `item/completed` for them (tagged as "snapshot").
   *      The live tail later delivers the SAME item's `item/completed`
   *      with its FINAL payload (e.g. webSearch.query went from empty
   *      to populated). This second event is a refinement, not a
   *      duplicate — we re-emit downstream so consumers see the final
   *      payload, but we don't re-fire side-effect counters.
   *
   * `itemStatus` therefore tracks not only the phase but also the
   * source for completed items. The transition table is enforced in
   * `onItemCompleted` and locked by `state.dispatcher.test.ts`.
   *
   * `seenTurns` is the union of in-progress and completed turn IDs.
   * `completedTurns` ⊆ `seenTurns`. Sizes stay bounded (~10s of items
   * per turn × ~10s of turns per long-lived thread → <1k entries;
   * negligible memory).
   */
  seenTurns: Set<string>;
  completedTurns: Set<string>;
  itemStatus: Map<string, ItemStatus>;
  /** Running counters for this thread. */
  stats: ConvStats;
}

/**
 * Pass the full server item through to listeners — the wsServer needs
 * `command`/`cwd`/`exitCode` etc. that we previously discarded.
 */
export interface StateModelEvents {
  thread_added: (c: ConversationState) => void;
  thread_updated: (c: ConversationState) => void;
  thread_removed: (threadId: string) => void;
  thread_compacted: (threadId: string) => void;
  active_changed: (threadId: string | null) => void;
  approval_added: (threadId: string, approval: PendingApproval) => void;
  approval_resolved: (threadId: string, requestId: RequestId) => void;
  turn_started: (threadId: string, turnId: string) => void;
  turn_completed: (threadId: string, turnId: string, ok: boolean, durationMs: number) => void;
  item_started: (threadId: string, turnId: string, item: ItemPayload) => void;
  item_completed: (threadId: string, turnId: string, item: ItemPayload) => void;
  agent_text_delta: (threadId: string, turnId: string, itemId: string, delta: string) => void;
  command_output_delta: (threadId: string, turnId: string, itemId: string, delta: string) => void;
  file_change_patch_updated: (threadId: string, turnId: string, itemId: string, changes: unknown) => void;
  error: (threadId: string | null, error: ErrorNotificationParams) => void;
}

export type ItemPayload =
  | (CommandExecutionItem & { type: "commandExecution" })
  | (AgentMessageItem & { type: "agentMessage" })
  | (UserMessageItem & { type: "userMessage" })
  | { id: string; type: string; [k: string]: unknown };

export declare interface StateModel {
  on<E extends keyof StateModelEvents>(ev: E, cb: StateModelEvents[E]): this;
  off<E extends keyof StateModelEvents>(ev: E, cb: StateModelEvents[E]): this;
  emit<E extends keyof StateModelEvents>(ev: E, ...args: Parameters<StateModelEvents[E]>): boolean;
}

/**
 * How long after `turn_completed` (ok=true) we keep `conv.unreadSince`
 * set before auto-clearing. Picked to be visible at a glance on an
 * ambient device but bounded so the pet doesn't get stuck in `review`
 * forever — Codex.app clears its review state on focus / navigation
 * events that don't cross the WebSocket protocol, so the daemon
 * approximates with a timer. Override via
 * `PLAIPIN_UNREAD_AUTO_CLEAR_MS` env if you need to retune for a
 * different device class.
 */
export const UNREAD_AUTO_CLEAR_MS: number = (() => {
  const raw = process.env.PLAIPIN_UNREAD_AUTO_CLEAR_MS;
  if (!raw) return 8_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 8_000;
})();

export class StateModel extends EventEmitter {
  private conversations = new Map<string, ConversationState>();
  /** Active thread shown by default on ESP32. Pinned overrides activity. */
  private activeThreadId: string | null = null;
  private pinnedThreadId: string | null = null;
  /** Wall-clock when this StateModel was constructed; powers GlobalStats.uptimeMs. */
  private readonly daemonStartedAt = Date.now();
  /**
   * Last-known patch snapshot per (threadId, itemId). `item/fileChange/patchUpdated`
   * fires repeatedly for the same item as the agent revises its proposed
   * change set; each notification carries the FULL latest changes array.
   * To avoid double-counting, we delta against the previous snapshot:
   * `conv.stats.loc.added += next.added - prev.added`. Same for removed
   * lines and distinct file paths.
   */
  private patchByItem = new Map<string, PatchSnapshot>();
  /**
   * Fix #4: when many threads emit notifications concurrently, every notify
   * touches state → recomputeActive flips to whichever thread emitted last.
   * Result: active flips ~10×/sec under parallel ultrareview-style sessions.
   * Coalesce recomputes inside a short window and only emit if the winner
   * is actually different from what we last published.
   */
  private activeRecomputeTimer: NodeJS.Timeout | null = null;
  private static readonly ACTIVE_DEBOUNCE_MS = 250;

  /** Non-ephemeral conversations, most-recently-active first. */
  list(): ConversationState[] {
    return Array.from(this.conversations.values())
      .filter((c) => !c.ephemeral)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** All conversations including ephemeral ones (debug / internal use). */
  listAll(): ConversationState[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    );
  }

  get(threadId: string): ConversationState | undefined {
    return this.conversations.get(threadId);
  }

  getActive(): ConversationState | null {
    const id = this.pinnedThreadId ?? this.activeThreadId;
    return id ? (this.conversations.get(id) ?? null) : null;
  }

  pin(threadId: string | null): void {
    this.pinnedThreadId = threadId;
    this.recomputeActive();
  }

  /** Force a snapshot recovery from `thread/list` results. */
  hydrateFromList(threads: Array<{ id: string; preview?: string; updatedAt: number }>): void {
    const now = Date.now();
    for (const t of threads) {
      if (this.conversations.has(t.id)) continue;
      this.conversations.set(t.id, this.makeBlank(t.id, t.preview ?? null, t.updatedAt * 1000 || now));
    }
    this.recomputeActive();
  }

  // ====================================================================
  // Notification handlers — call from your RPC notification dispatcher
  // ====================================================================

  onThreadStarted(p: ThreadStartedParams): void {
    // Use p.thread.id (not p.threadId, which doesn't exist on this
    // notification). upsert() emits thread_added SYNCHRONOUSLY, so we
    // need the full thread payload (ephemeral, name, …) applied BEFORE
    // the event fires — otherwise listeners (notably the daemon's
    // resumeThread auto-subscribe) see ephemeral=false on
    // genuinely-ephemeral threads and try to subscribe to them. Inline
    // the create path here.
    const id = p.thread?.id;
    if (!id) return;
    let conv = this.conversations.get(id);
    if (!conv) {
      conv = this.makeBlank(id, p.thread.name ?? null, Date.now());
      conv.ephemeral = p.thread.ephemeral === true;
      this.conversations.set(id, conv);
      this.emit("thread_added", conv);
    } else {
      // Existing conv (race: thread/status/changed arrived first). Update
      // the fields the thread/started payload definitively settles.
      if (p.thread.name) conv.name = p.thread.name;
      if (p.thread.ephemeral === true) conv.ephemeral = true;
    }
    this.touch(conv);
  }

  onThreadCompacted(threadId: string): void {
    const conv = this.upsert(threadId);
    conv.lastCompactedAt = Date.now();
    this.touch(conv);
    this.emit("thread_compacted", threadId);
  }

  onThreadStatusChanged(p: ThreadStatusChangedParams): void {
    const conv = this.upsert(p.threadId);
    // Server may send either { type, activeFlags? } (current) or a bare
    // string (older). Normalise to the type tag.
    const tag = typeof p.status === "string" ? p.status : p.status.type;
    const flags =
      typeof p.status === "object" && p.status.type === "active"
        ? (p.status as { activeFlags?: string[] }).activeFlags ?? []
        : [];
    conv.status = mapServerStatus(tag, flags, conv);
    this.touch(conv);
  }

  onThreadNameUpdated(p: ThreadNameUpdatedParams): void {
    const conv = this.upsert(p.threadId);
    conv.name = p.threadName;
    this.touch(conv);
  }

  onThreadClosed(threadId: string): void {
    if (this.conversations.delete(threadId)) {
      this.emit("thread_removed", threadId);
      if (this.activeThreadId === threadId) this.activeThreadId = null;
      if (this.pinnedThreadId === threadId) this.pinnedThreadId = null;
      this.recomputeActive();
    }
  }

  onTurnStarted(p: TurnStartedParams): void {
    const conv = this.upsert(p.threadId);
    // Idempotency: same turn/started arriving twice (live + snapshot replay)
    // is a no-op. See ConversationState.seenTurns docstring.
    if (conv.seenTurns.has(p.turn.id)) return;
    conv.seenTurns.add(p.turn.id);
    conv.activeTurn = {
      turnId: p.turn.id,
      startedAt: Date.now(),
      hasAgentMessage: false,
      hasCommandRunning: false,
      status: p.turn.status,
      error: null,
    };
    conv.status = "thinking";
    conv.stats.turnsStarted++;
    // New turn supersedes any pending "you should read this" or "an error
    // happened" sticky from the previous turn (matches Codex.app's
    // selector, which also clears these on a new turn).
    conv.unreadSince = null;
    conv.failedSince = null;
    this.markLive(conv);
    this.emit("turn_started", p.threadId, p.turn.id);
  }

  onTurnCompleted(p: TurnCompletedParams): void {
    const conv = this.upsert(p.threadId);
    // Idempotency: turn already completed → drop. (`completedTurns` is a
    // monotonic flip; once set, stays set for the conversation's lifetime.)
    if (conv.completedTurns.has(p.turn.id)) return;
    conv.completedTurns.add(p.turn.id);
    conv.seenTurns.add(p.turn.id); // safety: completed implies seen
    let durationMs = 0;
    let ok = true;
    if (conv.activeTurn?.turnId === p.turn.id) {
      durationMs = Date.now() - conv.activeTurn.startedAt;
      conv.lastCompletedTurn = {
        turnId: p.turn.id,
        status: p.turn.status,
        at: Date.now(),
      };
      conv.activeTurn = null;
      ok = !(p.turn.status === "errored" || p.turn.error);
      conv.status = ok ? "idle" : "errored";
    } else {
      // Snapshot replay path: we never saw the in-flight turn (so
      // `activeTurn` is unset for it), but the snapshot tells us its
      // final status directly.
      ok = !(p.turn.status === "errored" || p.turn.error);
    }
    if (ok) {
      conv.stats.turnsCompleted++;
      // Auto-clear `unreadSince` on a short timer.
      //
      // Codex.app clears its review state aggressively on focus /
      // navigation, but those signals are client-local — they never
      // cross the WebSocket protocol, so the daemon (as a peer
      // subscriber to the codex app-server) has no observable pathway
      // to learn the user has "read" a thread. Without compensating
      // logic, the pet would stay in `review` permanently after every
      // `turn_completed`. The timer-based auto-clear is a mechanical
      // divergence from Codex.app but a faithful approximation of its
      // user-visible shape. Default 8s = "long enough to glance, short
      // enough not to stick."
      //
      // TODO: also gate this assignment on
      // `lastAgentMessage.decision !== 'DONT_NOTIFY'` so short / silent
      // agent responses (which carry DONT_NOTIFY) don't trigger review.
      // Requires plumbing the agent message decision through state.ts;
      // currently we don't track it.
      const unreadAt = Date.now();
      conv.unreadSince = unreadAt;
      // Capture `unreadAt` and `conv` in the closure so the firing timer
      // can detect whether a fresher `turn_completed` overwrote
      // `unreadSince` in the meantime. If so, we do nothing — the
      // newer timer will handle the clearing on its own schedule.
      // `.unref()` so a pending timer doesn't keep the daemon alive at
      // shutdown.
      const timer = setTimeout(() => {
        if (conv.unreadSince !== unreadAt) return; // newer turn replaced us
        conv.unreadSince = null;
        // Re-emit `thread_updated` so wsServer's listener calls
        // pet.evaluate() and broadcasts a fresh `pet_state` if the
        // global aggregate now changed (typically review→idle, but
        // could remain review if another thread still has unread).
        // We deliberately do NOT call markLive/touch here — clearing
        // unreadSince is NOT user activity, and we don't want to
        // affect lastActivityAt / active-thread selection.
        this.emit("thread_updated", conv);
      }, UNREAD_AUTO_CLEAR_MS);
      timer.unref();
    } else {
      conv.stats.turnsErrored++;
      // Note: `failedSince` is intentionally NOT auto-cleared.
      // Errors warrant more persistence than unread output. Codex's own
      // notification expiry asymmetry (1 hour for failed vs. 7 days for
      // review) suggests the same intuition. Revisit if the sticky
      // failed state causes UX problems.
      conv.failedSince = Date.now();
    }
    this.markLive(conv);
    this.emit("turn_completed", p.threadId, p.turn.id, ok, durationMs);
  }

  onItemStarted(p: ItemStartedParams): void {
    const conv = this.upsert(p.threadId);
    // Idempotency: item we already saw → drop. Note `started` and
    // `completed` are both "seen" states; if we already have either, drop.
    // We don't track a started-source distinction because `item/started`
    // doesn't carry payload that gets refined later (started fields are
    // immutable once the item exists).
    if (conv.itemStatus.has(p.item.id)) return;
    conv.itemStatus.set(p.item.id, { phase: "started" });
    if (conv.activeTurn?.turnId === p.turnId) {
      if (p.item.type === "commandExecution") conv.activeTurn.hasCommandRunning = true;
      if (p.item.type === "agentMessage") conv.activeTurn.hasAgentMessage = true;
    }
    if (p.item.type === "commandExecution") {
      conv.status = "running_command";
      conv.stats.commandsStarted++;
    }
    this.markLive(conv);
    // Pass the FULL item — wsServer needs command/cwd, not just id/type.
    this.emit("item_started", p.threadId, p.turnId, p.item as ItemPayload);
  }

  /**
   * Handle snapshot → live refinement.
   *
   * `thread/resume` returns ALL items in the thread, including items
   * in flight at snapshot time with partial payloads (e.g.
   * webSearch.query empty until the search completes). The live tail
   * delivers the FINAL payload as a second `item/completed` for the
   * same id, so `item/completed` may fire 1-2 times per item id
   * within a single subscription. The dispatcher tracks the source
   * on the first emission; a snapshot → live transition is a
   * refinement that re-emits with the authoritative payload but does
   * NOT re-fire side effects (counters, etc.).
   *
   * Transition table:
   *   undefined / started               + (any source)  → mark, emit, fire side effects
   *   completed:snapshot                + live          → upgrade, RE-EMIT, do not re-fire
   *   completed:snapshot                + snapshot      → drop (paranoid duplicate)
   *   completed:live                    + (any source)  → drop (already authoritative)
   *
   * Locked by `state.dispatcher.test.ts`.
   *
   * @param fromReplay  true when called from `synthesizeFromResume` for
   *                    items inside an ACTIVE turn (parent turn status
   *                    is not terminal). Items in terminal turns are
   *                    fully populated in the snapshot, so synthesis
   *                    dispatches them as live (fromReplay=false).
   */
  onItemCompleted(p: ItemCompletedParams, fromReplay = false): void {
    const conv = this.upsert(p.threadId);
    const prior = conv.itemStatus.get(p.item.id);
    const source: "snapshot" | "live" = fromReplay ? "snapshot" : "live";

    // Already authoritative — drop (idempotent + protects against
    // duplicate live events too).
    if (prior?.phase === "completed" && prior.source === "live") return;

    // Snapshot → snapshot: should be impossible (resumeThread is
    // idempotent; synthesizeFromResume only runs once per resume), but
    // drop defensively.
    if (
      prior?.phase === "completed" &&
      prior.source === "snapshot" &&
      source === "snapshot"
    ) {
      return;
    }

    const isRefinement =
      prior?.phase === "completed" && prior.source === "snapshot" && source === "live";

    conv.itemStatus.set(p.item.id, { phase: "completed", source });

    if (!isRefinement) {
      // First transition to completed — fire side effects exactly once.
      if (conv.activeTurn?.turnId === p.turnId) {
        if (p.item.type === "commandExecution") conv.activeTurn.hasCommandRunning = false;
      }
      if (p.item.type === "commandExecution") conv.stats.commandsCompleted++;
      this.markLive(conv);
    }

    // Always emit — refinement re-emits with the authoritative payload
    // so downstream consumers see the final state. The wsServer's
    // `item_completed` listener naturally re-broadcasts; firmware /
    // tail consumers handle the second emission as the latest
    // authoritative version of `tool_done` / `command_done` /
    // `agent_text_done` / `file_changed` for this itemId.
    this.emit("item_completed", p.threadId, p.turnId, p.item as ItemPayload);
  }

  onAgentMessageDelta(p: AgentMessageDeltaParams): void {
    const conv = this.upsert(p.threadId);
    // Delta dedup: if the parent item is already marked completed (from
    // a snapshot replay of a finished turn, or from a prior live event),
    // drop this delta — its content is already represented in
    // item/completed's full text. itemStatus tracks phase as a
    // discriminant; check the phase, not the raw string.
    if (conv.itemStatus.get(p.itemId)?.phase === "completed") return;
    if (conv.activeTurn?.turnId === p.turnId) conv.activeTurn.hasAgentMessage = true;
    conv.status = "streaming";
    this.markLive(conv);
    this.emit("agent_text_delta", p.threadId, p.turnId, p.itemId, p.delta);
  }

  onCommandExecutionOutputDelta(p: CommandExecutionOutputDeltaParams): void {
    const conv = this.upsert(p.threadId);
    // Same delta-dedup rule as agent text. See onAgentMessageDelta.
    if (conv.itemStatus.get(p.itemId)?.phase === "completed") return;
    this.markLive(conv);
    this.emit("command_output_delta", p.threadId, p.turnId, p.itemId, p.delta);
  }

  onFileChangePatchUpdated(p: FileChangePatchUpdatedParams): void {
    const conv = this.upsert(p.threadId);
    // patchUpdated re-emits the full patch each time; delta against the
    // previous snapshot for this (thread, item) so we don't double-count.
    const next = summarisePatch(p.changes);
    const key = `${p.threadId}|${p.itemId}`;
    const prev = this.patchByItem.get(key) ?? { added: 0, removed: 0, files: 0 };
    conv.stats.loc.added += next.added - prev.added;
    conv.stats.loc.removed += next.removed - prev.removed;
    conv.stats.filesChanged += next.files - prev.files;
    this.patchByItem.set(key, next);
    this.markLive(conv);
    this.emit("file_change_patch_updated", p.threadId, p.turnId, p.itemId, p.changes);
  }

  onTokenUsageUpdated(p: ThreadTokenUsageUpdatedParams): void {
    const conv = this.upsert(p.threadId);
    const total = p.tokenUsage?.total;
    if (!total) return;
    // Server publishes running totals — overwrite, not increment.
    conv.stats.tokens.inputTokens = total.inputTokens ?? conv.stats.tokens.inputTokens;
    conv.stats.tokens.outputTokens = total.outputTokens ?? conv.stats.tokens.outputTokens;
    conv.stats.tokens.cachedInputTokens =
      total.cachedInputTokens ?? conv.stats.tokens.cachedInputTokens;
    conv.stats.tokens.reasoningOutputTokens =
      total.reasoningOutputTokens ?? conv.stats.tokens.reasoningOutputTokens;
    conv.tokenUsage = {
      prompt: total.inputTokens,
      completion: total.outputTokens,
    };
    this.touch(conv);
  }

  onError(p: ErrorNotificationParams): void {
    if (p.threadId) {
      const conv = this.upsert(p.threadId);
      conv.status = "errored";
      this.touch(conv);
    }
    this.emit("error", p.threadId ?? null, p);
  }

  /** A server-initiated approval request was received. */
  onApprovalRequest(threadId: string, requestId: RequestId, method: string, params: unknown): void {
    const conv = this.upsert(threadId);
    const approval: PendingApproval = { requestId, method, params, receivedAt: Date.now() };
    conv.pendingApprovals.set(requestId, approval);
    conv.status = "awaiting_user";
    conv.stats.approvalsReceived++;
    this.markLive(conv);
    this.emit("approval_added", threadId, approval);
  }

  onServerRequestResolved(p: ServerRequestResolvedParams): void {
    const conv = this.conversations.get(p.threadId);
    if (!conv) return;
    if (conv.pendingApprovals.delete(p.requestId)) {
      conv.stats.approvalsResolved++;
      if (conv.pendingApprovals.size === 0 && conv.status === "awaiting_user") {
        conv.status = conv.activeTurn ? "thinking" : "idle";
      }
      this.markLive(conv);
      this.emit("approval_resolved", p.threadId, p.requestId);
    }
  }

  // ====================================================================
  // Private
  // ====================================================================

  private upsert(threadId: string): ConversationState {
    let conv = this.conversations.get(threadId);
    if (!conv) {
      conv = this.makeBlank(threadId, null, Date.now());
      this.conversations.set(threadId, conv);
      this.emit("thread_added", conv);
    }
    return conv;
  }

  private makeBlank(threadId: string, name: string | null, createdAt: number): ConversationState {
    return {
      threadId,
      name,
      status: "idle",
      activeTurn: null,
      pendingApprovals: new Map(),
      lastActivityAt: createdAt,
      lastLiveActivityAt: null,
      lastFocusedAt: null,
      lastCompletedTurn: null,
      tokenUsage: null,
      ephemeral: false,
      lastCompactedAt: null,
      unreadSince: null,
      failedSince: null,
      seenTurns: new Set(),
      completedTurns: new Set(),
      itemStatus: new Map(),
      stats: makeBlankStats(),
    };
  }

  /**
   * Aggregate counters across every (non-ephemeral) thread the daemon has
   * observed since startup. Tokens are summed from each thread's last
   * known running total — accurate because the server publishes totals,
   * not deltas. `daemonStartedAt` + `uptimeMs` let the firmware show
   * "since X minutes ago".
   */
  getGlobalStats(): GlobalStats {
    const now = Date.now();
    const acc: GlobalStats = {
      threadsTotal: 0,
      threadsEphemeral: 0,
      tokens: blankTokenStats(),
      turnsStarted: 0,
      turnsCompleted: 0,
      turnsErrored: 0,
      commandsStarted: 0,
      commandsCompleted: 0,
      filesChanged: 0,
      loc: { added: 0, removed: 0 },
      approvalsReceived: 0,
      approvalsResolved: 0,
      daemonStartedAt: this.daemonStartedAt,
      uptimeMs: now - this.daemonStartedAt,
    };
    for (const c of this.conversations.values()) {
      if (c.ephemeral) {
        acc.threadsEphemeral++;
        continue; // ephemeral threads are system-internal; exclude from user-facing stats
      }
      acc.threadsTotal++;
      acc.tokens.inputTokens += c.stats.tokens.inputTokens;
      acc.tokens.outputTokens += c.stats.tokens.outputTokens;
      acc.tokens.cachedInputTokens += c.stats.tokens.cachedInputTokens;
      acc.tokens.reasoningOutputTokens += c.stats.tokens.reasoningOutputTokens;
      acc.turnsStarted += c.stats.turnsStarted;
      acc.turnsCompleted += c.stats.turnsCompleted;
      acc.turnsErrored += c.stats.turnsErrored;
      acc.commandsStarted += c.stats.commandsStarted;
      acc.commandsCompleted += c.stats.commandsCompleted;
      acc.filesChanged += c.stats.filesChanged;
      acc.loc.added += c.stats.loc.added;
      acc.loc.removed += c.stats.loc.removed;
      acc.approvalsReceived += c.stats.approvalsReceived;
      acc.approvalsResolved += c.stats.approvalsResolved;
    }
    return acc;
  }

  private touch(conv: ConversationState): void {
    conv.lastActivityAt = Date.now();
    this.recomputeActive();
    this.emit("thread_updated", conv);
  }

  /**
   * Strong signal that the user is actively engaging with this thread —
   * they sent a prompt, the agent is responding, a command is running, an
   * approval is pending. Updates `lastLiveActivityAt` (which `touch` does
   * NOT) so `recomputeActive` will consider this thread for the "active"
   * slot. Also bumps `lastActivityAt` for sort-order purposes.
   *
   * Background events (auto-naming, status flips on idle threads, token
   * usage refreshes) deliberately call `touch` and not `markLive`, so
   * disk-hydrated threads don't claim active without real user activity
   * since this daemon process started.
   */
  private markLive(conv: ConversationState): void {
    const now = Date.now();
    conv.lastActivityAt = now;
    conv.lastLiveActivityAt = now;
    this.recomputeActive();
    this.emit("thread_updated", conv);
  }

  private recomputeActive(): void {
    // Pinned wins immediately (user explicitly asked for this thread).
    if (this.pinnedThreadId) {
      if (this.pinnedThreadId !== this.activeThreadId) {
        this.activeThreadId = this.pinnedThreadId;
        this.emit("active_changed", this.activeThreadId);
      }
      return;
    }
    if (this.activeRecomputeTimer) return; // already scheduled
    this.activeRecomputeTimer = setTimeout(() => {
      this.activeRecomputeTimer = null;
      // Only consider threads that have had real live activity in this
      // daemon process. Disk-hydrated threads (lastLiveActivityAt === null)
      // are excluded — otherwise after a daemon restart we'd elect whichever
      // thread was most recently mutated to disk as "active", regardless of
      // which thread the user actually has open in Codex.app.
      const sorted = Array.from(this.conversations.values())
        .filter((c) => !c.ephemeral && c.lastLiveActivityAt !== null)
        .sort((a, b) => (b.lastLiveActivityAt ?? 0) - (a.lastLiveActivityAt ?? 0));
      const newActive = sorted[0]?.threadId ?? null;
      if (newActive !== this.activeThreadId) {
        this.activeThreadId = newActive;
        this.emit("active_changed", newActive);
      }
    }, StateModel.ACTIVE_DEBOUNCE_MS);
    // .unref() intentionally NOT called: in tests we want this to keep the
    // event loop alive long enough to drain. Timer is short-lived anyway.
  }

  getActiveId(): string | null {
    return this.pinnedThreadId ?? this.activeThreadId;
  }
}

function blankTokenStats(): TokenStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function makeBlankStats(): ConvStats {
  return {
    tokens: blankTokenStats(),
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsErrored: 0,
    commandsStarted: 0,
    commandsCompleted: 0,
    filesChanged: 0,
    loc: { added: 0, removed: 0 },
    approvalsReceived: 0,
    approvalsResolved: 0,
  };
}

/**
 * Reduce a `FileUpdateChange[]` patch (the full latest set the agent
 * intends to apply) to a snapshot of `{ added, removed, files }`.
 *
 * Unified-diff parsing:
 *   - Lines starting with `+` count as added; `-` as removed.
 *   - Skip `+++` / `---` headers (they're file-name lines, not content).
 *   - Skip everything else (` `, `@@`, `\`, blank lines).
 *
 * `files` is the count of distinct `path` values across the changes,
 * since one `patchUpdated` can carry multiple files.
 *
 * Tolerant to malformed input — a non-array `changes`, missing `diff`,
 * or non-string `path` all degrade silently to zero.
 */
function summarisePatch(changes: unknown): PatchSnapshot {
  if (!Array.isArray(changes)) return { added: 0, removed: 0, files: 0 };
  let added = 0;
  let removed = 0;
  const paths = new Set<string>();
  for (const c of changes as FileUpdateChange[]) {
    if (typeof c?.path === "string") paths.add(c.path);
    if (typeof c?.diff !== "string") continue;
    for (const line of c.diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.charCodeAt(0) === 43 /* + */) added++;
      else if (line.charCodeAt(0) === 45 /* - */) removed++;
    }
  }
  return { added, removed, files: paths.size };
}

function mapServerStatus(
  serverStatusTag: string,
  activeFlags: string[],
  conv: ConversationState,
): ThreadStatus {
  // Per the schema, activeFlags is enum {waitingOnApproval, waitingOnUserInput}.
  // Either means the agent is paused waiting for the user.
  if (activeFlags.includes("waitingOnApproval") || activeFlags.includes("waitingOnUserInput")) {
    return "awaiting_user";
  }
  switch (serverStatusTag) {
    case "active":
      // No specific waitingOn flag → agent is doing work. Pick a finer label
      // from what the StateModel saw arrive: command in flight > agent
      // streaming text > otherwise just "thinking".
      if (conv.activeTurn?.hasCommandRunning) return "running_command";
      if (conv.activeTurn?.hasAgentMessage) return "streaming";
      return "thinking";
    case "running":
    case "streaming":
      return "streaming";
    case "thinking":
      return "thinking";
    case "errored":
    case "error":
      return "errored";
    case "completed":
    case "idle":
      return conv.pendingApprovals.size > 0 ? "awaiting_user" : "idle";
    default:
      return conv.status;
  }
}
