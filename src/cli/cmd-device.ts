// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin device <subcommand>` — manages paired devices.
//
//   device add <name>     Provision a new device. Watches USB enumeration
//                         and the daemon's pending-claims list concurrently;
//                         whichever arrives first wins.
//   device list           Show paired devices.
//   device revoke <name>  Revoke a device's token (immediate disconnect).
//   device reset <name>   Revoke + advise the user to factory-reset the
//                         physical device (long-press button or USB
//                         pair/factoryReset).
//
// Replaces the older `plaipin devices` command group.

import http from "node:http";
import { createInterface } from "node:readline";

import {
  listDevices,
  pairDevice,
  revokeDevice,
  daemonIdPublicPrefix,
  snapshotDeviceEntry,
  restoreDeviceEntry,
} from "../daemon/auth.js";
import {
  listCandidates,
  openClient,
  type PortCandidate,
  type UsbPairClient,
} from "./usbPair.js";
import {
  ok,
  fail as failLine,
  warn,
  action,
  detail,
  pln,
  color,
  glyph,
  spinner,
  startWalkingCreature,
  printBrandLine,
} from "./style.js";

// USB pairing is the **identity / authorization** channel only — it
// writes the auth token + device id to the device's NVS so the daemon
// recognises the device when it later connects over WiFi. WiFi
// credentials are a separate concern (Kconfig dev mode or the
// SoftAP+QR setup flow). Do not add SSID/PSK prompts here.

const DAEMON_CTRL_HOST = "127.0.0.1";
const DAEMON_CTRL_PORT = 48757;
const POLL_INTERVAL_MS = 500;
const DEFAULT_DISCOVER_TIMEOUT_MS = 60_000;

type DiscoverResult =
  | { kind: "usb"; port: PortCandidate }
  | { kind: "code"; code: string };

/**
 * Shape of the daemon's `POST /v1/devices/expect` response when the device's
 * claim arrives. Used by `runWirelessFlow` to print a friendly success line.
 */
interface ExpectFulfillment {
  status: string;
  deviceId?: string;
  mac?: string;
  chip?: string;
  fwVersion?: string;
  sourceIp?: string;
}

interface AddOpts {
  usbOnly?: boolean;
  wireless?: boolean;
  port?: string;
  timeout?: string;
}

interface ListOpts {
  json?: boolean;
}

/**
 * Format a millis-since-epoch timestamp as a short relative-time
 * string. "now", "12s ago", "5m ago", "3h ago", "2d ago".
 */
