// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Pet state derivation. Mirrors Codex.app's avatar selector.
//
// Per-conversation rule:
//   if pendingApprovals.size > 0     → "waiting"
//   if turn ended in failure (sticky)→ "failed"
//   if activeTurn != null            → "running"
//   if unread (turn done, not yet
//     consumed) (sticky)             → "review"
//   otherwise                        → "idle"
//
// Cross-thread aggregation: pick the highest-priority state observed on
// ANY non-ephemeral conversation. Priority:
//   waiting > failed > running > review > idle
//
// Sticky semantics — deliberate divergence from Codex.app:
//   Codex.app clears its review state aggressively on focus / navigation,
//   but those signals are client-local — they never cross the WebSocket
//   protocol, so this daemon (as a peer subscriber to the codex
//   app-server) can't observe them. Without compensating logic,
//   `unreadSince` would be functionally permanent (set by every
//   `turn_completed`, cleared only by the next `turn_started` of the
//   same thread), making the device's pet stuck in `review` indefinitely.
//
//   Implemented in state.ts onTurnCompleted: a setTimeout fires
//   UNREAD_AUTO_CLEAR_MS (default 8s, env-overridable) after each
//   successful `turn_completed`. On fire, if no fresher turn replaced
//   the captured `unreadSince` value, we set it to null and emit
//   `thread_updated`, which causes wsServer to re-evaluate the pet
//   selector and broadcast a fresh `pet_state` if the global aggregate
//   changed.
//
//   Diverges mechanically from Codex.app (timer vs. focus-driven) but
//   preserves the user-visible UX shape: review animation flickers
//   briefly, then idle. Approvals continue to drive `waiting` via the
//   higher-priority branch and are unaffected.
//
//   `failedSince` is NOT auto-cleared — errors stay sticky-until-next-
//   turn. Codex.app's own notification expiry is 1 hour for failed vs.
//   7 days for review, which we read as "errors warrant more
//   persistence." Revisit if the asymmetry causes UX problems.
//
//   A future enhancement may add a `mark_read` device command (explicit
//   ack via button gesture) layered on top, primarily useful for
//   clearing background threads that haven't auto-cleared yet.
//
//   See: src/daemon/state.ts (UNREAD_AUTO_CLEAR_MS + onTurnCompleted timer).
//
// Hold + hysteresis (unchanged from earlier design):
//   HOLD_MS              = 500   — debounce; minimum 500 ms between publishes
//   IDLE_HYSTERESIS_MS   = 1500  — require 1.5 s of true idle before transitioning *into* idle
// Higher-priority states preempt the hold window.

import { EventEmitter } from "node:events";
import type { PetState, TransientPetState } from "../shared/esp32Protocol.js";
import type { ConversationState } from "./state.js";

const HOLD_MS = 500;
const IDLE_HYSTERESIS_MS = 1500;

const PRIORITY: Record<PetState, number> = {
  waiting: 5,
  failed: 4,
  running: 3,
  review: 2,
  idle: 1,
};

export interface PetPublish {
  state: PetState;
  transientState: TransientPetState | null;
  reason: string;
  holdMs: number;
}

export class PetMachine extends EventEmitter {
  private currentState: PetState = "idle";
  private currentTransient: TransientPetState | null = null;
  private currentReason: string | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private pendingState: PetState | null = null;
  private pendingReason: string | null = null;
  private idleSince: number | null = Date.now();

  /**
   * Compute state from ALL conversations. Pass `state.list()` (or any
   * iterable of ConversationState).
   */
  evaluate(conversations: Iterable<ConversationState>): void {
    const next = this.computeState(conversations);
    this.proposeState(next.state, next.reason);
  }

  /**
   * Emit a one-shot transient overlay (e.g., `waving` on first device
   * connect). Doesn't affect the steady `state` — listeners receive an
   * extra `pet_state` with the current `state` and the transient set.
   */
  emitTransient(transient: TransientPetState, reason: string): void {
    this.publish(this.currentState, transient, reason);
  }

  getCurrent(): PetPublish {
    return {
      state: this.currentState,
      transientState: this.currentTransient,
      reason: this.currentReason ?? "",
      holdMs: HOLD_MS,
    };
  }

  /**
   * Per-conversation selector — direct mirror of Codex.app's selector
   * for `waiting/failed/running/idle`. The `unreadSince → review`
   * branch matches the same logical mapping, but the daemon also
   * auto-clears `unreadSince` on a timer (set in state.ts) so the
   * `review` outcome is bounded — diverging mechanically from
   * Codex.app's focus-driven clearing, which the daemon can't observe.
   * See header comment.
   */
  private statePerConv(c: ConversationState): PetState {
    if (c.pendingApprovals.size > 0) return "waiting";
    if (c.failedSince !== null) return "failed";
    if (c.activeTurn !== null) return "running";
    if (c.unreadSince !== null) return "review";
    return "idle";
  }

  private computeState(conversations: Iterable<ConversationState>): {
    state: PetState;
    reason: string;
  } {
    let bestState: PetState = "idle";
    let bestReason = "no threads";
    let count = 0;
    for (const c of conversations) {
      count++;
      const s = this.statePerConv(c);
      if (PRIORITY[s] > PRIORITY[bestState]) {
        bestState = s;
        bestReason = reasonFor(s, c);
      }
    }
    if (count === 0) return { state: "idle", reason: "no threads" };
    if (bestState === "idle") return { state: "idle", reason: "all threads idle" };
    return { state: bestState, reason: bestReason };
  }

  private proposeState(next: PetState, reason: string): void {
    // Hysteresis: don't drop into "idle" unless we've been idle long enough.
    if (next === "idle" && this.currentState !== "idle") {
      if (this.idleSince === null) this.idleSince = Date.now();
      const idleFor = Date.now() - this.idleSince;
      if (idleFor < IDLE_HYSTERESIS_MS) {
        if (!this.holdTimer) {
          this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            this.proposeState(next, reason);
          }, IDLE_HYSTERESIS_MS - idleFor);
        }
        return;
      }
    } else {
      this.idleSince = null;
    }

    if (next === this.currentState) return; // no-op

    // Coalesce within hold window: if higher-priority pending arrives, replace.
    if (this.holdTimer) {
      if (this.pendingState === null || PRIORITY[next] > PRIORITY[this.pendingState]) {
        this.pendingState = next;
        this.pendingReason = reason;
      }
      return;
    }

    // Publish immediately and start hold window.
    this.publish(next, null, reason);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.pendingState && this.pendingState !== this.currentState) {
        const pending = this.pendingState;
        const pendingReason = this.pendingReason ?? "";
        this.pendingState = null;
        this.pendingReason = null;
        this.publish(pending, null, pendingReason);
      }
    }, HOLD_MS);
  }

  private publish(state: PetState, transient: TransientPetState | null, reason: string): void {
    this.currentState = state;
    this.currentTransient = transient;
    this.currentReason = reason;
    this.emit("change", { state, transientState: transient, reason, holdMs: HOLD_MS });
    if (state === "idle") this.idleSince = Date.now();
  }
}

function reasonFor(s: PetState, c: ConversationState): string {
  const tid = c.threadId.slice(0, 8);
  switch (s) {
    case "waiting":
      return `approval pending in ${tid}`;
    case "failed":
      return `turn errored in ${tid}`;
    case "running":
      return c.status === "running_command"
        ? `running command in ${tid}`
        : c.status === "streaming"
        ? `agent streaming in ${tid}`
        : `turn in progress in ${tid}`;
    case "review":
      return `unread response in ${tid}`;
    case "idle":
      return "idle";
  }
}
