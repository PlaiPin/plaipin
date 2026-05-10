// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Wire protocol between plaipind and the ESP32 device.
// Each WS message is a JSON object with a `type` discriminator. Field names
// are short to save bytes — ESP32 has limited RAM and the parser is simple.
//
// See plan §"Daemon ↔ ESP32" for the full contract and rationale.

import type { RequestId } from "./rpc.js";

export const ESP32_PROTOCOL_VERSION = 1;

/**
 * Canonical pet states.
 *
 * Five values for steady agent activity. Mirrors Codex.app's avatar
 * selector verbatim.
 *
 * Priority for cross-thread aggregation: waiting > failed > running > review > idle.
 */
export type PetState = "idle" | "running" | "review" | "waiting" | "failed";

/**
 * Transient overlay animations the device should play once and revert.
 * Daemon emits these for one-shots (e.g., `waving` on first device connect);
 * the firmware may also generate device-local transients (button press,
 * accelerometer wiggle) without going through the wire.
 */
export type TransientPetState = "waving" | "jumping" | "running-right" | "running-left";

export type ThreadStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "running_command"
  | "awaiting_user"
  | "errored";

export type ApprovalKind = "command" | "file" | "permissions" | "input";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * Codex's canonical assistant-message phase, mirroring the
 * `MessagePhase` enum on the wire.
 *
 * - `commentary` — Mid-turn assistant text. Preamble, progress narration,
 *   "I'll peek at the local pet-making notes…" — additional tool calls
 *   or assistant output may follow before turn completion.
 * - `final_answer` — The assistant's terminal answer text for the current
 *   turn. The thing the user actually asked for.
 *
 * Per the schema's docstring: *"Providers do not emit this consistently,
 * so callers must treat `null` as 'phase unknown' and keep compatibility
 * behavior for legacy models."* Newer Codex / GPT-5-class models emit
 * `commentary` and `final_answer`; older ones may leave it null.
 *
 * Firmware can render commentary in a quieter style (italic / dimmer)
 * and `final_answer` as the primary response.
 */
export type MessagePhase = "commentary" | "final_answer";

export interface PendingApprovalSummary {
  id: RequestId;
  threadId: string;
  kind: ApprovalKind;
  summary: string;
  receivedAt: number;
}

export interface ConversationSummary {
  threadId: string;
  name: string | null;
  status: ThreadStatus;
}

export interface PetSnapshot {
  name: string;
  state: PetState;
  /** Optional one-shot overlay; null when none active. */
  transientState: TransientPetState | null;
  holdMs: number;
  spriteUrl: string;
}

/**
 * Aggregate counters since daemon startup. Surfaced both in the welcome
 * snapshot and (separately, on update) via {@link StatsUpdatedEvent}.
 *
 * Tokens are summed across all non-ephemeral threads' last-seen running
 * totals. Turn / command / file / approval counts are lifetime totals.
 *
 * Firmware uses these to drive a "stats" pet sign — e.g. the pet
 * holds up "+847 tokens • 3 turns" between turn boundaries.
 */
export interface StatsSummary {
  threadsTotal: number;
  /**
   * Token counters from `thread/tokenUsage/updated`. Field names mirror
   * Codex's `TokenUsageBreakdown` schema verbatim (`inputTokens`,
   * `outputTokens`, etc.) so it's a one-line audit if Codex changes them.
   */
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
  };
  turnsStarted: number;
  turnsCompleted: number;
  turnsErrored: number;
  commandsStarted: number;
  commandsCompleted: number;
  /** Distinct file paths the agent has patched since startup. */
  filesChanged: number;
  /** Lines added / removed parsed from the unified diffs in patchUpdated. */
  loc: { added: number; removed: number };
  approvalsReceived: number;
  approvalsResolved: number;
  uptimeMs: number;
}

export interface Snapshot {
  active: ConversationSummary | null;
  threads: ConversationSummary[];
  pendingApprovals: PendingApprovalSummary[];
  pet: PetSnapshot;
  stats: StatsSummary;
}

