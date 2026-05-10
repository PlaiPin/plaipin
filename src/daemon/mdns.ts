// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// mDNS / Bonjour advertisement so ESP32 devices can discover the daemon
// without a hard-coded IP. Service type: `_plaipin._tcp`.
//
// Three hardening notes against bonjour-service.
//
// 1. Error callback. The library's default is `throw err`. macOS
//    network changes (WiFi sleep, VPN connect, SSID switch) cause the
//    underlying multicast socket to fire EADDRNOTAVAIL from inside
//    dgram.send, which surfaces as an uncaught exception and kills
//    the daemon. We pass an explicit errorCallback that logs and
//    swallows; bonjour-service rebinds on its own next interval.
//    Process-level uncaughtException + unhandledRejection handlers
//    are added in the main daemon entry as a final safety net.
//
// 2. Explicit `host`. Without it, `bonjour-service` falls back to
//    `os.hostname()`, which is platform/router dependent and can
//    return non-`.local` names (e.g. `MacBookPro.lan` when the
//    router's DHCP search domain is `lan`). We pin the SRV target to
//    a stable, install-unique `.local` name derived from the
//    daemonId.
//
// 3. Address-record filter. `Service.records()` emits an A/AAAA
//    record for every non-internal address from
//    `os.networkInterfaces()`, with no filter knob. That includes
//    IPv4 link-local (169.254.0.0/16) self-assigned to un-DHCP'd
//    interfaces such as iPhones connected via USB. We monkey-patch
//    the method to drop link-local addresses. See `mdnsRecordFilter.ts`.

import { Bonjour, type Service } from "bonjour-service";
import pino from "pino";
import { installRecordFilter } from "./mdnsRecordFilter.js";

// Apply the link-local A/AAAA filter at module load — must run before
// any Service is constructed (the patch is on Service.prototype). Don't
// move this inside start() / publish() or instances created elsewhere
// (e.g. tests, future call sites) won't get the filter. Idempotent.
installRecordFilter();

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

export class MdnsAd {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  private currentOpts: { port: number; daemonVersion: string; daemonId: string } | null = null;

  start(opts: { port: number; daemonVersion: string; daemonId: string }): void {
    this.currentOpts = opts;
    this.bonjour = new Bonjour(
      undefined,
      // Whatever interface change caused this is usually transient. Logging
      // at warn so we can spot crash-looping in production but not so noisy
      // it dwarfs real signal.
      (err: Error) => {
        log.warn(
          { err: err.message, code: (err as NodeJS.ErrnoException).code ?? null },
          "mDNS error (swallowed; will retry)",
        );
      },
    );
    // DO NOT remove this `host`. Without it, bonjour-service falls back
    // to `os.hostname()`, which can return non-`.local` names on Macs
    // whose router uses a custom DHCP search domain (e.g. `lan` →
    // `MacBookPro.lan`) — that breaks RFC-correct A-record resolution
    // downstream. The Group E regression test in
    // `mdnsRecordFilter.test.ts` fails if this `host` is removed.
    //
    // 12 hex chars of the daemonId makes the hostname unique per install
    // and collisions cosmically unlikely.
    const hostPrefix = opts.daemonId.slice(0, 12);
    const host = `plaipin-${hostPrefix}.local`;
    // Make the service INSTANCE name unique per install, not just the
    // hostname. Without this, every plaipin daemon would publish
    // under `plaipin._plaipin._tcp.local` — the same instance name.
    // RFC 6762 §8.1 mandates that the second daemon to start up should
    // probe, see the conflict, and rename itself (e.g. `plaipin-2`).
    // `bonjour-service` doesn't auto-rename on instance collision; it
    // emits an error event from registry.js and silently fails to
    // publish, so the daemon would run blind to mDNS and invisible to
    // devices on the LAN.
    //
    // Including the daemonId prefix in the instance name disambiguates
    // up front. Two daemons on the same LAN get distinct names
    // (`plaipin-AAA…`, `plaipin-BBB…`) and both publish cleanly.
    // Device-side discovery still queries by service TYPE
    // (`_plaipin._tcp`), so the instance-name change is invisible to
    // the device's mDNS resolver — it just sees more responders.
    const instanceName = `plaipin-${hostPrefix}`;
    this.service = this.bonjour.publish({
      name: instanceName,
      type: "plaipin",
      protocol: "tcp",
      host,
      port: opts.port,
      // `did` carries a stable per-install Mac fingerprint so devices
      // can distinguish "their" daemon from any other on the LAN. See
      // `auth.ensureDaemonId` for generation; mDNS gets a short prefix
      // (16 chars) — enough to disambiguate without leaking the full ID.
      txt: { v: "1", ver: opts.daemonVersion, auth: "bearer", did: opts.daemonId },
    });
    // Even with a unique instance name, attach an error handler on the
    // service so a future collision (e.g. cosmic 12-hex-char prefix
    // birthday collision) doesn't bubble out as an unhandled
    // EventEmitter error. log + carry on; the daemon's loopback API
    // remains usable even if the LAN-side advertisement is broken.
    const svc = this.service as unknown as { on?: (event: string, listener: (...args: unknown[]) => void) => void };
    if (typeof svc?.on === "function") {
      svc.on("error", (err) => {
        log.warn(
          { err: (err as Error).message ?? String(err) },
          "mDNS service error (swallowed; LAN advertisement may be invisible)",
        );
      });
    }
    log.info(
      { type: "_plaipin._tcp.local", instance: instanceName, host, port: opts.port, did: opts.daemonId },
      "mDNS service published",
    );
  }

  /**
   * Republish the service with new TXT contents. `bonjour-service` has
   * no live TXT update API, so we tear down + republish. Currently only
   * needed when the future `daemonId` rotation feature lands; A/B/C
   * pairing flows don't invoke this.
   */
  republish(opts?: Partial<{ port: number; daemonVersion: string; daemonId: string }>): void {
    if (!this.currentOpts) return;
    const next = { ...this.currentOpts, ...(opts ?? {}) };
    this.stop();
    this.start(next);
  }

  /**
   * Tear down the mDNS advertisement gracefully. Awaits the goodbye
   * packet flush via `bonjour.destroy(callback)` so the daemon's
   * shutdown handler can `await mdns.stop()` and not race process.exit.
   * Without the await, devices on the LAN cache the stale TXT for
   * tens of seconds after the daemon dies.
   *
   * Bounded by a 1 s timeout — bonjour-service's destroy can hang on
   * pathological network state and we'd rather lose the goodbye
   * packet than block shutdown forever.
   */
  async stop(): Promise<void> {
    const bonjour = this.bonjour;
    const service = this.service;
    this.service = null;
    this.bonjour = null;
    if (service?.stop) {
      try {
        service.stop();
      } catch {
        /* ignore — best-effort */
      }
    }
    if (!bonjour) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        log.warn("bonjour.destroy timed out after 1s; goodbye packet may be lost");
        done();
      }, 1000);
      timer.unref();
      try {
        bonjour.destroy(() => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        done();
      }
    });
  }
}
