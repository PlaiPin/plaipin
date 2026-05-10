// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Curated subset of the codex app-server v2 protocol that plaipin consumes.
// Authoritative source: `<bundled-codex> app-server generate-ts -o DIR`.
// The full surface is ~75 ClientRequests, 9 ServerRequests, ~65 ServerNotifications;
// we model only what we forward to ESP32 and ignore the rest gracefully.

import type { RequestId } from "./rpc.js";

// =====================================================================
// Initialize
// =====================================================================

export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}

/**
 * Documented at https://developers.openai.com/codex/app-server (the
 * subscription model + capabilities section).
 *
 * - `optOutNotificationMethods`: ask the server to stop sending the listed
 *   notification methods to this client. Cleaner than filtering locally —
 *   spares serialization + WS bytes for the entire daemon lifetime.
 * - `experimentalApi`: opt in to methods the server marks as experimental.
 *   No effect for methods we already use; keeps the door open for future
 *   features (e.g. stats endpoints, alternative subscription models).
 *
 * Unrecognized keys are ignored by the server, so adding new optional
 * capabilities here is safe.
 */
export interface InitializeCapabilities {
  optOutNotificationMethods?: string[];
  experimentalApi?: boolean;
  [k: string]: unknown;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: InitializeCapabilities;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/**
 * Methods we ask the server to NOT send via `optOutNotificationMethods`.
 * Curated to drop strictly noise — every entry below is a method we have
 * no display surface for, no derived event for, and would otherwise just
 * filter at log-level.
 *
 * Notably NOT in this list (by design):
 *   - `thread/tokenUsage/updated` — feeds stats tracking
 *   - `item/agentMessage/delta` — drives streaming text
 *   - `item/commandExecution/outputDelta` — opt-in via ESP32 filters
 *   - `account/rateLimits/updated` — useful for future "rate limit"
 *     pet mood; kept for now
 *
 * Defense-in-depth: notify.ts still has these in NOISY_NOTIFICATION_METHODS
 * so older servers that ignore the opt-out continue to behave well.
 */
export const OPT_OUT_NOTIFICATION_METHODS = [
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "app/list/updated",
  "mcpServer/startupStatus/updated",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "skills/changed",
] as const;

// =====================================================================
// ServerNotifications we observe and translate to ESP32 events
// =====================================================================

/** All notification methods we explicitly handle. Anything else is logged. */
export const HANDLED_NOTIFICATION_METHODS = [
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/name/updated",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/patchUpdated",
  "item/fileChange/outputDelta",
  "serverRequest/resolved",
  "remoteControl/status/changed",
  "account/rateLimits/updated",
  "error",
  "warning",
] as const;

export type HandledNotification = (typeof HANDLED_NOTIFICATION_METHODS)[number];

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput" | string;

/** thread/started carries only `thread` (no top-level threadId). */
export interface ThreadStartedParams {
  thread: {
    id: string;
    name?: string | null;
    /**
     * `true` for system-internal threads Codex spawns for things like
     * auto-naming, compaction, and other background inference. They
     * should not surface on the ESP32 — naming roundtrips look like
     * mysterious thinking→idle pulses to a casual viewer.
     */
    ephemeral?: boolean;
    [k: string]: unknown;
  };
}

/**
 * Concrete shape of CommandExecutionThreadItem inside item/started + completed
 * notifications. Mirrors the schema from `<codex> app-server generate-json-schema`.
 */
export interface CommandExecutionItem {
  id: string;
  type: "commandExecution";
  command: string;
  cwd: string;
  status: { type: string; [k: string]: unknown } | string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  processId?: string | null;
  source?: string;
  commandActions?: unknown[];
}

export interface AgentMessageItem {
  id: string;
  type: "agentMessage";
  text: string;
  phase?: string | null;
}

export interface UserMessageItem {
  id: string;
  type: "userMessage";
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
}

/**
 * Codex's thread status comes through as a tagged object, not a bare string.
 * Observed values:
 *   { "type": "idle" }
 *   { "type": "active", "activeFlags": [...] }
 * Older docs implied a string; the bundled 0.128.0-alpha.1 always sends an
 * object. We accept either form for forward/backward compat.
 */
export type ThreadStatusValue =
  | { type: "idle" }
  | { type: "active"; activeFlags?: string[] }
  | { type: "errored"; error?: unknown }
  | { type: string; [k: string]: unknown };

export interface ThreadStatusChangedParams {
  threadId: string;
  status: ThreadStatusValue | string;
}

/**
 * thread/name/updated uses `threadName`, not `name`.
 */
export interface ThreadNameUpdatedParams {
  threadId: string;
  threadName: string;
}

export interface TurnStartedParams {
  threadId: string;
  turn: { id: string; status: string; [k: string]: unknown };
}

export interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string; error?: unknown; [k: string]: unknown };
}

