// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Tests for StateModel's snapshot→live dispatcher refinement.
//
// Locks the transition table in state.ts::onItemCompleted:
//   undefined / started               + (any source)  → mark, emit, fire side effects
//   completed:snapshot                + live          → upgrade, RE-EMIT, do not re-fire
//   completed:snapshot                + snapshot      → drop (paranoid duplicate)
//   completed:live                    + (any source)  → drop (already authoritative)

import { test } from "node:test";
import assert from "node:assert/strict";

import { StateModel } from "./state.js";
import type {
  ItemCompletedParams,
  ItemStartedParams,
} from "../shared/protocol.js";

interface CapturedItem {
  threadId: string;
  turnId: string;
  item: unknown;
}

function buildState(): { state: StateModel; emitted: CapturedItem[] } {
  const state = new StateModel();
  const emitted: CapturedItem[] = [];
  state.on("item_completed", (threadId, turnId, item) => {
    emitted.push({ threadId, turnId, item });
  });
  // Need a thread + turn for the dispatcher to consider the item
  // "active" — minimal scaffolding via the public methods.
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
    turn: { id: "turnid", status: "inProgress" },
  } as unknown as Parameters<StateModel["onTurnStarted"]>[0]);
  return { state, emitted };
}

function makeWebSearchItem(query: string): ItemCompletedParams {
  return {
    threadId: "tid",
    turnId: "turnid",
    item: {
      id: "ws_test_1",
      type: "webSearch",
      query,
    },
  } as unknown as ItemCompletedParams;
}

function makeStartedItem(): ItemStartedParams {
  return {
    threadId: "tid",
    turnId: "turnid",
    item: { id: "ws_test_1", type: "webSearch", query: "" },
  } as unknown as ItemStartedParams;
}

test("snapshot completion emits once, then live refinement re-emits with authoritative payload", () => {
  const { state, emitted } = buildState();
  state.onItemStarted(makeStartedItem());
  state.onItemCompleted(makeWebSearchItem(""), /*fromReplay=*/ true);
  assert.equal(emitted.length, 1, "snapshot completion: emits once");
  assert.equal(
    (emitted[0]?.item as { query: string }).query,
    "",
    "snapshot completion: emits with empty query",
  );
  state.onItemCompleted(
    makeWebSearchItem("weather: Tokyo"),
    /*fromReplay=*/ false,
  );
  assert.equal(emitted.length, 2, "live refinement: emits a second time");
  assert.equal(
    (emitted[1]?.item as { query: string }).query,
    "weather: Tokyo",
    "live refinement: second emission has the authoritative query",
  );
});

test("live first, snapshot dropped (no downgrade)", () => {
  const { state, emitted } = buildState();
  state.onItemStarted(makeStartedItem());
  state.onItemCompleted(
    makeWebSearchItem("weather: Tokyo, Japan"),
    /*fromReplay=*/ false,
  );
  assert.equal(emitted.length, 1, "live first: emits once");
  state.onItemCompleted(makeWebSearchItem(""), /*fromReplay=*/ true);
  assert.equal(
    emitted.length,
    1,
    "live first: subsequent snapshot is dropped (no downgrade)",
  );
});

test("snapshot duplicate dropped", () => {
  const { state, emitted } = buildState();
  state.onItemStarted(makeStartedItem());
  state.onItemCompleted(makeWebSearchItem(""), /*fromReplay=*/ true);
  state.onItemCompleted(makeWebSearchItem(""), /*fromReplay=*/ true);
  assert.equal(emitted.length, 1, "snapshot duplicate: emits exactly once");
});

test("live duplicate dropped (idempotent — first live arrival wins)", () => {
  const { state, emitted } = buildState();
  state.onItemStarted(makeStartedItem());
  state.onItemCompleted(makeWebSearchItem("foo"), /*fromReplay=*/ false);
  state.onItemCompleted(makeWebSearchItem("bar"), /*fromReplay=*/ false);
  assert.equal(
    emitted.length,
    1,
    "live duplicate: emits exactly once (live is authoritative on first arrival)",
  );
  assert.equal(
    (emitted[0]?.item as { query: string }).query,
    "foo",
    "live duplicate: first live emission wins",
  );
});

test("side-effect counters fire exactly once on snapshot→live refinement", () => {
  const { state } = buildState();
  // commandExecution exercises the commandsCompleted counter
  const startedCmd: ItemStartedParams = {
    threadId: "tid",
    turnId: "turnid",
    item: {
      id: "cmd_test_1",
      type: "commandExecution",
      command: "ls",
      cwd: "/tmp",
    },
  } as unknown as ItemStartedParams;
  const completedCmd = (exitCode: number | null): ItemCompletedParams => ({
    threadId: "tid",
    turnId: "turnid",
    item: {
      id: "cmd_test_1",
      type: "commandExecution",
      command: "ls",
      cwd: "/tmp",
      exitCode,
      status: exitCode === null ? "inProgress" : "completed",
    },
  } as unknown as ItemCompletedParams);

  state.onItemStarted(startedCmd);
  state.onItemCompleted(completedCmd(null), /*fromReplay=*/ true);
  const stats1 = state.getGlobalStats();
  assert.equal(stats1.commandsStarted, 1, "snapshot completed: commandsStarted=1");
  assert.equal(stats1.commandsCompleted, 1, "snapshot completed: commandsCompleted=1");
  state.onItemCompleted(completedCmd(0), /*fromReplay=*/ false);
  const stats2 = state.getGlobalStats();
  assert.equal(
    stats2.commandsCompleted,
    1,
    "side effects: refinement does NOT double-increment commandsCompleted",
  );
});

// Snapshot for a terminal turn dispatches as live (no :replay) — synthesizeFromResume
// branches on isTerminalStatus(turn.status) and uses the unsuffixed "item/completed"
// method for terminal turns.
test("terminal-turn snapshot dispatches as live, single emission, dedups subsequent live", () => {
  const { state, emitted } = buildState();
  state.onItemStarted(makeStartedItem());
  state.onItemCompleted(makeWebSearchItem("done"), /*fromReplay=*/ false);
  assert.equal(emitted.length, 1);
  assert.equal((emitted[0]?.item as { query: string }).query, "done");
  state.onItemCompleted(makeWebSearchItem("changed"), /*fromReplay=*/ false);
  assert.equal(
    emitted.length,
    1,
    "terminal-turn snapshot: dedups subsequent live event",
  );
});