function relativeTime(ts: number | null): string {
  if (ts === null) return "never";
  const ms = Date.now() - ts;
  if (ms < 5_000) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/**
 * Replace empty / whitespace-only field values with "(unknown)" for
 * display. Belt-and-suspenders for the wireless confirm prompt — the
 * daemon already rejects empty fields at the claim endpoint, but if
 * anything ever leaks through we want a readable render.
 */
function asDisplay(s: string | undefined | null): string {
  return s && s.trim().length > 0 ? s : "(unknown)";
}

export async function cmdDeviceList(opts: ListOpts = {}): Promise<void> {
  const devices = listDevices();
  if (opts.json) {
    // JSON path bypasses ALL styling — must stay scrapable.
    console.log(JSON.stringify(devices, null, 2));
    return;
  }
  if (devices.length === 0) {
    pln(color.info("(no paired devices)"));
    pln("Pair one with " + color.action("plaipin device add <name>") + ".");
    return;
  }
  // Three-glyph status: ● online (lastSeen recent) · ○ offline · ⊘ revoked
  const ONLINE_THRESHOLD_MS = 30_000;
  const nameWidth = Math.max(8, ...devices.map((d) => d.deviceId.length));
  pln();
  pln(color.emphasis(
    `${" "}  ${"name".padEnd(nameWidth)}  ${"status".padEnd(8)}  ${"paired".padEnd(13)}  last seen`,
  ));
  pln(color.info("─".repeat(nameWidth + 40)));
  for (const d of devices) {
    let dot: string;
    let statusText: string;
    if (d.revoked) {
      dot = color.fail(glyph.dotRevoked);
      statusText = color.fail("revoked");
    } else if (d.lastSeen && Date.now() - d.lastSeen < ONLINE_THRESHOLD_MS) {
      dot = color.ok(glyph.dotOn);
      statusText = color.ok("online");
    } else {
      dot = color.info(glyph.dotOff);
      statusText = color.info("offline");
    }
    const paired = relativeTime(d.pairedAt);
    const last = relativeTime(d.lastSeen);
    pln(
      `${dot}  ${color.emphasis(d.deviceId.padEnd(nameWidth))}  ${statusText.padEnd(8 + (statusText.length - "offline".length))}  ${paired.padEnd(13)}  ${color.info(last)}`,
    );
  }
  pln();
}

export async function cmdDeviceRevoke(deviceId: string): Promise<void> {
  if (!revokeDevice(deviceId)) {
    console.error(failLine(`no device named '${deviceId}'`));
    process.exit(1);
  }
  console.log(ok(`revoked ${color.emphasis(deviceId)}`));
}

export async function cmdDeviceReset(deviceId: string): Promise<void> {
  // Revoke the daemon-side token so the device's WS will be refused on
  // its next connect, then ask the user to wipe device NVS. A future
  // enhancement could add a daemon→device "please factory-reset"
  // command if we keep the WS open at revoke time.
  if (!revokeDevice(deviceId)) {
    console.error(failLine(`no device named '${deviceId}'`));
    process.exit(1);
  }
  console.log(ok(`revoked ${color.emphasis(deviceId)} on the daemon`));
  pln();
  pln("Now wipe the device NVS so it re-enters setup mode:");
  pln("  " + color.info(glyph.bullet) + " hold the boot button (GPIO 0) for 5 seconds, OR");
  pln("  " + color.info(glyph.bullet) + " plug it in and run " + color.action(`plaipin device add <new-name>`));
}

export async function cmdDeviceAdd(name: string, opts: AddOpts): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error(failLine(`device name must match [a-zA-Z0-9_-]+ (got '${name}')`));
    process.exit(1);
  }
  if (opts.usbOnly && opts.wireless) {
    console.error(failLine("--usb-only and --wireless are mutually exclusive"));
    process.exit(1);
  }

  const timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : DEFAULT_DISCOVER_TIMEOUT_MS;
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    console.error(failLine("--timeout must be a positive number of seconds"));
    process.exit(1);
  }

  printBrandLine(`device add · ${color.emphasis(name)}`);

  if (opts.port) {
    // User supplied an explicit USB device path; skip discovery.
    await runUsbFlow(name, { path: opts.port }, opts);
    return;
  }

  const watchKind = opts.usbOnly ? "USB only" : opts.wireless ? "wireless only" : "USB + wireless";
  const found = await discoverDevice(opts, timeoutMs, watchKind);
  if (!found) {
    console.error(failLine(`no device appeared within ${timeoutMs / 1000}s.`));
    pln("  " + color.info(glyph.bullet) + " For USB, plug the board in and ensure no monitor is attached.");
    pln("  " + color.info(glyph.bullet) + " For wireless, ensure the daemon is running and the device is in setup mode.");
    process.exit(1);
  }

  if (found.kind === "usb") {
    await runUsbFlow(name, found.port, opts);
  } else {
    await runWirelessFlow(name, found.code);
  }
}

interface WatchStatus {
  /** Number of USB candidates seen on the most recent tick. */
  usbCandidates: number;
}

