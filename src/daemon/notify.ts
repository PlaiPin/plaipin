// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Routes a JSON-RPC notification or server-initiated request into the
// per-thread StateModel. Used by the internal client (real Codex traffic)
// and by the synthetic event injector (`plaipin demo`).

import pino from "pino";
import { shortJson } from "../shared/util.js";
import type { StateModel } from "./state.js";
import type { RpcRequest, RequestId } from "../shared/rpc.js";
import {
  isApprovalRequestMethod,
  type AgentMessageDeltaParams,
  type CommandExecutionOutputDeltaParams,
  type ErrorNotificationParams,
  type FileChangePatchUpdatedParams,
  type ItemCompletedParams,
  type ItemStartedParams,
  type ServerRequestResolvedParams,
  type ThreadNameUpdatedParams,
  type ThreadStartedParams,
  type ThreadStatusChangedParams,
  type ThreadTokenUsageUpdatedParams,
  type TurnCompletedParams,
  type TurnStartedParams,
} from "../shared/protocol.js";

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

/**
 * Notification methods that fire constantly and aren't useful at info-level
 * once we've confirmed the wire is working. Logged at debug only.
 */
const NOISY_NOTIFICATION_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "app/list/updated",
  "mcpServer/startupStatus/updated",
  "account/rateLimits/updated",
  "thread/tokenUsage/updated",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  // Server fires one skills/changed per thread/resume — with N hydrated
  // threads our startup produces N consecutive skills/changed broadcasts.
  // The payload is `{}`; informational only.
  "skills/changed",
]);

export function makeNotificationDispatcher(state: StateModel) {
  return function handleNotification(method: string, params: unknown): void {
    if (NOISY_NOTIFICATION_METHODS.has(method)) {
      log.debug({ method, params: shortJson(params, 120) }, "← notification (noisy)");
    } else {
      log.info({ method, params: shortJson(params, 120) }, "← notification");
    }
    switch (method) {
      case "thread/started":
        state.onThreadStarted(params as ThreadStartedParams);
        break;
      case "thread/status/changed":
        state.onThreadStatusChanged(params as ThreadStatusChangedParams);
        break;
      case "thread/name/updated":
        state.onThreadNameUpdated(params as ThreadNameUpdatedParams);
        break;
      case "thread/closed":
        state.onThreadClosed((params as { threadId: string }).threadId);
        break;
      case "thread/compacted":
        state.onThreadCompacted((params as { threadId: string }).threadId);
        break;
      case "thread/tokenUsage/updated":
        state.onTokenUsageUpdated(params as ThreadTokenUsageUpdatedParams);
        break;
      case "turn/started":
        state.onTurnStarted(params as TurnStartedParams);
        break;
      case "turn/completed":
        state.onTurnCompleted(params as TurnCompletedParams);
        break;
      case "item/started":
        state.onItemStarted(params as ItemStartedParams);
        break;
      case "item/completed":
        // Live event — authoritative.
        state.onItemCompleted(params as ItemCompletedParams, /*fromReplay=*/ false);
        break;
      case "item/completed:replay":
        // Synthesized from `synthesizeFromResume.ts` for items inside
        // an active turn — payload is tentative, may be refined by a
        // later live `item/completed` for the same id.
        state.onItemCompleted(params as ItemCompletedParams, /*fromReplay=*/ true);
        break;
      case "item/agentMessage/delta":
        state.onAgentMessageDelta(params as AgentMessageDeltaParams);
        break;
      case "item/commandExecution/outputDelta":
        state.onCommandExecutionOutputDelta(params as CommandExecutionOutputDeltaParams);
        break;
      case "item/fileChange/patchUpdated":
        state.onFileChangePatchUpdated(params as FileChangePatchUpdatedParams);
        break;
      case "serverRequest/resolved":
        state.onServerRequestResolved(params as ServerRequestResolvedParams);
        break;
      case "error":
        state.onError(params as ErrorNotificationParams);
        break;
      case "warning":
      case "remoteControl/status/changed":
      case "account/rateLimits/updated":
        log.debug({ method, params: shortJson(params, 200) }, "informational notification");
        break;
      default:
        log.debug({ method, params: shortJson(params, 200) }, "unhandled notification");
    }
  };
}

export function makeServerRequestDispatcher(state: StateModel) {
  return function handleServerRequest(req: RpcRequest): void {
    const { method, id, params } = req;
    if (isApprovalRequestMethod(method)) {
      const tid = (params as { threadId?: string }).threadId;
      if (!tid) {
        log.warn({ method, id }, "approval request missing threadId; ignoring");
        return;
      }
      state.onApprovalRequest(tid, id, method, params);
      return;
    }
    log.debug({ method, id, params: shortJson(params, 200) }, "unhandled server request (observe-only)");
  };
}

/** Convenience for the test injector: route either kind by tag. */
export function makeTestInjector(state: StateModel) {
  const notify = makeNotificationDispatcher(state);
  const request = makeServerRequestDispatcher(state);
  return function inject(payload: {
    kind: "notification" | "request";
    method: string;
    params: unknown;
    id?: RequestId;
  }): void {
    if (payload.kind === "notification") {
      notify(payload.method, payload.params);
    } else {
      const id = payload.id ?? Date.now();
      request({ method: payload.method, id, params: payload.params });
    }
  };
}
