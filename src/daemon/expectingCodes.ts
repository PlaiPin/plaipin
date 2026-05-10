// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// User-typed pairing-code rendezvous.
//
// Replaces an earlier two-half rendezvous design. The user types
// the 6-digit code on the CLI; the CLI POSTs `/v1/devices/expect` to the
// loopback control plane, which calls `expect(code, deviceName)` here.
// The promise stays unresolved until either:
//   - the device's LAN-side `/v1/devices/claim` arrives with a matching
//     code → resolves with fulfilment details (token, mac, etc.);
//   - the 5-minute TTL fires → rejects with `expired`;
//   - the CLI cancels (DELETE endpoint) → rejects with `cancelled`;
//   - the daemon is shutting down → rejects with `daemon_shutdown`.
//
// The 6-digit code is the routing primitive: a daemon only has the entry
// if the user typed it into THAT daemon's CLI, so even on a multi-daemon
// LAN the device's claim only matches the user's intended Mac.
//
// Security note (alpha): the device's claim broadcasts the code to
// every daemon it iterates. A LAN-resident adversary running a modified
// daemon can capture the code and inject an `expect` entry on its own
// loopback to win the race. This is an accepted alpha-scope tradeoff;
// the mitigation today is "use USB pair on adversarial networks."

import crypto from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_WINDOW = 5;

/** What the device sends in its claim. Used to enrich the CLI's success message. */
export interface ClaimDetails {
  mac: string;
  chip: string;
  fwVersion: string;
  sourceIp: string;
}

/** Resolved value of the long-poll when a device claims. */
export interface FulfillmentResult {
  deviceName: string;
  token: string;
  mac: string;
  chip: string;
  fwVersion: string;
  sourceIp: string;
}

export type ConsumeResult =
  | { kind: "matched"; token: string; deviceName: string }
  | { kind: "no_match" }
  | { kind: "rate_limited" };

interface ExpectingEntry {
  deviceName: string;
  expiresAt: number;
  fulfill: (result: FulfillmentResult) => void;
  reject: (reason: ExpectError) => void;
}

export type ExpectError = "expired" | "cancelled" | "replaced" | "daemon_shutdown";

export class ExpectError_ extends Error {
  constructor(public readonly kind: ExpectError) {
    super(kind);
    this.name = "ExpectError";
  }
}

export class ExpectingCodes {
  private entries = new Map<string, ExpectingEntry>();
  /** Per-source-IP timestamps for sliding-window rate limiting on claim. */
  private rateLimit = new Map<string, number[]>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly issueToken: (deviceName: string) => string) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /**
   * CLI long-poll: register expectation. Returns a promise that resolves
   * when a device claims with the matching code, or rejects on TTL /
   * cancel / replacement / shutdown.
   *
   * If `code` is already expected, the prior long-poll is rejected with
   * `replaced` (overwrite policy — latest wins; matches typical user
   * intent of "fix typo, retry"). The new long-poll takes the slot.
   */
  expect(code: string, deviceName: string): Promise<FulfillmentResult> {
    return new Promise<FulfillmentResult>((resolve, reject) => {
      const existing = this.entries.get(code);
      if (existing) {
        existing.reject("replaced");
      }
      const entry: ExpectingEntry = {
        deviceName,
        expiresAt: Date.now() + TTL_MS,
        fulfill: (result) => {
          this.entries.delete(code);
          resolve(result);
        },
        reject: (reason) => {
          this.entries.delete(code);
          reject(new ExpectError_(reason));
        },
      };
      this.entries.set(code, entry);
    });
  }

  /**
   * Device side: a device claims with `code`. If a matching expect entry
   * exists, mint a per-device token, fulfill the CLI long-poll, and
   * return the issued token. Per-source-IP rate-limited to defend
   * against online brute force of the 6-digit code.
   *
   * One-shot: a successful match consumes (deletes) the entry, so a
   * replay of the same code by the same or another caller returns
   * `no_match`.
   */
  consume(code: string, details: ClaimDetails): ConsumeResult {
    if (!this.checkRateLimit(details.sourceIp)) {
      return { kind: "rate_limited" };
    }
    const entry = this.entries.get(code);
    if (!entry) return { kind: "no_match" };
    if (entry.expiresAt < Date.now()) {
      // Sweep is lazy; expire on access too. Reject the long-poll.
      entry.reject("expired");
      return { kind: "no_match" };
    }
    const token = this.issueToken(entry.deviceName);
    const result: FulfillmentResult = {
      deviceName: entry.deviceName,
      token,
      mac: details.mac,
      chip: details.chip,
      fwVersion: details.fwVersion,
      sourceIp: details.sourceIp,
    };
    entry.fulfill(result); // also deletes the entry
    return { kind: "matched", token, deviceName: entry.deviceName };
  }

  /** CLI explicit cancellation (Ctrl-C path or DELETE endpoint). */
  cancel(code: string): boolean {
    const entry = this.entries.get(code);
    if (!entry) return false;
    entry.reject("cancelled");
    return true;
  }

  /**
   * Daemon shutdown: reject all pending long-polls so HTTP responses
   * close cleanly, clear sweep timer.
   */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const entry of [...this.entries.values()]) {
      entry.reject("daemon_shutdown");
    }
    this.entries.clear();
  }

  /** Test helper: how many entries currently registered. */
  size(): number {
    return this.entries.size;
  }

  /** Test helper: is a code currently expected. */
  has(code: string): boolean {
    return this.entries.has(code);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [, entry] of [...this.entries]) {
      if (entry.expiresAt < now) {
        entry.reject("expired");
      }
    }
    for (const [ip, ts] of this.rateLimit) {
      const filtered = ts.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
      if (filtered.length === 0) this.rateLimit.delete(ip);
      else this.rateLimit.set(ip, filtered);
    }
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const ts = (this.rateLimit.get(ip) ?? []).filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
    if (ts.length >= RATE_LIMIT_MAX_PER_WINDOW) {
      this.rateLimit.set(ip, ts);
      return false;
    }
    ts.push(now);
    this.rateLimit.set(ip, ts);
    return true;
  }

  /** Helper for generating a fresh 6-digit code. Used by firmware-side simulation in tests. */
  static generateCode(): string {
    const n = crypto.randomInt(0, 1_000_000);
    return n.toString().padStart(6, "0");
  }
}

/**
 * Shared validator for the 6-digit pairing-code format. Used by the
 * LAN-facing `/v1/devices/claim` endpoint (wsServer) AND the loopback
 * `/v1/devices/expect` + `DELETE /v1/devices/expect/<code>` endpoints
 * (controlHttp).
 */
export function isValidPairingCode(raw: unknown): raw is string {
  return typeof raw === "string" && /^\d{6}$/.test(raw);
}