// =====================================================================
// Server → Client (events)
// =====================================================================

export interface WelcomeEvent {
  type: "welcome";
  v: number;
  daemonVersion: string;
  snapshot: Snapshot;
  /**
   * Stable per-install daemon id, hex. Always present on per-device
   * connections; absent on bootstrap-token connections.
   */
  daemonId?: string;
  /**
   * Echo of `X-PlaiPin-Nonce` header. Always present when `mac` is
   * present; absent on bootstrap connections that omit the header.
   */
  nonce?: string;
  /**
   * `base64(HMAC-SHA256(token, "plaipin/welcome/v1\n" + deviceId + "\n" + nonce + "\n" + daemonId))`.
   * Per-device tokens carry it; bootstrap connections skip it. Devices
   * MUST verify before trusting any subsequent frame on the connection.
   */
  mac?: string;
}

/**
 * Operator-initiated revocation. Sent before the daemon closes the WS
 * socket on `plaipin device revoke`. The HMAC over the device's
 * per-device token lets the device distinguish a real revocation from a
 * malicious daemon trying to coerce a re-pair.
 *
 * HMAC message: `"plaipin/revoked/v1\n" + deviceId + "\n" + reason`.
 */
export interface RevokedEvent {
  type: "revoked";
  reason: string;
  mac: string;
}

/**
 * Successful response shape for `POST /v1/devices/claim`.
 *
 * `host` is the IP the device's claim landed on, read from
 * `req.socket.localAddress` at the daemon — guaranteed to be reachable
 * from the device's interface even on multi-homed Macs. The device
 * persists `host`+`port` as a "warm-start endpoint" so subsequent boots
 * can skip the mDNS query when the cached IP is still good.
 */
export interface ClaimSuccessResponse {
  token: string;
  deviceId: string;
  daemonId: string;
  host: string;
  port: number;
}

export interface ThreadFocusEvent {
  type: "thread_focus";
  threadId: string;
  name: string | null;
}

export interface ThreadStatusEvent {
  type: "thread_status";
  threadId: string;
  status: ThreadStatus;
}

export interface AgentTextChunkEvent {
  type: "agent_text_chunk";
  threadId: string;
  turnId: string;
  text: string;
  /**
   * Which phase of the turn this chunk belongs to. Lets the device
   * render commentary ("I'll peek at the notes…") and the final answer
   * differently. `null` when Codex didn't tag the message.
   */
  phase?: MessagePhase | null;
}

/** Surfaces the user's prompt so the ESP32 can show "you said …". */
export interface UserMessageEvent {
  type: "user_message";
  threadId: string;
  text: string;
}

/** Codex compacted (summarised) the thread's history to fit context window. */
export interface ContextCompactedEvent {
  type: "context_compacted";
  threadId: string;
}

export interface AgentTextDoneEvent {
  type: "agent_text_done";
  threadId: string;
  turnId: string;
  summary: string;
  /** Phase of the just-completed message. Same semantics as in agent_text_chunk. */
  phase?: MessagePhase | null;
}

export interface CommandStartedEvent {
  type: "command_started";
  threadId: string;
  summary: string;
  cwd: string | null;
}

export interface CommandOutputChunkEvent {
  type: "command_output_chunk";
  threadId: string;
  text: string;
}

export interface CommandDoneEvent {
  type: "command_done";
  threadId: string;
  exitCode: number | null;
}

export interface FileChangedEvent {
  type: "file_changed";
  threadId: string;
  summary: string;
}

export interface TurnStartedEvent {
  type: "turn_started";
  threadId: string;
  turnId: string;
}

export interface TurnDoneEvent {
  type: "turn_done";
  threadId: string;
  turnId: string;
  durationMs: number;
  summary: string;
  ok: boolean;
}

export interface TokenUsageEvent {
  type: "token_usage";
  threadId: string;
  prompt: number | null;
  completion: number | null;
}

export interface ErrorEvent {
  type: "error";
  threadId: string | null;
  message: string;
}