async function discoverDevice(
  opts: AddOpts,
  timeoutMs: number,
  watchKind: string,
): Promise<DiscoverResult | null> {
  const tasks: Array<Promise<DiscoverResult>> = [];
  const cancellers: Array<() => void> = [];
  const status: WatchStatus = { usbCandidates: 0 };

  if (!opts.wireless) {
    tasks.push(watchUsb(cancellers, status));
  }
  if (!opts.usbOnly) {
    // Typed-code prompt. Reads from stdin; cancellable when USB wins.
    // We deliberately don't show a spinner alongside — readline and
    // ora's spinner both write to the same stdout and produce
    // mojibake when interleaved.
    tasks.push(watchTypedCode(cancellers));
  }
  if (tasks.length === 0) return null;

  pln();
  if (opts.wireless) {
    pln(color.action("Wireless pairing — type the code shown on your device's display."));
  } else if (opts.usbOnly) {
    pln(color.action(`Watching for a USB device (${watchKind})…`));
  } else {
    pln(color.action(`Looking for a USB device, or type the pairing code shown on your device's display.`));
    pln(color.info(`(USB takes priority — if a device appears, the prompt will be cancelled.)`));
  }
  pln();

  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const winner = await Promise.race([Promise.race(tasks), timer]);
  for (const cancel of cancellers) cancel();
  if (winner) {
    const kind = winner.kind === "usb" ? `USB ${winner.port.path}` : `code ${formatCode(winner.code)}`;
    console.log(ok(`Captured: ${color.emphasis(kind)}`));
  } else {
    console.log(failLine(`No device appeared within ${timeoutMs / 1000}s`));
  }
  return winner;
}

