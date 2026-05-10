// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Tests for the user-typed-code rendezvous.
// Locks down match / no-match / cancel / replace / TTL / rate-limit
// semantics. The behaviours here ARE the wire contract that production
// firmware (`plaipin_pair_claim` + `tick_claiming_token`) depends on
// — changes here are wire-protocol changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ExpectingCodes,
  ExpectError_,
  isValidPairingCode,
} from "./expectingCodes.js";

const STUB_DETAILS = {
  mac: "aa:bb:cc:dd:ee:ff",
  chip: "ESP32-S3",
  fwVersion: "0.1.0",
  sourceIp: "192.168.1.42",
};

let issueTokenCounter = 0;
function makeIssueToken(): (deviceName: string) => string {
  issueTokenCounter = 0;
  return (deviceName: string) => `tok-${deviceName}-${++issueTokenCounter}`;
}

// =============================================================
// match / no-match
// =============================================================

test("expect + claim with same code → match, fulfilment delivered to long-poll", async () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const expectPromise = ec.expect("472916", "my-pet");

  // Device claims with the same code:
  const result = ec.consume("472916", STUB_DETAILS);
  assert.equal(result.kind, "matched");
  if (result.kind === "matched") {
    assert.equal(result.deviceName, "my-pet");
    assert.equal(result.token, "tok-my-pet-1");
  }

  // Long-poll resolves with full claim metadata:
  const fulfillment = await expectPromise;
  assert.equal(fulfillment.deviceName, "my-pet");
  assert.equal(fulfillment.token, "tok-my-pet-1");
  assert.equal(fulfillment.mac, STUB_DETAILS.mac);
  assert.equal(fulfillment.chip, STUB_DETAILS.chip);
  assert.equal(fulfillment.fwVersion, STUB_DETAILS.fwVersion);
  assert.equal(fulfillment.sourceIp, STUB_DETAILS.sourceIp);
  ec.stop();
});

test("claim with no matching expect → no_match (404 path)", () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const result = ec.consume("123456", STUB_DETAILS);
  assert.equal(result.kind, "no_match");
  ec.stop();
});

test("expect + claim with DIFFERENT code → no_match for the wrong code", async () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const expectPromise = ec.expect("472916", "my-pet");
  // Suppress unhandled rejection — we'll only resolve after stop().
  expectPromise.catch(() => {});

  const wrong = ec.consume("123456", STUB_DETAILS);
  assert.equal(wrong.kind, "no_match");
  // The legitimate expect is still pending. Stop() rejects it.
  ec.stop();
  await assert.rejects(expectPromise, (e: Error) => e instanceof ExpectError_);
});

// =============================================================
// one-shot consume (replay protection)
// =============================================================

test("match consumes the entry — second claim with same code returns no_match", () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const p = ec.expect("472916", "my-pet");
  p.catch(() => {});

  const first = ec.consume("472916", STUB_DETAILS);
  assert.equal(first.kind, "matched");
  const second = ec.consume("472916", STUB_DETAILS);
  assert.equal(second.kind, "no_match");
  ec.stop();
});

test("size() and has() reflect consumption", async () => {
  const ec = new ExpectingCodes(makeIssueToken());
  assert.equal(ec.size(), 0);
  assert.equal(ec.has("472916"), false);

  const p = ec.expect("472916", "my-pet");
  assert.equal(ec.size(), 1);
  assert.equal(ec.has("472916"), true);

  ec.consume("472916", STUB_DETAILS);
  await p; // fulfilled
  assert.equal(ec.size(), 0);
  assert.equal(ec.has("472916"), false);
  ec.stop();
});

// =============================================================
// cancel / replace
// =============================================================

test("cancel rejects the long-poll with `cancelled`", async () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const p = ec.expect("472916", "my-pet");
  const removed = ec.cancel("472916");
  assert.equal(removed, true);
  await assert.rejects(p, (e: Error) => e instanceof ExpectError_ && (e as ExpectError_).kind === "cancelled");
  // Cancelling a code that isn't pending returns false.
  assert.equal(ec.cancel("000000"), false);
  ec.stop();
});

test("re-expect overwrites prior entry — first long-poll rejects with `replaced`", async () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const first = ec.expect("472916", "my-pet");
  const second = ec.expect("472916", "my-pet-2");

  await assert.rejects(first, (e: Error) => e instanceof ExpectError_ && (e as ExpectError_).kind === "replaced");

  const result = ec.consume("472916", STUB_DETAILS);
  assert.equal(result.kind, "matched");
  if (result.kind === "matched") {
    assert.equal(result.deviceName, "my-pet-2");
  }
  const f = await second;
  assert.equal(f.deviceName, "my-pet-2");
  ec.stop();
});

// =============================================================
// rate limiting
// =============================================================

test("rate limit: 6th claim within window returns rate_limited", () => {
  const ec = new ExpectingCodes(makeIssueToken());
  // First 5 claims with no matching expect → no_match (but still count
  // toward the per-IP rate budget).
  for (let i = 0; i < 5; i++) {
    const r = ec.consume("000000", STUB_DETAILS);
    assert.equal(r.kind, "no_match");
  }
  const sixth = ec.consume("000000", STUB_DETAILS);
  assert.equal(sixth.kind, "rate_limited");
  ec.stop();
});

test("rate limit is per source IP", () => {
  const ec = new ExpectingCodes(makeIssueToken());
  for (let i = 0; i < 5; i++) {
    ec.consume("000000", { ...STUB_DETAILS, sourceIp: "10.0.0.1" });
  }
  // Different IP should still have its full budget.
  const fromOther = ec.consume("000000", { ...STUB_DETAILS, sourceIp: "10.0.0.2" });
  assert.equal(fromOther.kind, "no_match");
  ec.stop();
});

// =============================================================
// shutdown
// =============================================================

test("stop() rejects all pending long-polls with daemon_shutdown", async () => {
  const ec = new ExpectingCodes(makeIssueToken());
  const p1 = ec.expect("111111", "a");
  const p2 = ec.expect("222222", "b");
  ec.stop();
  await assert.rejects(p1, (e: Error) => e instanceof ExpectError_ && (e as ExpectError_).kind === "daemon_shutdown");
  await assert.rejects(p2, (e: Error) => e instanceof ExpectError_ && (e as ExpectError_).kind === "daemon_shutdown");
  assert.equal(ec.size(), 0);
});

// =============================================================
// validator + helpers
// =============================================================

test("isValidPairingCode: accepts exactly 6 digits", () => {
  assert.equal(isValidPairingCode("472916"), true);
  assert.equal(isValidPairingCode("000000"), true);
  assert.equal(isValidPairingCode("999999"), true);
});

test("isValidPairingCode: rejects non-6-digit inputs", () => {
  assert.equal(isValidPairingCode(""), false);
  assert.equal(isValidPairingCode("12345"), false);
  assert.equal(isValidPairingCode("1234567"), false);
  assert.equal(isValidPairingCode("47291a"), false);
  assert.equal(isValidPairingCode("472-916"), false); // CLI strips dashes BEFORE validation
  assert.equal(isValidPairingCode(472916), false);
  assert.equal(isValidPairingCode(null), false);
  assert.equal(isValidPairingCode(undefined), false);
});

test("generateCode: produces 6-digit zero-padded strings", () => {
  for (let i = 0; i < 100; i++) {
    const code = ExpectingCodes.generateCode();
    assert.equal(code.length, 6);
    assert.match(code, /^\d{6}$/);
  }
});