export interface PetStateEvent {
  type: "pet_state";
  state: PetState;
  /** Optional one-shot overlay; null/absent when none. */
  transientState?: TransientPetState | null;
  holdMs: number;
  reason?: string;
}

export interface ApprovalRequiredEvent {
  type: "approval_required";
  id: RequestId;
  threadId: string;
  kind: ApprovalKind;
  summary: string;
  details?: Record<string, unknown>;
  expiresInMs?: number;
}

export interface ApprovalResolvedEvent {
  type: "approval_resolved";
  id: RequestId;
  by: "self" | "desktop" | "other" | "timeout";
  decision?: ApprovalDecision;
}

export interface ApprovalStaleEvent {
  type: "approval_stale";
  id: RequestId;
}

export interface PongEvent {
  type: "pong";
  t: number;
}

export interface DegradedEvent {
  type: "degraded";
  reason: string;
}

/**
 * Periodic snapshot of running counters (tokens, turns, commands, files,
 * approvals). Emitted on meaningful boundaries — currently turn_completed
 * and approval_resolved — rather than every state mutation, to keep the
 * ESP32 RX path quiet during streaming. Firmware can render these
 * as a pet "sign" or status badge.
 */
export interface StatsUpdatedEvent {
  type: "stats_updated";
  stats: StatsSummary;
}

/**
 * Surfaces what the agent is *doing* internally during a turn — web
 * search, chain-of-thought reasoning, and similar tool invocations. The
 * 60-second silence between `turn_started` and `agent_text_chunk` is
 * usually filled with these; without surfacing them the device can't
 * tell whether the agent is working or stuck.
 *
 * `kind` mirrors the Codex item.type (`webSearch`, `reasoning`,
 * `mcpToolCall`, etc.). `label` is a short human-readable description —
 * e.g. the search query, or null when nothing useful is available.
 */
export type ToolKind =
  | "webSearch"
  | "reasoning"
  | "mcpToolCall"
  | "fileRead"
  | string;

export interface ToolStartedEvent {
  type: "tool_started";
  threadId: string;
  itemId: string;
  kind: ToolKind;
  label?: string | null;
}

export interface ToolDoneEvent {
  type: "tool_done";
  threadId: string;
  itemId: string;
  kind: ToolKind;
  label?: string | null;
}

export type ServerEvent =
  | WelcomeEvent
  | ThreadFocusEvent
  | ThreadStatusEvent
  | AgentTextChunkEvent
  | AgentTextDoneEvent
  | UserMessageEvent
  | ContextCompactedEvent
  | CommandStartedEvent
  | CommandOutputChunkEvent
  | CommandDoneEvent
  | FileChangedEvent
  | TurnStartedEvent
  | TurnDoneEvent
  | TokenUsageEvent
  | ErrorEvent
  | PetStateEvent
  | ApprovalRequiredEvent
  | ApprovalResolvedEvent
  | ApprovalStaleEvent
  | PongEvent
  | DegradedEvent
  | RevokedEvent
  | StatsUpdatedEvent
  | ToolStartedEvent
  | ToolDoneEvent;

// =====================================================================
// Client → Server (commands)
// =====================================================================

export interface HelloCommand {
  type: "hello";
  deviceId: string;
  fwVersion?: string;
}

export interface ApprovalDecideCommand {
  type: "approval_decide";
  id: RequestId;
  decision: ApprovalDecision;
}

export interface SetFocusCommand {
  type: "set_focus";
  threadId: string;
  pin?: boolean;
}

export interface ClearFocusCommand {
  type: "clear_focus";
}

export interface SetSubscriptionsCommand {
  type: "set_subscriptions";
  filters: string[];
}

export interface RequestSnapshotCommand {
  type: "request_snapshot";
}

export interface InterruptTurnCommand {
  type: "interrupt_turn";
  threadId: string;
}

export interface PingCommand {
  type: "ping";
}

export type ClientCommand =
  | HelloCommand
  | ApprovalDecideCommand
  | SetFocusCommand
  | ClearFocusCommand
  | SetSubscriptionsCommand
  | RequestSnapshotCommand
  | InterruptTurnCommand
  | PingCommand;
