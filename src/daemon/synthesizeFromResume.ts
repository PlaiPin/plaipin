// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Translate a `thread/resume` response's snapshot into a sequence of
// notifications and feed them through the same dispatcher live events
// use. Closes the missed-events race for fresh threads.
//
// `thread/resume` returns the thread's full turn/item history,
// including items in flight at snapshot time — but those in-flight
// items can have PARTIAL payloads (e.g. webSearch.query empty if the
// search hasn't completed at snapshot time). The live tail later
// delivers the FINAL payload as a second `item/completed` for the
// same id.
//
// PlaiPin broadcasts items as an event stream to multiple consumers
// (wsServer → ESP32 clients / tail), so we tag snapshot replays distinctly
// from live events and let the dispatcher refine on the second
// delivery:
//
//   - Items inside an ACTIVE turn (non-terminal) → dispatched as
//     `item/completed:replay`; the dispatcher tags them "tentative,
//     source=snapshot".
//   - The live `item/completed` (no suffix) arriving later is a
//     refinement that re-emits with the authoritative payload but
//     does not re-fire side-effect counters.
//   - Items in TERMINAL turns are fully populated in the snapshot,
//     so they're dispatched as plain `item/completed` (authoritative).
//
// The dispatcher's idempotency layer (state.ts: seenTurns /
// completedTurns / itemStatus) drops exact duplicates. So replay
// after live overlap is safe; replay before live arrival is what we
// need for the fresh-thread case. See `state.ts::onItemCompleted` for
// the transition table and `state.dispatcher.test.ts` for coverage.
//
// Active (in-flight) turns at snapshot time intentionally don't get a
// synthetic turn/completed — that one will arrive live.

import pino from "pino";
import { shortJson } from "../shared/util.js";
import type { ResumeResponseThread, ResumeResponseTurn, ResumeResponseTurnItem } from "../shared/protocol.js";

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

export type Dispatcher = (method: string, params: unknown) => void;

/**
 * The set of turn statuses Codex marks as "this turn is finished, no more
 * events incoming." Anything else (active, in_progress, …) is treated as
 * still in flight: items replay, but no synthetic turn/completed fires.
 *
 * Conservative: if Codex adds a new terminal status we'd treat it as
 * in-flight and just miss the synthetic turn/completed. Live event would
 * fill it in. False-positive on the other side (treating a non-terminal
 * status as terminal) would emit a phantom turn/completed; we avoid that.
 */
const TERMINAL_TURN_STATUSES = new Set(["completed", "errored", "cancelled", "interrupted", "aborted"]);

function isTerminalStatus(s: string): boolean {
  return TERMINAL_TURN_STATUSES.has(s);
}

/**
 * Walk a resume response's thread.turns[] and dispatch synthetic
 * notifications for each turn + item. Idempotent at the dispatcher level
 * (see state.ts), so safe to call even if some events have already
 * arrived live.
 *
 * Returns the number of turns and items replayed (for logging).
 */
export function synthesizeFromResume(
  thread: ResumeResponseThread,
  dispatch: Dispatcher,
): { turns: number; items: number } {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let itemCount = 0;
  for (const turn of turns) {
    replayTurn(thread.id, turn, dispatch);
    itemCount += Array.isArray(turn.items) ? turn.items.length : 0;
  }
  if (turns.length > 0) {
    log.debug(
      { threadId: thread.id, turns: turns.length, items: itemCount },
      "synthesizeFromResume replayed snapshot",
    );
  }
  return { turns: turns.length, items: itemCount };
}

function replayTurn(threadId: string, turn: ResumeResponseTurn, dispatch: Dispatcher): void {
  // 1. turn/started — gives the dispatcher a chance to set activeTurn etc.
  dispatch("turn/started", { threadId, turn: { id: turn.id, status: turn.status } });

  // 2. items in causal order (assumed: array order is causal). The schema
  //    doesn't promise this explicitly, but the wire ordering matches the
  //    causal turn-item order in practice.
  const isTerminal = isTerminalStatus(turn.status);
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (const item of items) {
    replayItem(threadId, turn.id, item, dispatch, isTerminal);
  }

  // 3. turn/completed only if the snapshot says this turn is terminal.
  //    For an in-flight turn at snapshot time, we let the live
  //    turn/completed arrive and fire normally.
  if (isTerminal) {
    dispatch("turn/completed", {
      threadId,
      turn: { id: turn.id, status: turn.status, error: turn.error ?? null },
    });
  }
}

function replayItem(
  threadId: string,
  turnId: string,
  item: ResumeResponseTurnItem,
  dispatch: Dispatcher,
  parentTurnIsTerminal: boolean,
): void {
  // Each item appears as both a started and completed notification —
  // matches what live events deliver. The dispatcher's `itemStatus` map
  // dedupes if we've already seen either. Our notify.ts handlers don't
  // require deltas to have been fired between started+completed; the
  // final state in `item.text` (etc.) is on the completed event.
  if (typeof item?.id !== "string" || typeof item?.type !== "string") {
    log.warn({ threadId, turnId, item: shortJson(item, 80) }, "skipping malformed snapshot item");
    return;
  }
  // Items in an ACTIVE turn carry tentative payloads — the live tail
  // will deliver the authoritative `item/completed` later. Tag
  // completed events with `:replay` so the dispatcher knows the
  // payload is provisional and a snapshot→live refinement is allowed.
  // Items in a TERMINAL turn are fully populated in the snapshot;
  // dispatch them as plain `item/completed` (authoritative).
  //
  // started events are dispatched as plain (no suffix) regardless —
  // the started payload doesn't get refined later (started fields are
  // immutable once an item exists), so source-tagging buys nothing.
  dispatch("item/started", { threadId, turnId, item });
  if (parentTurnIsTerminal) {
    dispatch("item/completed", { threadId, turnId, item });
  } else {
    dispatch("item/completed:replay", { threadId, turnId, item });
  }
}