export interface ItemStartedParams {
  threadId: string;
  turnId: string;
  item: { id: string; type: string; [k: string]: unknown };
}

export interface ItemCompletedParams {
  threadId: string;
  turnId: string;
  item: { id: string; type: string; [k: string]: unknown };
}

export interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CommandExecutionOutputDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * Per-file entry in `item/fileChange/patchUpdated.changes`. Mirrors the
 * codex app-server's `FileUpdateChange` shape.
 *
 * `diff` is a unified diff string. We count `+` / `-` lines (skipping
 * `+++` / `---` headers) for LOC stats. `kind` is the v2 PatchChangeKind
 * enum — passed through verbatim, we don't currently branch on it.
 */
export interface FileUpdateChange {
  diff: string;
  kind: string;
  path: string;
}

export interface FileChangePatchUpdatedParams {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileUpdateChange[] | unknown;
}

export interface ServerRequestResolvedParams {
  threadId: string;
  requestId: RequestId;
}

export interface ErrorNotificationParams {
  threadId?: string;
  turnId?: string;
  error: { message: string; codexErrorInfo?: unknown };
  willRetry?: boolean;
}

/**
 * Per-bucket token counters from the codex app-server. Mirrors the
 * `TokenUsageBreakdown` shape on the wire.
 *
 * Note: terminology is `inputTokens`/`outputTokens`, NOT
 * `promptTokens`/`completionTokens`. An older revision of this type
 * used the OpenAI-style names — leftover from a copy-paste — and
 * silently produced 0/0 totals because the keys didn't match.
 */
export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  /** This-turn-only counters. */
  last: TokenUsageBreakdown;
  /** Running totals across the whole thread. */
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface ThreadTokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
}

// =====================================================================
// ServerRequests (the approval prompts) — ESP32 sees these as approval_required
// =====================================================================

/** Methods that warrant an ESP32 approval card. Order matters for routing. */
export const APPROVAL_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
] as const;

export type ApprovalRequestMethod = (typeof APPROVAL_REQUEST_METHODS)[number];

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  // ...many more fields; the index signature catches the rest.
  [k: string]: unknown;
}

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow" | "deny"; host: string } } };

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  [k: string]: unknown;
}

export interface FileChangeRequestApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

// =====================================================================
// ClientRequests we send (subset)
// =====================================================================

/**
 * Subset of `ThreadResumeResponse` we consume to replay history. The
 * upstream type carries policy / cwd / model / sandbox fields too — we
 * ignore those (we're an observer, not a configurer).
 *
 * Critical detail: `thread.turns[]` is only populated when we DO NOT
 * pass `excludeTurns: true` in the request. Each `Turn.items[]` is
 * likewise only populated on resume/fork responses.
 *
 * `Turn.id` and items have stable `id` fields; that's the basis for
 * idempotent replay.
 */
export interface ResumeResponseTurnItem {
  id: string;
  type: string;
  /** Item-specific fields pass through; we re-dispatch as `unknown`. */
  [k: string]: unknown;
}

export interface ResumeResponseTurn {
  id: string;
  status: string;
  items?: ResumeResponseTurnItem[];
  error?: unknown;
  [k: string]: unknown;
}

export interface ResumeResponseThread {
  id: string;
  name?: string | null;
  ephemeral?: boolean;
  turns?: ResumeResponseTurn[];
  [k: string]: unknown;
}

export interface ThreadResumeResponse {
  thread: ResumeResponseThread;
  /** Other top-level fields exist (approvalPolicy, cwd, model, …) — we ignore them. */
  [k: string]: unknown;
}

export interface ThreadListParams {
  limit?: number;
  cwd?: string[];
}

export interface ThreadListResponse {
  data: Array<{
    id: string;
    forkedFromId?: string | null;
    preview?: string;
    ephemeral: boolean;
    createdAt: number;
    updatedAt: number;
    status: { type: string };
    path?: string;
    [k: string]: unknown;
  }>;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// =====================================================================
// Helpers
// =====================================================================

export function isApprovalRequestMethod(method: string): method is ApprovalRequestMethod {
  return (APPROVAL_REQUEST_METHODS as readonly string[]).includes(method);
}
