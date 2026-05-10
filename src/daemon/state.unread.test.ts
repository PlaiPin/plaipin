// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Tests for the timer-based auto-clear of `unreadSince`.
//
// Run fast under `npm test` — package.json sets PLAIPIN_UNREAD_AUTO_CLEAR_MS=200
// so each timer-bound test waits ~250ms instead of the production 8s.

import { test } from "node:test";
import assert from "node:assert/strict";

import { StateModel, UNREAD_AUTO_CLEAR_MS } from "./state.js";
import type { ConversationState } from "./state.js";

function buildState(): { state: StateModel; updates: ConversationState[] } {
  const state = new StateModel();
  const updates: ConversationState[] = [];
  state.on("thread_updated", (c) => updates.push(c));

  state.onThreadStarted({
    thread: {
      id: "tid",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: { id: "openai", model: "test" },
    },
  } as unknown as Parameters<StateModel["onThreadStarted"]>[0]);
  state.onTurnStarted({
    threadId: "tid",
    turn: { id: "turn1", status: "inProgress", error: null },
  } as unknown as Parameters<StateModel["onTurnStarted"]>[0]);
  return { state, updates };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("turn_completed (ok) sets unreadSince, leaves failedSince null", () => {
  const { state } = buildState();
  state.onTurnCompleted({
    threadId: "tid",
    turn: { id: "turn1", status: "completed", error: null },
  } as unknown as Parameters<StateModel["onTurnCompleted"]>[0]);
  const conv = state.get("tid")!;
  assert.notEqual(conv.unreadSince, null, "unreadSince is set after ok turn_completed");
  assert.equal(conv.failedSince, null, "failedSince stays null on ok turn_completed");
  assert.ok(
    typeof UNREAD_AUTO_CLEAR_MS === "number" && UNREAD_AUTO_CLEAR_MS > 0,
    "UNREAD_AUTO_CLEAR_MS is exported and positive",
  );
});

test("auto-clear timer clears unreadSince and emits thread_updated", async () => {
  const { state, updates } = buildState();
  const initialUpdates = updates.length;
  state.onTurnCompleted({
    threadId: "tid",
    turn: { id: "turn1", status: "completed", error: null },
  } as unknown as Parameters<StateModel["onTurnCompleted"]>[0]);
  const conv = state.get("tid")!;
  assert.notEqual(conv.unreadSince, null, "unreadSince set after turn_completed");

  await sleep(UNREAD_AUTO_CLEAR_MS + 100);

  assert.equal(
    conv.unreadSince,
    null,
    `unreadSince auto-cleared after ${UNREAD_AUTO_CLEAR_MS}ms`,
  );
  assert.ok(
    updates.length > initialUpdates,
    "thread_updated was emitted (so wsServer can re-broadcast pet_state)",
  );
});

test("fresh turn_completed during the window makes the pending timer a no-op", async () => {
  const { state } = buildState();

  state.onTurnCompleted({
    threadId: "tid",
    turn: { id: "turn1", status: "completed", error: null },
  } as unknown as Parameters<StateModel["onTurnCompleted"]>[0]);
  const conv = state.get("tid")!;
  const firstUnreadAt = conv.unreadSince;
  assert.notEqual(firstUnreadAt, null, "first turn set unreadSince");

  await sleep(UNREAD_AUTO_CLEAR_MS / 2);

  state.onTurnStarted({
    threadId: "tid",
    turn: { id: "turn2", status: "inProgress", error: null },
  } as unknown as Parameters<StateModel["onTurnStarted"]>[0]);
  // turn_started clears unreadSince to null first
  assert.equal(conv.unreadSince, null, "turn_started clears unreadSince to null");

  state.onTurnCompleted({
    threadId: "tid",
    turn: { id: "turn2", status: "completed", error: null },
  } as unknown as Parameters<StateModel["onTurnCompleted"]>[0]);
  const secondUnreadAt = conv.unreadSince;
  assert.notEqual(secondUnreadAt, null, "second turn set a new unreadSince");
  assert.notEqual(
    secondUnreadAt,
    firstUnreadAt,
    "second turn's unreadSince timestamp differs from the first",
  );

  // Wait just past the FIRST timer's scheduled fire (its captured value is stale).
  await sleep(UNREAD_AUTO_CLEAR_MS / 2 + 50);
  assert.equal(
    conv.unreadSince,
    secondUnreadAt,
    "stale first-turn timer did NOT clear the second turn's unreadSince",
  );

  // Wait for the SECOND timer to fire (its captured value matches).
  await sleep(UNREAD_AUTO_CLEAR_MS / 2 + 100);
  assert.equal(conv.unreadSince, null, "second turn's timer cleared on schedule");
});

test("failed turn → failedSince set, NOT auto-cleared across the unread window", async () => {
  const { state } = buildState();
  state.onTurnCompleted({
    threadId: "tid",
    turn: { id: "turn1", status: "errored", error: { message: "boom" } },
  } as unknown as Parameters<StateModel["onTurnCompleted"]>[0]);
  const conv = state.get("tid")!;
  assert.notEqual(conv.failedSince, null, "failedSince set after errored turn");
  assert.equal(conv.unreadSince, null, "unreadSince stays null on errored turn");

  // We deliberately don't auto-clear failed.
  await sleep(UNREAD_AUTO_CLEAR_MS + 100);
  assert.notEqual(
    conv.failedSince,
    null,
    "failedSince is sticky across the unread-auto-clear window (errors persist)",
  );
});
