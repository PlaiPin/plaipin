#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0
// PlaiPin daemon main entry. Responsibilities:
//   - acquire single-instance flock
//   - spawn codex app-server (unix listener)
//   - open internal WS client, initialize, subscribe to notifications
//   - drive the per-thread StateModel from the notification stream
//   - log derived events (no ESP32 server yet — that's the next file)

import { openSync, closeSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { constants as fsConst } from "node:fs";
import crypto from "node:crypto";
import pino from "pino";
import { AppServer } from "./appServer.js";
import { InternalClient } from "./internalClient.js";
import { StateModel } from "./state.js";
import { ensureDirs, PATHS, shortJson } from "../shared/util.js";
import { WsServer } from "./wsServer.js";
import { MdnsAd } from "./mdns.js";
import { PetMachine } from "./pet.js";
import { daemonIdPublicPrefix, ensureBootstrapToken, ensureDaemonId, pairDevice } from "./auth.js";
import { ExpectingCodes } from "./expectingCodes.js";
import { ControlHttp } from "./controlHttp.js";
import { makeNotificationDispatcher, makeServerRequestDispatcher } from "./notify.js";
import { HANDLED_NOTIFICATION_METHODS } from "../shared/protocol.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import type { RpcNotification, RpcRequest } from "../shared/rpc.js";

const DAEMON_VERSION = PACKAGE_VERSION;

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

/**
 * Single-instance lock with stale-detection.
 *
 * The lock is a file containing the PID of the holder. If the file
 * exists but the PID is no longer alive (because the previous daemon
 * was SIGKILL'd, pkill -9'd, OOM-killed, or panicked without running
 * its `process.on("exit")` cleanup), we clear it and retry once.
 *
 * Without this, a single hard-kill produces a permanently-wedged
 * install because launchd's KeepAlive respawns repeatedly into
 * "another plaipin daemon is already running" until manual cleanup.
 */
function acquireSingleInstanceLock(): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(PATHS.daemonLock, fsConst.O_CREAT | fsConst.O_EXCL | fsConst.O_WRONLY, 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          unlinkSync(PATHS.daemonLock);
        } catch {
          /* already gone */
        }
      };
      process.on("exit", release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Stale-lock detection: read the PID, see if it's alive.
      let holderPid = NaN;
      try {
        holderPid = parseInt(readFileSync(PATHS.daemonLock, "utf8").trim(), 10);
      } catch {
        // Lock file unreadable — treat as stale.
      }
      const alive = Number.isFinite(holderPid) && isPidAlive(holderPid);
      if (alive && holderPid !== process.pid) {
        log.fatal(
          { lock: PATHS.daemonLock, holderPid },
          "another plaipin daemon is already running",
        );
        process.exit(2);
      }
      log.warn(
        { lock: PATHS.daemonLock, holderPid: Number.isFinite(holderPid) ? holderPid : null },
        "removing stale lock (holder process is dead)",
      );
      try {
        unlinkSync(PATHS.daemonLock);
      } catch (rmErr) {
        log.fatal({ err: rmErr }, "failed to remove stale lock; aborting");
        process.exit(2);
      }
      // loop and retry the openSync
    }
  }
  // Shouldn't reach here — both attempts failed without throwing.
  log.fatal({ lock: PATHS.daemonLock }, "could not acquire lock after stale-cleanup");
  process.exit(2);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 = no-op; throws ESRCH if process doesn't exist, EPERM if
    // it exists but we can't signal (which still means alive for our purposes).
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function main() {
  ensureDirs();
  const releaseLock = acquireSingleInstanceLock();
  let shuttingDown = false;

  // Process-level safety net. Subsystems (notably bonjour-service) can
  // surface async errors that aren't caught by their own try/catch — most
  // commonly EADDRNOTAVAIL/EINVAL from dgram.send when a network
  // interface vanishes mid-broadcast (sleep/wake, VPN, SSID switch).
  // We log loud but don't exit; if the underlying state is genuinely
  // corrupt, the next operation will fail more visibly and launchd will
  // restart us. Better than silent crash-loop on every WiFi blip.
  process.on("uncaughtException", (err: Error) => {
    log.error(
      { err: err.message, stack: err.stack, code: (err as NodeJS.ErrnoException).code ?? null },
      "uncaughtException (swallowed)",
    );
  });
  process.on("unhandledRejection", (reason: unknown) => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    log.error({ err: e.message, stack: e.stack }, "unhandledRejection (swallowed)");
  });

  const appServer = new AppServer({ socketPath: PATHS.appServerSock });
  appServer.on("log", (_stream, line) => log.debug({ source: "codex" }, line));
  appServer.on("crashloop", () => {
    log.fatal("app-server crash loop; exiting");
    process.exit(1);
  });
  await appServer.start();

  // State + dispatcher are constructed before InternalClient so we can
  // pass the dispatcher in. InternalClient feeds resume-snapshot replays
  // through it (resume-snapshot replays go through the same dispatcher).
  const state = new StateModel();
  const handleNotification = makeNotificationDispatcher(state);
  const handleServerRequest = makeServerRequestDispatcher(state);

  const internal = new InternalClient({
    socketPath: appServer.socket,
    daemonVersion: DAEMON_VERSION,
    dispatch: handleNotification,
  });

  // High-signal logging of state events
  state.on("thread_added", (c) => log.info({ threadId: c.threadId, name: c.name }, "thread added"));
  state.on("active_changed", (id) => log.info({ activeThreadId: id }, "active thread changed"));

  // Auto-subscribe to per-thread events. Without this the internal client
  // only sees broad-scope events (thread/started, thread/status/changed,
  // thread/name/updated) and misses everything turn-related. See the
  // subscription-model docblock in `internalClient.ts`.
  //
  // Three trigger points:
  //   1. After hydrate, resume each thread we just learned about (below).
  //   2. On every thread/started for a NON-ephemeral thread (here).
  //   3. On thread_removed, unsubscribe (server cleans up anyway, but we
  //      keep our local set tidy).
  state.on("thread_added", (c) => {
    if (c.ephemeral || shuttingDown) return;
    internal.resumeThread(c.threadId).catch((e) => {
      log.warn(
        { err: (e as Error).message, threadId: c.threadId },
        "thread/resume failed (non-fatal — turn events for this thread won't reach us)",
      );
    });
  });
  state.on("thread_removed", (threadId) => {
    if (shuttingDown) return;
    internal.unsubscribeThread(threadId).catch(() => {
      /* server closes anyway */
    });
  });
  state.on("approval_added", (tid, a) =>
    log.warn({ threadId: tid, requestId: a.requestId, method: a.method }, "approval requested"),
  );
  state.on("approval_resolved", (tid, rid) =>
    log.info({ threadId: tid, requestId: rid }, "approval resolved"),
  );
  state.on("agent_text_delta", (_tid, _turn, _item, delta) => {
    // very chatty; downgrade to trace
    log.trace({ delta: delta.slice(0, 60) }, "agent text delta");
  });

  // The daemon's internal client is OBSERVE-ONLY for server-initiated
  // requests (see notify.ts for the rationale). Both real Codex traffic and
  // the synthetic test injector use the same dispatchers.
  internal.rpc.on("notification", (n: RpcNotification) => handleNotification(n.method, n.params));
  internal.rpc.on("request", (req: RpcRequest) => handleServerRequest(req));

  internal.rpc.on("close", (code, reason) => {
    if (shuttingDown) return;
    log.error({ code, reason }, "internal client closed; exiting");
    appServer.stop().finally(() => process.exit(1));
  });

  await internal.connect();
  log.info({ method: HANDLED_NOTIFICATION_METHODS }, "internal client ready, subscriptions installed");

  // Snapshot recovery: hydrate from existing threads
  try {
    const list = await internal.listThreads({ limit: 25 });
    state.hydrateFromList(
      list.data.map((t) => ({ id: t.id, preview: t.preview, updatedAt: t.updatedAt })),
    );
    log.info({ count: list.data.length }, "snapshot hydrated");

    // Subscribe to per-thread events for everything we just hydrated.
    // hydrateFromList does NOT emit thread_added (it sets the map directly)
    // so the listener above never fires for these — we have to resume them
    // explicitly. In parallel; failures are non-fatal.
    const hydratedIds = list.data
      .filter((t) => t.ephemeral !== true)
      .map((t) => t.id);
    await Promise.all(
      hydratedIds.map((id) =>
        internal.resumeThread(id).catch((e) => {
          log.warn(
            { err: (e as Error).message, threadId: id },
            "thread/resume failed for hydrated thread (non-fatal)",
          );
        }),
      ),
    );
    log.info({ count: internal.subscriptionCount }, "thread subscriptions established");
  } catch (e) {
    log.warn({ err: e }, "snapshot recovery failed");
  }

  // Ensure a stable per-install daemon ID exists so multi-Mac LANs
  // (or device reconnects across daemon restarts) can disambiguate
  // which daemon a device is paired with. See auth.ensureDaemonId.
  ensureDaemonId(); // generates if absent; harmless if already present.
  const daemonId = daemonIdPublicPrefix();

  // Expecting-codes registry. Lives between:
  //   - wsServer's LAN-facing POST /v1/devices/claim (device side):
  //     synchronously consume on match, return 404 on no-match.
  //   - controlHttp's loopback POST /v1/devices/expect (CLI side):
  //     long-poll registration of {code → deviceName}.
  // The 6-digit code is the routing primitive: the device's claim only
  // matches the daemon whose CLI registered the same code, so multi-Mac
  // LANs work correctly without cross-daemon coordination. See
  // `expectingCodes.ts` for the full lifecycle.
  const expecting = new ExpectingCodes((deviceId: string) => pairDevice(deviceId));

  // ESP32-facing server
  const pet = new PetMachine();
  const wsServer = new WsServer({
    daemonVersion: DAEMON_VERSION,
    state,
    internal,
    pet,
    bindAddr: process.env.PLAIPIN_BIND ?? "0.0.0.0",
    port: Number(process.env.PLAIPIN_PORT ?? "48756"),
    expecting,
    daemonId,
  });
  await wsServer.start();

  // Loopback-only HTTP control plane (used by `plaipin demo`, tests,
  // and the wireless pairing flow)
  const controlHttp = new ControlHttp({
    state,
    daemonVersion: DAEMON_VERSION,
    port: Number(process.env.PLAIPIN_CONTROL_PORT ?? "48757"),
    expecting,
  });
  await controlHttp.start();

  const mdns = new MdnsAd();
  if (process.env.PLAIPIN_MDNS !== "off") {
    try {
      mdns.start({
        port: Number(process.env.PLAIPIN_PORT ?? "48756"),
        daemonVersion: DAEMON_VERSION,
        daemonId,
      });
    } catch (e) {
      log.warn({ err: e }, "mDNS publish failed (non-fatal)");
    }
  }

  // Don't log the plaintext bootstrap token on every daemon start —
  // daemon.out.log is a 10MB+ rolling file, and the token is the auth
  // secret for `plaipin tail`. Log only the sha256 prefix so logs
  // stay readable and the secret doesn't show up in any log share /
  // bug report. The full token is in pairing.json for the CLI's tail
  // command to read directly.
  const bootstrap = ensureBootstrapToken();
  const bootstrapDigest = crypto
    .createHash("sha256")
    .update(bootstrap)
    .digest("hex")
    .slice(0, 8);
  log.info(
    { bootstrapDigest, daemonId },
    "bootstrap token ready (sha256 prefix shown; full secret in pairing.json)",
  );

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ sig }, "shutting down");
      // Await mdns.stop so the goodbye packet flushes before
      // process.exit. Without the await, devices on the LAN cache the
      // stale TXT record for tens of seconds.
      await mdns.stop();
      await controlHttp.stop();
      await wsServer.stop();
      expecting.stop();
      internal.close();
      await appServer.stop();
      releaseLock();
      process.exit(0);
    });
  }

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((e) => {
  log.fatal({ err: e }, "fatal");
  process.exit(1);
});
