// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Bearer token auth for ESP32 devices. Currently a simple JSON file
// with per-device tokens. Future hardening: Argon2id-hashed tokens in
// SQLite, rotation, pairing flow.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { PATHS } from "../shared/util.js";

interface PairingFile {
  v: 1;
  /** Bootstrap token printed by `plaipin install` for the very first device. */
  bootstrapToken?: string;
  /**
   * Stable, per-install random ID for this Mac's daemon. Used as the
   * mDNS TXT `did=` value so devices can verify "this is the daemon I
   * paired with" across restarts and on shared-LAN multi-Mac setups.
   * Generated lazily by `ensureDaemonId`. Persisted forever for this
   * install — backup-restore preserves the identity, fresh-install
   * regenerates (and existing devices need to re-pair).
   */
  daemonId?: string;
  devices: Array<{
    deviceId: string;
    /** Hashed token; we store sha256 to avoid plaintext at rest. */
    tokenHash: string;
    pairedAt: number;
    lastSeen: number | null;
    revoked: boolean;
  }>;
}

function load(): PairingFile {
  if (existsSync(PATHS.pairingFile)) {
    try {
      return JSON.parse(readFileSync(PATHS.pairingFile, "utf8"));
    } catch {
      // corrupted; fall through to new file
    }
  }
  return { v: 1, devices: [] };
}

function save(file: PairingFile): void {
  writeFileSync(PATHS.pairingFile, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Generate a new high-entropy token (printable). */
export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Ensure a bootstrap token exists; returns it. */
export function ensureBootstrapToken(): string {
  const f = load();
  if (!f.bootstrapToken) {
    f.bootstrapToken = newToken();
    save(f);
  }
  return f.bootstrapToken;
}

/**
 * Ensure a stable daemon ID exists for this install. Used in mDNS TXT
 * `did=` for multi-Mac LAN binding — devices remember which daemon
 * they paired with and only follow that one.
 *
 * The full ID is 16 hex bytes (32 chars). We expose a 16-char prefix
 * via the mDNS TXT record so it's not directly leaked over multicast
 * but still uniquely identifies the daemon among any plausible LAN
 * neighbor count.
 */
export function ensureDaemonId(): string {
  const f = load();
  if (!f.daemonId) {
    f.daemonId = crypto.randomBytes(16).toString("hex");
    save(f);
  }
  return f.daemonId;
}

/** Short prefix of `ensureDaemonId()` suitable for mDNS TXT advertisement. */
export function daemonIdPublicPrefix(): string {
  return ensureDaemonId().slice(0, 16);
}

/** A single device's persistent record in pairing.json. */
export interface DevicePairingEntry {
  deviceId: string;
  tokenHash: string;
  pairedAt: number;
  lastSeen: number | null;
  revoked: boolean;
}

/** Pair a new device with a freshly-generated token; returns the plaintext token. */
export function pairDevice(deviceId: string): string {
  const f = load();
  const token = newToken();
  f.devices = f.devices.filter((d) => d.deviceId !== deviceId);
  f.devices.push({ deviceId, tokenHash: hash(token), pairedAt: Date.now(), lastSeen: null, revoked: false });
  save(f);
  return token;
}

/**
 * Snapshot the current pairing.json entry for `deviceId`, or undefined
 * if no entry exists. Used by the USB pair flow to capture the prior
 * state before `pairDevice` overwrites it — so a failed `setToken` can
 * roll back without losing the previously-good token.
 */
export function snapshotDeviceEntry(deviceId: string): DevicePairingEntry | undefined {
  const f = load();
  const entry = f.devices.find((d) => d.deviceId === deviceId);
  // Return a shallow copy so the caller can hold it across mutations.
  return entry ? { ...entry } : undefined;
}

/**
 * Restore (or remove) a device entry. Pass the snapshot from
 * `snapshotDeviceEntry` to put it back; pass undefined to remove the
 * entry entirely (used when the prior state was "no entry"). Idempotent:
 * always replaces the current entry for `deviceId`.
 */
export function restoreDeviceEntry(deviceId: string, prior: DevicePairingEntry | undefined): void {
  const f = load();
  f.devices = f.devices.filter((d) => d.deviceId !== deviceId);
  if (prior) f.devices.push(prior);
  save(f);
}

export function listDevices(): Array<{ deviceId: string; pairedAt: number; lastSeen: number | null; revoked: boolean }> {
  return load().devices.map((d) => ({
    deviceId: d.deviceId,
    pairedAt: d.pairedAt,
    lastSeen: d.lastSeen,
    revoked: d.revoked,
  }));
}

export function revokeDevice(deviceId: string): boolean {
  const f = load();
  const d = f.devices.find((x) => x.deviceId === deviceId);
  if (!d) return false;
  d.revoked = true;
  save(f);
  return true;
}

/** Verify a presented bearer token. Returns the deviceId if valid, else null. */
export function verifyToken(token: string): { deviceId: string } | { deviceId: "bootstrap" } | null {
  if (!token) return null;
  const f = load();
  const h = hash(token);
  if (f.bootstrapToken && hash(f.bootstrapToken) === h) {
    return { deviceId: "bootstrap" };
  }
  for (const d of f.devices) {
    if (!d.revoked && d.tokenHash === h) {
      d.lastSeen = Date.now();
      save(f);
      return { deviceId: d.deviceId };
    }
  }
  return null;
}

/**
 * HMAC-SHA256 over the canonical welcome message, base64-encoded.
 *
 * The device verifies this against its NVS-stored per-device token to
 * prove the daemon at the other end of the WS connection knows the
 * token. Replaces an earlier unauthenticated TXT `did=` heuristic that
 * was data-destructive on multi-Mac LANs.
 *
 * Canonical message:
 *   "plaipin/welcome/v1\n" + deviceId + "\n" + nonce + "\n" + daemonId
 *
 * `nonce` is the device-supplied X-PlaiPin-Nonce header echoed
 * verbatim (base64 string, NOT re-encoded). Versioned prefix prevents
 * future cross-frame replay if we add MACs to other frame types.
 */
export function welcomeMac(
  token: string,
  deviceId: string,
  nonce: string,
  daemonId: string,
): string {
  const message = `plaipin/welcome/v1\n${deviceId}\n${nonce}\n${daemonId}`;
  return crypto.createHmac("sha256", token).update(message, "utf8").digest("base64");
}

/**
 * HMAC-SHA256 over the canonical `revoked` frame message, base64-encoded.
 *
 * Sent on `plaipin device revoke <name>` to a connected device. The
 * MAC lets the device distinguish a real revocation from a malicious
 * daemon trying to coerce a re-pair (a malicious daemon doesn't have
 * the device's token and can't synthesise this MAC).
 *
 * Canonical message:
 *   "plaipin/revoked/v1\n" + deviceId + "\n" + reason
 */
export function revokedMac(token: string, deviceId: string, reason: string): string {
  const message = `plaipin/revoked/v1\n${deviceId}\n${reason}`;
  return crypto.createHmac("sha256", token).update(message, "utf8").digest("base64");
}

