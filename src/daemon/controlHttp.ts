// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Loopback-only HTTP control plane on 127.0.0.1:48757.
// Endpoints (no auth — bind is loopback only, trust is via UID):
//   GET    /v1/health                       → {ok:true, ...}
//   POST   /v1/test/inject                  → body: {kind, method, params, id?}
//                                             Routes via the test injector for hook-less demos
//   POST   /v1/test/resolve                 → body: {threadId, requestId}
//                                             Synthesises a serverRequest/resolved event
//
//   Pairing:
//   POST   /v1/devices/expect               → body: {pairingCode, deviceId}
//                                             Long-poll: registers the user's expectation
//                                             that a device with `pairingCode` will claim
//                                             as `deviceId`. Returns 200 with claim details
//                                             when the device claims, 408 on TTL, 410 on
//                                             cancel/replace, 503 on shutdown.
//   DELETE /v1/devices/expect/:pairingCode  → cancel a pending expectation; the long-poll
//                                             on the corresponding POST resolves with 410.

import http from "node:http";
import pino from "pino";
import type { StateModel } from "./state.js";
import { makeTestInjector } from "./notify.js";
import {
  isValidPairingCode,
  ExpectError_,
  type ExpectingCodes,
} from "./expectingCodes.js";

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

export interface ControlHttpOptions {
  port?: number;
  state: StateModel;
  daemonVersion: string;
  expecting: ExpectingCodes;
}

export class ControlHttp {
  private server: http.Server | null = null;
  private port: number;
  private inject: ReturnType<typeof makeTestInjector>;
  private state: StateModel;
  private daemonVersion: string;
  private expecting: ExpectingCodes;

  constructor(opts: ControlHttpOptions) {
    this.port = opts.port ?? 48757;
    this.inject = makeTestInjector(opts.state);
    this.state = opts.state;
    this.daemonVersion = opts.daemonVersion;
    this.expecting = opts.expecting;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        log.info({ port: this.port }, "control HTTP listening on 127.0.0.1");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/v1/health") {
        return this.json(res, 200, {
          ok: true,
          daemonVersion: this.daemonVersion,
          conversations: this.state.list().length,
          activeThreadId: this.state.getActive()?.threadId ?? null,
        });
      }
      if (req.method === "POST" && req.url === "/v1/test/inject") {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || !("method" in body) || !("kind" in body)) {
          return this.json(res, 400, { error: "expected {kind, method, params, id?}" });
        }
        const b = body as { kind: "notification" | "request"; method: string; params: unknown; id?: number | string };
        if (b.kind !== "notification" && b.kind !== "request") {
          return this.json(res, 400, { error: "kind must be 'notification' or 'request'" });
        }
        this.inject(b);
        return this.json(res, 200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/v1/test/resolve") {
        const body = (await readJson(req)) as { threadId?: unknown; requestId?: unknown } | null;
        if (!body || typeof body.threadId !== "string" || (typeof body.requestId !== "string" && typeof body.requestId !== "number")) {
          return this.json(res, 400, { error: "expected {threadId, requestId}" });
        }
        this.state.onServerRequestResolved({ threadId: body.threadId, requestId: body.requestId });
        return this.json(res, 200, { ok: true });
      }
      // POST /v1/devices/expect — long-poll until a device claims with
      // the matching code, or TTL fires (5 min), or the CLI cancels via
      // DELETE, or the daemon shuts down.
      if (req.method === "POST" && req.url === "/v1/devices/expect") {
        const body = (await readJson(req)) as { pairingCode?: unknown; deviceId?: unknown } | null;
        if (
          !body ||
          !isValidPairingCode(body.pairingCode) ||
          typeof body.deviceId !== "string" ||
          !/^[a-zA-Z0-9_-]+$/.test(body.deviceId) ||
          body.deviceId.length > 64
        ) {
          return this.json(res, 400, {
            error:
              "expected {pairingCode: 6 digits, deviceId: [a-zA-Z0-9_-]+ up to 64 chars}",
          });
        }
        const code = body.pairingCode;
        const deviceId = body.deviceId;
        log.info({ code, deviceId }, "expect registered, awaiting device claim");
        // Hook the request's abort path so a CLI that drops out (Ctrl-C
        // or socket close) cancels the expect entry — frees the slot for
        // an immediate retry without waiting for TTL.
        req.on("close", () => {
          if (!res.writableEnded) {
            // Client disconnected while we were long-polling. Cancel.
            this.expecting.cancel(code);
          }
        });
        try {
          const fulfillment = await this.expecting.expect(code, deviceId);
          log.info(
            { code, deviceId: fulfillment.deviceName, mac: fulfillment.mac },
            "expect fulfilled by device claim",
          );
          return this.json(res, 200, {
            status: "fulfilled",
            deviceId: fulfillment.deviceName,
            mac: fulfillment.mac,
            chip: fulfillment.chip,
            fwVersion: fulfillment.fwVersion,
            sourceIp: fulfillment.sourceIp,
          });
        } catch (e) {
          const reason = e instanceof ExpectError_ ? e.kind : "unknown";
          if (reason === "expired") {
            return this.json(res, 408, { status: "expired" });
          }
          if (reason === "cancelled" || reason === "replaced") {
            return this.json(res, 410, { status: reason });
          }
          if (reason === "daemon_shutdown") {
            return this.json(res, 503, { status: "daemon_shutdown" });
          }
          return this.json(res, 500, { error: String(reason) });
        }
      }

      if (req.method === "DELETE" && req.url?.startsWith("/v1/devices/expect/")) {
        const code = req.url.slice("/v1/devices/expect/".length);
        if (!isValidPairingCode(code)) {
          return this.json(res, 400, { error: "expected /v1/devices/expect/<6-digit-code>" });
        }
        const removed = this.expecting.cancel(code);
        return this.json(res, 200, { removed });
      }

      this.json(res, 404, { error: "not found" });
    } catch (e) {
      log.warn({ err: e }, "control HTTP handler error");
      this.json(res, 500, { error: (e as Error).message });
    }
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