function watchUsb(cancellers: Array<() => void>, status: WatchStatus): Promise<DiscoverResult> {
  return new Promise<DiscoverResult>((resolve) => {
    let cancelled = false;
    cancellers.push(() => {
      cancelled = true;
    });
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const ports = await listCandidates();
        if (cancelled) return;
        status.usbCandidates = ports.length;
        if (ports.length === 1) {
          resolve({ kind: "usb", port: ports[0]! });
          return;
        }
        if (ports.length > 1) {
          // Multiple candidates: pick the first; the user can use --port
          // to disambiguate.
          console.log(`Multiple candidate ports found; using ${ports[0]!.path}`);
          for (const p of ports.slice(1)) console.log(`  (also: ${p.path})`);
          resolve({ kind: "usb", port: ports[0]! });
          return;
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (/serialport native module unavailable/.test(msg)) {
          console.error(`plaipin: ${msg}`);
          // Don't resolve — let the wireless watcher or timeout win.
        }
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

/**
 * Read the 6-digit pairing code from stdin. Cancellable: when USB wins
 * the race, the cancel callback closes the readline interface so the
 * outer Promise.race finishes cleanly.
 *
 * Tolerates "472-916" (with optional dashes / spaces) — strips
 * non-digits before validating. Re-prompts on invalid input until a
 * valid code is typed or cancellation fires.
 */
function watchTypedCode(cancellers: Array<() => void>): Promise<DiscoverResult> {
  return new Promise<DiscoverResult>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let cancelled = false;
    cancellers.push(() => {
      if (cancelled) return;
      cancelled = true;
      try {
        rl.close();
      } catch {
        /* readline may already be closed */
      }
    });
    const ask = (): void => {
      if (cancelled) return;
      rl.question("Enter the pairing code shown on your device's screen: ", (raw) => {
        if (cancelled) return;
        const code = raw.replace(/[^\d]/g, "");
        if (/^\d{6}$/.test(code)) {
          try {
            rl.close();
          } catch {
            /* ignore */
          }
          resolve({ kind: "code", code });
          return;
        }
        console.log(warn("That doesn't look like a 6-digit code; try again."));
        ask();
      });
    };
    ask();
  });
}

async function runUsbFlow(
  name: string,
  port: { path: string; vendorId?: string },
  _opts: AddOpts,
): Promise<void> {
  console.log(action(`Pairing over USB at ${color.pathlike(port.path)}`));
  let client: UsbPairClient | undefined;
  try {
    client = await openClient(port.path);
  } catch (e) {
    console.error(failLine((e as Error).message));
    process.exitCode = 1;
    return;
  }
  // Use process.exitCode + return on error rather than process.exit(1).
  // The latter runs synchronously and skips the `finally` block, so the
  // serial port stays held until the OS releases the FD on process
  // death; setting exitCode lets finally's client.close() run and the
  // natural exit picks up the non-zero code.
  try {
    let info: Awaited<ReturnType<UsbPairClient["info"]>>;
    try {
      info = await client.info();
    } catch (e) {
      // Distinguish "device unresponsive" from "device alive but not
      // in pair mode (e.g. running ONLINE after a prior pair)". The
      // serial port emits log output regardless of pair mode; if we
      // saw any bytes during the pair/info window, the device is fine
      // — it just isn't running pair_usb's rx_task. Surface the
      // targeted recovery action.
      const msg = (e as Error).message;
      if (/timeout/i.test(msg) && client.sawAnyOutput) {
        console.error(failLine("device is alive (saw log output on this port) but isn't responding to pair RPCs."));
        pln("  Likely cause: device is in ONLINE mode (already paired) rather than SETUP_USB_ONLY.");
        pln("  Recovery options:");
        pln("    " + color.info(glyph.bullet) + " long-press GPIO 0 (BOOT button) for ≥5 seconds to factory-reset NVS, OR");
        pln("    " + color.info(glyph.bullet) + " erase + re-flash from your device build checkout");
        pln("  Then re-run " + color.action("plaipin device add <name>") + ".");
        process.exitCode = 1;
        return;
      }
      // Generic fallback (real timeout against an unresponsive device,
      // wrong port, dead board, etc.) — keep the original error verbatim.
      throw e;
    }
    console.log(ok(`Found ${color.emphasis(info.chip)}`));
    console.log(detail("mac", info.mac));
    console.log(detail("schema", `v${info.schemaVersion}`));
    console.log(detail("fw", info.fwVersion));
    if (info.hasAuth && info.deviceId) {
      console.log(warn(`Device already paired as ${color.emphasis(info.deviceId)}. Continuing will overwrite its identity.`));
    }
    if (!info.hasWifi) {
      console.log(warn("Device has no WiFi credentials in NVS."));
      pln(color.info(
        "       After pairing it will need WiFi from Kconfig (dev: CONFIG_PLAIPIN_DEV_HARDCODED_CREDS=y)\n" +
        "       or the SoftAP setup flow to actually reach the daemon.",
      ));
    }

    // pairDevice() overwrites any existing pairing.json entry for `name`.
    // Capture the prior entry first so we can roll back if setToken fails
    // in a way that didn't commit on the firmware side.
    const priorEntry = snapshotDeviceEntry(name);
    const token = pairDevice(name);
    const daemonId = daemonIdPublicPrefix();

    // Track setToken's outcome separately from subsequent steps so the
    // rollback decision is precise.
    //
    // - If setToken returns ok, the firmware has already committed the
    //   new token to NVS (handle_set_token commits BEFORE emitting ok —
    //   see pair_usb.c). Rolling back because a LATER step
    //   (waitForConnect timeout, reboot error) failed would create a
    //   token mismatch and brick the pairing.
    //
    // - If setToken throws "closed before response" or times out, the
    //   firmware MAY have committed before USB dropped (small window
    //   between nvs_commit returning and the ack bytes hitting the CDC
    //   bus). We can't tell from the error alone — but waitForConnect
    //   resolves the ambiguity: if the device appears on WS, it DID
    //   commit (otherwise it would have no token to present).
    //
    // Decision matrix:
    //   setToken ok  + waitForConnect ok   → success (don't roll back)
    //   setToken ok  + waitForConnect fail → don't roll back; tell user
    //                                         device wrote token but
    //                                         didn't come online
    //   setToken err + waitForConnect ok   → don't roll back; firmware
    //                                         committed despite the lost
    //                                         ack
    //   setToken err + waitForConnect fail → roll back; firmware
    //                                         probably didn't commit
    let setTokenSucceeded = false;
    let setTokenErr: Error | undefined;

    try {
      await client.setToken(token, name, daemonId);
      setTokenSucceeded = true;
      console.log(ok(`Token written to NVS for ${color.emphasis(name)}`));
      await client.reboot();
      console.log(action("Rebooting device — it will connect to the daemon as soon as it's on WiFi"));
    } catch (e) {
      const err = e as Error;
      if (setTokenSucceeded) {
        console.log(warn(`Post-setToken step failed (${err.message}); will check whether the device comes online anyway.`));
      } else {
        setTokenErr = err;
        console.log(warn(`setToken did not get an ack (${err.message}); will check whether the device comes online anyway — firmware may have committed to NVS before USB dropped.`));
      }
    }

    // Release the serial port BEFORE polling so the device's WiFi
    // logs aren't blocked behind our open handle on the same UART.
    await client.close();

    let connected = false;
    try {
      await waitForConnect(name, 30_000);
      connected = true;
    } catch {
      connected = false;
    }

    if (connected) {
      if (!setTokenSucceeded) {
        console.log(ok(`Device came online with the new token (setToken ack was lost but firmware had already committed before disconnect)`));
      }
      pln();
      pln(color.emphasis("Try it: open Codex, send a message, watch your pet come alive!"));
      return;
    }

    // Device didn't connect within 30 s.
    if (setTokenSucceeded) {
      console.log(warn(`Device ${color.emphasis(name)} didn't appear within 30s, BUT the auth token was written successfully.`));
      pln(color.info(
        "       Likely causes: device lost USB power (cable yank), WiFi unavailable,\n" +
        "       or the daemon's WS endpoint isn't reachable from the device's network.",
      ));
      pln("       Run " + color.action("plaipin device list") + " to check status; replug the device or fix WiFi and it should connect.");
      process.exitCode = 1;
      return;
    }

    // setToken failed AND device never appeared → assume firmware
    // didn't commit. Original safety net: roll back the daemon-side
    // mutation pairDevice() made.
    restoreDeviceEntry(name, priorEntry);
    const errMsg = setTokenErr?.message ?? "unknown error";
    if (priorEntry && !priorEntry.revoked) {
      console.error(failLine(`pairing failed (${errMsg}); rolled back daemon-side pairing for ${color.emphasis(name)} to its prior state.`));
    } else {
      console.error(failLine(`pairing failed (${errMsg}); cleared the half-written pairing entry for ${color.emphasis(name)}.`));
    }
    process.exitCode = 1;
    return;
  } catch (e) {
    console.error(`plaipin: pairing failed: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  } finally {
    await client.close();
  }
}

async function runWirelessFlow(name: string, code: string): Promise<void> {
  pln();
  console.log(action(`Long-polling daemon for device claim with code ${color.emphasis(formatCode(code))}…`));
  console.log(color.info(
    `   (the device will iterate mDNS responders on the LAN; whichever daemon\n` +
    `    has a matching code issues a token. 5-minute timeout.)`,
  ));
  pln();

  let result: ExpectFulfillment;
  try {
    result = await postJsonLongPoll<ExpectFulfillment>(
      "/v1/devices/expect",
      { pairingCode: code, deviceId: name },
    );
  } catch (e) {
    const err = e as Error;
    if (/HTTP 408/.test(err.message)) {
      console.error(failLine(`pairing code ${formatCode(code)} expired (5 min TTL).`));
      pln(color.info("       Generate a fresh code on the device and try again."));
      process.exitCode = 1;
      return;
    }
    if (/HTTP 410/.test(err.message)) {
      console.error(failLine(`pairing was cancelled or replaced.`));
      process.exitCode = 1;
      return;
    }
    console.error(failLine(`expect failed: ${err.message}`));
    process.exitCode = 1;
    return;
  }
  if (result.status !== "fulfilled") {
    console.error(failLine(`unexpected expect response: ${JSON.stringify(result)}`));
    process.exitCode = 1;
    return;
  }
  console.log(ok(
    `Paired ${color.emphasis(name)} ${color.info(
      `(mac ${asDisplay(result.mac)}, ${asDisplay(result.chip)}, fw ${asDisplay(result.fwVersion)})`,
    )}`,
  ));
  // waitForConnect throws on timeout — for wireless we treat the
  // throw as a soft warning (already printed inside waitForConnect)
  // and exit non-zero without re-printing.
  try {
    await waitForConnect(name, 30_000);
    pln();
    pln(color.emphasis("Try it: open Codex, send a message, watch your pet come alive!"));
  } catch {
    process.exitCode = 1;
  }
}

/**
 * Poll listDevices() for the new entry's `lastSeen` to flip from null
 * to set, indicating the device successfully opened a WS connection
 * (verifyToken stamps lastSeen on every match). Times out after
 * `timeoutMs` with a soft message — pairing.json was updated
 * regardless so the next reconnect will work.
 */
async function waitForConnect(deviceId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // A small "creature" ping-pongs across a fixed-width track while we
  // poll for the device to appear via WS. On non-TTY environments
  // startWalkingCreature returns a no-op handle and we fall back to a
  // one-shot start log. The actual completion line
  // ("✓ connected" / "⚠ didn't connect") is always printed regardless
  // of TTY.
  const isTty = Boolean(process.stdout.isTTY);
  const prefix = `   ${color.action("▸")}  Waiting for ${color.emphasis(deviceId)}`;
  const walker = startWalkingCreature(prefix, `${Math.ceil(timeoutMs / 1000)}s left`);
  if (!isTty) {
    pln(`${prefix} (up to ${Math.ceil(timeoutMs / 1000)}s)`);
  }
  let lastNonTtyTick = 0;

  try {
    while (Date.now() - start < timeoutMs) {
      const entry = listDevices().find((d) => d.deviceId === deviceId);
      if (entry?.lastSeen) {
        walker.stop();
        const elapsed = Math.floor((Date.now() - start) / 1000);
        console.log(ok(`${color.emphasis(deviceId)} is online ${color.info(`(paired in ${elapsed}s)`)}`));
        return;
      }
      const remaining = Math.ceil((timeoutMs - (Date.now() - start)) / 1000);
      walker.setSuffix(`${remaining}s left`);
      // Non-TTY fallback: dot every 5s so progress is visible in CI / logs.
      if (!isTty && Date.now() - lastNonTtyTick > 5000) {
        pln(color.info(`   …still waiting (${remaining}s left)`));
        lastNonTtyTick = Date.now();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    walker.stop();
    console.log(warn(`${color.emphasis(deviceId)} did not connect within ${timeoutMs / 1000}s.`));
    pln(color.info(
      "       The pairing record is saved — the device will appear once it joins WiFi and finds the daemon.",
    ));
    pln("       Run " + color.action("plaipin device list") + " to check.");
    throw new Error(`'${deviceId}' did not connect within ${timeoutMs / 1000}s`);
  } finally {
    walker.stop();
  }
}

function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** Per-call timeout for control-plane HTTP requests. Without this the
 * CLI would hang forever if the daemon stalled (mid-snapshot replay,
 * blocked on a Codex.app socket, etc.). 5 s is generous for loopback
 * but tight enough that the user notices and can Ctrl-C before
 * confusion sets in. */
const HTTP_REQUEST_TIMEOUT_MS = 5000;

/** Long-poll timeout for `POST /v1/devices/expect`. The daemon's TTL
 * is 5 min; we add a small grace so a clean 408 response wins over a
 * client-side timeout. Ctrl-C still cancels via process exit. */
const HTTP_LONGPOLL_TIMEOUT_MS = 6 * 60 * 1000;

function getJson<T>(path: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host: DAEMON_CTRL_HOST,
        port: DAEMON_CTRL_PORT,
        path,
        method: "GET",
        timeout: HTTP_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${text}`));
              return;
            }
            resolve(text ? (JSON.parse(text) as T) : ({} as T));
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP GET ${path} timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function postJson<T>(path: string, body: unknown, timeoutMs: number = HTTP_REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: DAEMON_CTRL_HOST,
        port: DAEMON_CTRL_PORT,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400 && (res.statusCode ?? 0) !== 408) {
              reject(new Error(`HTTP ${res.statusCode}: ${text}`));
              return;
            }
            resolve(text ? (JSON.parse(text) as T) : ({} as T));
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP POST ${path} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** Wrapper around `postJson` for long-poll endpoints (e.g.
 * `/v1/devices/expect` blocks until the device claims). Just bumps
 * the timeout — same wire shape and error handling. */
function postJsonLongPoll<T>(path: string, body: unknown): Promise<T> {
  return postJson<T>(path, body, HTTP_LONGPOLL_TIMEOUT_MS);
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
