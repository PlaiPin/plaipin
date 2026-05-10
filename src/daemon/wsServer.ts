// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// ESP32-facing WebSocket server. Per-device connections, bearer auth,
// snapshot on connect, server-pushed events, and approval_decide commands
// routed back to the internal client.

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import pino from "pino";
import type {
  ApprovalKind,
  ClientCommand,
  ConversationSummary,
  MessagePhase,
  PendingApprovalSummary,
  PetState,
  ServerEvent,
  Snapshot,
  StatsSummary,
  ThreadStatus,
  TransientPetState,
} from "../shared/esp32Protocol.js";
import { ESP32_PROTOCOL_VERSION } from "../shared/esp32Protocol.js";
import { revokedMac, verifyToken, welcomeMac, listDevices } from "./auth.js";
import { isValidPairingCode, type ExpectingCodes } from "./expectingCodes.js";
import type { StateModel, ConversationState } from "./state.js";
import type { InternalClient } from "./internalClient.js";
import type { PetMachine } from "./pet.js";
import type { RequestId } from "../shared/rpc.js";

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

const APPROVAL_KIND_BY_METHOD: Record<string, ApprovalKind> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "input",
};

interface DeviceConnection {
  deviceId: string;
  socket: WebSocket;
  filters: Set<string>;
  /** Last approval IDs we routed for this device, used to disambiguate "self" vs "desktop" */
  recentDecisions: Map<RequestId, "self">;
  /**
   * Plaintext bearer token presented at WS upgrade. Held for the
   * connection's lifetime so welcome / revoked MACs can be computed.
   * Cleared via socket close → conn delete; never logged.
   */
  bearerToken: string;
  /**
   * X-PlaiPin-Nonce echo (base64 string, 24 chars for 16 raw bytes).
   * `null` for bootstrap connections that omitted the header — those
   * receive an unsigned welcome.
   */
  nonce: string | null;
}

/**
 * Per-itemId agent-text batcher. The Codex protocol streams every
 * generated token (often 1–3 chars) as its own item/agentMessage/delta.
 * Forwarding 1:1 to the WS would burn ~50–300 frames/sec under parallel
 * turns and fill ESP32 RX buffers. Batch into ≤1 KB chunks flushed every
 * BATCH_FLUSH_MS so the device still feels live but receives ~10/sec.
 *
 * Batches key on `itemId` rather than `(threadId, turnId)` because a
 * single turn may contain MULTIPLE agentMessage items with different
 * `phase` values (e.g. a `commentary` "I'll peek at the notes…" before
 * tool calls, then a `final_answer` after). Batching per-turn would
 * mix their text into one buffer; batching per-item keeps them isolated
 * and lets each chunk carry the correct phase tag.
 */
const TEXT_BATCH_MAX_BYTES = 1024;
const TEXT_BATCH_FLUSH_MS = 100;
interface TextBatch {
  threadId: string;
  turnId: string;
  itemId: string;
  /** Captured at item/started; null when Codex didn't tag the message. */
  phase: MessagePhase | null;
  buf: string;
  timer: NodeJS.Timeout | null;
}

export interface WsServerOptions {
  port?: number;
  bindAddr?: string;
  daemonVersion: string;
  state: StateModel;
  internal: InternalClient;
  pet: PetMachine;
  /** sprite URL the ESP32 will fetch (active pet served from the daemon HTTP). */
  petSpriteUrl?: string;
  petName?: string;
  /** Expecting-codes registry — the user-typed pairing-code map. */
  expecting: ExpectingCodes;
  /** Stable per-install daemon ID returned to devices in claim responses. */
  daemonId: string;
}

export class WsServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Set<DeviceConnection>();
  /**
   * Periodic poll that checks pairing.json for revoked devices and
   * emits a signed `revoked` frame to any connection whose deviceId
   * was revoked since last tick. Started in `start()`, cleared in
   * `stop()`. Cadence matches PROTOCOL.md's "Revocation kicks an active
   * connection within ~1s."
   */
  private revokePoller: NodeJS.Timeout | null = null;
  /** key = `${threadId}|${turnId}` */
  private textBatches = new Map<string, TextBatch>();
  /** Last-emitted (threadId → name) so we don't re-fire thread_focus on every update. */
  private lastFocusEmit = new Map<string, string | null>();
  /**
   * Last-emitted (threadId → status). Every `item/agentMessage/delta`
   * triggers `thread_updated` → `broadcast(thread_status)`; without this
   * dedup, a single streaming turn fires ~50 identical `thread_status`
   * events. Same pattern as `lastFocusEmit`.
   */
  private lastStatusEmit = new Map<string, ThreadStatus>();
  /** activeTurn watch: threadId → setTimeout handle. Fires turn_aborted if turn/completed never arrives. */
  private abortWatchers = new Map<string, NodeJS.Timeout>();
  private opts: Required<Omit<WsServerOptions, "state" | "internal" | "pet" | "expecting">> & {
    state: StateModel;
    internal: InternalClient;
    pet: PetMachine;
    expecting: ExpectingCodes;
  };

  constructor(opts: WsServerOptions) {
    this.opts = {
      port: opts.port ?? 48756,
      bindAddr: opts.bindAddr ?? "0.0.0.0",
      daemonVersion: opts.daemonVersion,
      petSpriteUrl: opts.petSpriteUrl ?? "/v1/pet/active.webp",
      petName: opts.petName ?? "plaipin",
      state: opts.state,
      internal: opts.internal,
      pet: opts.pet,
      expecting: opts.expecting,
      daemonId: opts.daemonId,
    };
  }

  async start(): Promise<void> {
    // Same listener serves: (1) WS upgrades for paired devices, (2) the
    // unauthenticated `POST /v1/devices/claim` endpoint for SoftAP-flow
    // devices redeeming a pairing code for a token. Routing happens by
    // method+path before the WS upgrade handler runs.
    this.server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/devices/claim") {
        this.handleDeviceClaim(req, res);
        return;
      }
      res.writeHead(404);
      res.end("plaipin");
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const ident = token ? verifyToken(token) : null;
      if (!ident || !token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      // X-PlaiPin-Nonce: per-device tokens require it so the welcome
      // can be MAC'd over (deviceId, nonce, daemonId). Bootstrap MAY
      // omit; those receive an unsigned welcome and skip verification.
      const nonceRaw = req.headers["x-plaipin-nonce"];
      let nonce: string | null = null;
      if (typeof nonceRaw === "string" && nonceRaw.length > 0) {
        if (!isValidNonce(nonceRaw)) {
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
          return;
        }
        nonce = nonceRaw;
      }
      if (ident.deviceId !== "bootstrap" && nonce === null) {
        log.warn(
          { deviceId: ident.deviceId },
          "per-device WS upgrade missing X-PlaiPin-Nonce; rejecting",
        );
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) =>
        this.onConnection(ws, ident.deviceId, token, nonce),
      );
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.bindAddr, () => {
        log.info(
          { addr: this.opts.bindAddr, port: this.opts.port },
          "ESP32 WS server listening",
        );
        resolve();
      });
    });

    this.subscribeStateModel();
    this.subscribePet();
    this.startRevokePoller();
  }

  async stop(): Promise<void> {
    if (this.revokePoller) {
      clearInterval(this.revokePoller);
      this.revokePoller = null;
    }
    for (const c of this.connections) c.socket.close();
    this.wss?.close();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  // ====================================================================
  // Revocation poller — emits HMAC-MAC'd `revoked` frames to active connections
  // ====================================================================

  private startRevokePoller(): void {
    this.revokePoller = setInterval(() => this.tickRevocations(), 1000);
    this.revokePoller.unref();
  }

  private tickRevocations(): void {
    if (this.connections.size === 0) return;
    // listDevices reads pairing.json fresh; cheap enough at 1Hz.
    const known = new Map(listDevices().map((d) => [d.deviceId, d]));
    for (const conn of [...this.connections]) {
      if (conn.deviceId === "bootstrap") continue;
      const entry = known.get(conn.deviceId);
      // Either explicit revocation, or the entry was deleted from
      // pairing.json (e.g., device removed via `device list --remove`).
      const revoked = entry === undefined || entry.revoked === true;
      if (!revoked) continue;
      const reason = entry === undefined ? "device-removed" : "operator-revoked";
      log.info({ deviceId: conn.deviceId, reason }, "revoking active connection");
      try {
        const mac = revokedMac(conn.bearerToken, conn.deviceId, reason);
        if (conn.socket.readyState === conn.socket.OPEN) {
          conn.socket.send(JSON.stringify({ type: "revoked", reason, mac }));
        }
      } catch (e) {
        log.warn({ err: e, deviceId: conn.deviceId }, "failed to send revoked frame");
      }
      try {
        conn.socket.close(1000, "revoked");
      } catch {
        /* socket may already be closing */
      }
      this.connections.delete(conn);
    }
  }

  // ====================================================================
  // /v1/devices/claim — LAN-facing pairing-code redemption
  // ====================================================================
  //
  // The device generates a 6-digit pairing code, displays it, and POSTs
  // here. The user types the same code into `plaipin device add`,
  // which long-polls `/v1/devices/expect` (loopback) — that registers
  // {code → deviceName} in this daemon's `expectingCodes` map. The
  // first daemon on the LAN that has a matching expect entry returns a
  // token; daemons without a matching code return 404 and the device
  // tries the next mDNS responder.
  //
  // Response shapes:
  //   - 200 { token, deviceId, daemonId, host, port } — match
  //   - 404 { error: "no_matching_code" }             — daemon doesn't have an expect entry for this code (device should try next mDNS candidate)
  //   - 429 { error: "rate_limited" }                 — per-source-IP rate limit (5/min)
  //   - 400 { error: "..." }                          — malformed body / fields
  //
  // Authentication: NONE. The device has no token yet. Trust comes from
  // the 6-digit code that the user typed into the CLI of their own Mac.
  // The trust model assumes a benign LAN; on adversarial networks, USB
  // pair is the supported path.

  private handleDeviceClaim(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const sourceIp = req.socket.remoteAddress ?? "unknown";
    /* Bound how long we'll wait for the request body. A misbehaving
     * (or malicious) LAN device that opens TCP and never sends a full body
     * would otherwise block on req.on('end',...) until the OS-level keepalive
     * gives up — minutes. 10 s is generous for a tiny JSON POST on LAN. */
    req.setTimeout(10_000, () => {
      log.warn({ sourceIp }, "device claim request timed out before body arrived");
      try {
        res.writeHead(408, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request_timeout" }));
      } catch {
        /* res may already be closed; nothing to do */
      }
      req.destroy();
    });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { pairingCode?: unknown; mac?: unknown; chip?: unknown; fwVersion?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (!isValidPairingCode(body.pairingCode)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_code_format" }));
        return;
      }
      const code = body.pairingCode;
      // Validate device identity fields. The CLI prints these in the
      // "Paired …" success line via the expect long-poll fulfilment;
      // empty / malformed values would render as "(unknown)" or break
      // logging cleanliness. Tight format checks: MAC is 17-char
      // colon-hex, chip is a non-empty short identifier, fwVersion is
      // non-empty + bounded.
      const mac = typeof body.mac === "string" ? body.mac : "";
      const chip = typeof body.chip === "string" ? body.chip : "";
      const fwVersion = typeof body.fwVersion === "string" ? body.fwVersion : "";
      if (!/^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/.test(mac)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_mac_format" }));
        return;
      }
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(chip)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_chip_format" }));
        return;
      }
      if (!/^[A-Za-z0-9_.+-]{1,32}$/.test(fwVersion)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_fw_format" }));
        return;
      }

      // The IP the device's claim landed on — guaranteed reachable from
      // the device's interface even on multi-homed Macs (where
      // `os.networkInterfaces()` may list addresses on subnets the
      // device can't route to). Persisted device-side as a warm-start
      // endpoint so subsequent boots can skip mDNS.
      const localHost = req.socket.localAddress ?? "";
      const localPort = this.opts.port;

      // Synchronous lookup against the expectingCodes map.
      // No long-poll on the device side: either the daemon has the entry
      // (200 + token) or it doesn't (404, device tries next mDNS responder).
      const result = this.opts.expecting.consume(code, { mac, chip, fwVersion, sourceIp });

      if (result.kind === "matched") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: result.token,
            deviceId: result.deviceName,
            daemonId: this.opts.daemonId,
            host: localHost,
            port: localPort,
          }),
        );
        log.info(
          { deviceId: result.deviceName, mac, sourceIp, host: localHost, port: localPort },
          "device claim matched + token issued",
        );
        return;
      }
      if (result.kind === "rate_limited") {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify({ error: "rate_limited" }));
        log.warn({ sourceIp }, "device claim rate-limited");
        return;
      }
      // no_match: daemon doesn't have an expect entry for this code.
      // Device should try the next mDNS responder.
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no_matching_code" }));
      log.info({ code, mac, sourceIp }, "device claim — no matching expect entry on this daemon");
    });
    req.on("error", () => {
      res.writeHead(500);
      res.end();
    });
  }

  // ====================================================================
  // Connection lifecycle
  // ====================================================================

  private onConnection(
    socket: WebSocket,
    deviceId: string,
    bearerToken: string,
    nonce: string | null,
  ): void {
    // Single-connection-per-device. When the same paired device reconnects
    // (after WiFi blip, reboot, DTR-induced reset on monitor attach, etc.),
    // close any existing connections under the same deviceId so the daemon
    // doesn't accumulate stale sockets until TCP keepalive notices (~2 min
    // on macOS). Bootstrap is exempted — it's a shared identity for tail
    // and any unpaired-token clients, multiple concurrent connections are
    // legitimate.
    if (deviceId !== "bootstrap") {
      for (const existing of this.connections) {
        if (existing.deviceId !== deviceId) continue;
        log.info(
          { deviceId },
          "closing prior WS connection (replaced by new connect)",
        );
        try {
          existing.socket.close(1001, "replaced");
        } catch {
          /* socket may already be in a half-closed state; the close handler
           * removes it from the set either way */
        }
        this.connections.delete(existing);
      }
    }

    const conn: DeviceConnection = {
      deviceId,
      socket,
      filters: new Set(["command_output_chunk"]), // off by default
      recentDecisions: new Map(),
      bearerToken,
      nonce,
    };
    this.connections.add(conn);
    log.info({ deviceId, total: this.connections.size }, "ESP32 connected");

    socket.on("message", (data) => this.onMessage(conn, data.toString("utf8")));
    socket.on("close", (code, reason) => {
      this.connections.delete(conn);
      log.info({ deviceId, code, reason: reason.toString(), total: this.connections.size }, "ESP32 disconnected");
    });
    socket.on("error", (err) => log.warn({ deviceId, err }, "ESP32 ws error"));

    // Send welcome snapshot (steady state, no transient overlay).
    this.send(conn, this.makeWelcome(conn));
    // One-shot greeting overlay — sent ONLY to this connecting device, not
    // broadcast. Earlier code emitted via `pet.emitTransient` which fans out
    // through the pet's `change` listener to every connected client, so a
    // tail-client connect would cause the ESP32 to wave again. Keep
    // greetings device-local.
    const cur = this.opts.pet.getCurrent();
    this.send(conn, {
      type: "pet_state",
      state: cur.state,
      transientState: "waving",
      holdMs: cur.holdMs,
      reason: `welcome ${deviceId}`,
    });
  }

  private onMessage(conn: DeviceConnection, raw: string): void {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw);
    } catch {
      log.warn({ deviceId: conn.deviceId, raw: raw.slice(0, 100) }, "ESP32 sent non-JSON");
      return;
    }
    switch (cmd.type) {
      case "ping":
        this.send(conn, { type: "pong", t: Date.now() });
        break;
      case "request_snapshot":
        this.send(conn, this.makeWelcome(conn));
        break;
      case "set_subscriptions":
        conn.filters = new Set(cmd.filters);
        break;
      case "set_focus":
        this.opts.state.pin(cmd.pin ? cmd.threadId : null);
        break;
      case "clear_focus":
        this.opts.state.pin(null);
        break;
      case "approval_decide":
        this.routeApproval(conn, cmd.id, cmd.decision);
        break;
      case "interrupt_turn":
        this.interrupt(cmd.threadId).catch((e) =>
          log.warn({ err: e }, "interrupt failed"),
        );
        break;
      case "hello":
        log.info({ deviceId: conn.deviceId, fwVersion: cmd.fwVersion }, "ESP32 hello");
        break;
      default: {
        const unknown = (cmd as { type: string }).type;
        log.warn({ deviceId: conn.deviceId, type: unknown }, "unknown ESP32 command");
      }
    }
  }

  private async interrupt(threadId: string): Promise<void> {
    const conv = this.opts.state.get(threadId);
    if (!conv?.activeTurn) return;
    await this.opts.internal.rpc.request("turn/interrupt", {
      threadId,
      turnId: conv.activeTurn.turnId,
    });
  }

  private routeApproval(conn: DeviceConnection, id: RequestId, decision: string): void {
    // Find which thread this approval belongs to (via state model)
    let threadId: string | null = null;
    let approvalMethod: string | null = null;
    for (const conv of this.opts.state.list()) {
      const a = conv.pendingApprovals.get(id);
      if (a) {
        threadId = conv.threadId;
        approvalMethod = a.method;
        break;
      }
    }
    if (!threadId || !approvalMethod) {
      log.warn({ deviceId: conn.deviceId, id }, "approval_decide for unknown id");
      return;
    }
    conn.recentDecisions.set(id, "self");
    // Build response payload according to approval kind
    const result = buildApprovalResult(approvalMethod, decision);
    try {
      this.opts.internal.rpc.respond(id, result);
      log.info({ deviceId: conn.deviceId, id, decision, threadId }, "approval injected");
    } catch (e) {
      log.warn({ err: e, id }, "respond failed");
    }
    // Eagerly fan out approval_resolved to all clients. For REAL approvals
    // the server will also emit serverRequest/resolved shortly; that arrives
    // as a notification on the internal client and calls
    // state.onServerRequestResolved again, which is idempotent (no-op if the
    // approval is already cleared). For SYNTHETIC approvals (injected via
    // `plaipin demo`), no real request exists in the app-server, so the
    // server won't emit anything — and this local synthesis is the only
    // source of resolution. The wire shape clients see is identical.
    this.opts.state.onServerRequestResolved({ threadId, requestId: id });
  }

  // ====================================================================
  // Subscribe to StateModel and broadcast translated events
  // ====================================================================

  private subscribeStateModel(): void {
    const s = this.opts.state;
    s.on("active_changed", (id) => {
      if (!id) return;
      const conv = s.get(id);
      if (!conv || conv.ephemeral) return;
      this.emitFocusIfChanged(conv.threadId, conv.name);
      this.emitStatusIfChanged(conv);
      this.opts.pet.evaluate(s.list());
    });
    s.on("thread_updated", (conv) => {
      // Suppress all wsServer traffic for ephemeral threads — they're
      // system-internal (auto-naming, compaction). Pet still recomputes
      // because list() filters ephemeral.
      if (conv.ephemeral) {
        this.opts.pet.evaluate(s.list());
        return;
      }
      this.emitStatusIfChanged(conv);
      // Re-emit thread_focus only if this is the active thread AND its
      // name actually changed (was null, now set, or rename).
      const activeId = this.opts.state.getActiveId();
      if (activeId === conv.threadId) {
        this.emitFocusIfChanged(conv.threadId, conv.name);
      }
      // Fix #4 (turn_aborted): if status went idle while a turn was still
      // marked active in the StateModel, the server stopped emitting for
      // it without firing turn/completed. Arm a 5s watcher; if turn doesn't
      // resume or complete by then, broadcast a synthetic aborted turn_done.
      if (conv.status === "idle" && conv.activeTurn) {
        this.armAbortWatcher(conv.threadId, conv.activeTurn.turnId);
      }
      this.opts.pet.evaluate(s.list());
    });
    s.on("approval_added", (threadId, a) => {
      this.broadcast({
        type: "approval_required",
        id: a.requestId,
        threadId,
        kind: APPROVAL_KIND_BY_METHOD[a.method] ?? "command",
        summary: summarizeApproval(a.method, a.params),
        details: { reason: (a.params as { reason?: string }).reason ?? null },
      });
      this.opts.pet.evaluate(s.list());
    });
    s.on("approval_resolved", (_threadId, requestId) => {
      // Determine "by"
      let by: "self" | "desktop" | "other" = "desktop";
      for (const c of this.connections) {
        if (c.recentDecisions.delete(requestId)) {
          by = "self";
          break;
        }
      }
      this.broadcast({ type: "approval_resolved", id: requestId, by });
      this.broadcastStats();
      this.opts.pet.evaluate(s.list());
    });
    s.on("turn_started", (threadId, turnId) => {
      this.cancelAbortWatcher(threadId);
      this.broadcast({ type: "turn_started", threadId, turnId });
    });
    s.on("turn_completed", (threadId, turnId, ok, durationMs) => {
      this.cancelAbortWatcher(threadId);
      // Flush any pending text for this turn before announcing done.
      this.flushBatch(`${threadId}|${turnId}`);
      this.broadcast({
        type: "turn_done",
        threadId,
        turnId,
        durationMs,
        summary: ok ? "completed" : "errored",
        ok,
      });
      this.broadcastStats();
    });
    s.on("item_started", (threadId, turnId, item) => {
      if (item.type === "commandExecution") {
        // Surface the real shell command + cwd from the protocol payload
        // (not item.id, which is just the internal call_xxx identifier).
        const cmd = item as unknown as { command?: string; cwd?: string };
        this.broadcast({
          type: "command_started",
          threadId,
          summary: cmd.command ?? item.id,
          cwd: cmd.cwd ?? null,
        });
      } else if (item.type === "userMessage") {
        // Smaller miss: surface the user's prompt for ESP32 context.
        const u = item as unknown as { content?: Array<{ text?: string }> };
        const text = (u.content ?? []).map((c) => c.text ?? "").join("").trim();
        if (text) this.broadcast({ type: "user_message", threadId, text });
      } else if (item.type === "agentMessage") {
        // Open a batch keyed by this message's itemId so subsequent
        // agent_text_delta events for it can be aggregated and tagged
        // with the right phase. See `TextBatch` doc.
        const m = item as unknown as { phase?: string | null };
        this.openBatch(threadId, turnId, item.id, normalizePhase(m.phase));
      } else if (isToolItemType(item.type)) {
        // Surface what the agent is doing during the long thinking phase.
        // Web search items often start with an empty `query`; the value
        // arrives in item/completed. Send what we have either way.
        this.broadcast({
          type: "tool_started",
          threadId,
          itemId: item.id,
          kind: item.type,
          label: extractToolLabel(item),
        });
      }
    });
    s.on("item_completed", (threadId, turnId, item) => {
      if (item.type === "commandExecution") {
        // exitCode lives on the item; surface the real value (not 0).
        const c = item as unknown as { exitCode?: number | null };
        this.broadcast({
          type: "command_done",
          threadId,
          exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
        });
      } else if (item.type === "agentMessage") {
        // Drain any remaining buffered tokens for this message, then
        // emit a single agent_text_done with the full final text as a
        // lossless backstop in case batched chunks were dropped.
        const phase = this.flushBatch(item.id);
        const m = item as unknown as { text?: string; phase?: string | null };
        const summary = clipOnWordBoundary(m.text ?? "", 280);
        this.broadcast({
          type: "agent_text_done",
          threadId,
          turnId,
          summary,
          phase: phase ?? normalizePhase(m.phase),
        });
        this.textBatches.delete(item.id);
      } else if (isToolItemType(item.type)) {
        this.broadcast({
          type: "tool_done",
          threadId,
          itemId: item.id,
          kind: item.type,
          label: extractToolLabel(item),
        });
      }
    });
    s.on("agent_text_delta", (threadId, turnId, itemId, delta) => {
      // Batch agent_text deltas rather than forwarding 1:1.
      this.appendToBatch(threadId, turnId, itemId, delta);
    });
    s.on("command_output_delta", (threadId, _turnId, _itemId, delta) => {
      for (const c of this.connections) {
        if (c.filters.has("command_output_chunk")) continue;
        this.send(c, { type: "command_output_chunk", threadId, text: delta });
      }
    });
    s.on("file_change_patch_updated", (threadId, _turnId, _itemId, _changes) => {
      this.broadcast({ type: "file_changed", threadId, summary: "patch updated" });
    });
    s.on("error", (threadId, p) => {
      this.broadcast({ type: "error", threadId, message: p.error.message });
    });
    s.on("thread_compacted", (threadId) => {
      const conv = s.get(threadId);
      if (conv?.ephemeral) return;
      this.broadcast({ type: "context_compacted", threadId });
    });
  }

  // --- focus dedup ---------------------------------------------------------

  private emitFocusIfChanged(threadId: string, name: string | null): void {
    if (this.lastFocusEmit.get(threadId) === name) return;
    this.lastFocusEmit.set(threadId, name);
    this.broadcast({ type: "thread_focus", threadId, name: WsServer.truncateName(name) });
  }

  private emitStatusIfChanged(conv: ConversationState): void {
    const status = conv.status as ThreadStatus;
    if (this.lastStatusEmit.get(conv.threadId) === status) return;
    this.lastStatusEmit.set(conv.threadId, status);
    this.broadcast({ type: "thread_status", threadId: conv.threadId, status });
  }

  // --- turn-aborted watcher ------------------------------------------------

  private static readonly TURN_ABORT_GRACE_MS = 5000;

  private armAbortWatcher(threadId: string, turnId: string): void {
    this.cancelAbortWatcher(threadId);
    const t = setTimeout(() => {
      this.abortWatchers.delete(threadId);
      // If we get here, turn/completed never arrived. Surface so ESP32
      // doesn't think the agent is still working forever.
      const conv = this.opts.state.get(threadId);
      // If the conv has since started a different turn or got a turn_done,
      // it's no longer "stuck"; skip.
      if (!conv || conv.activeTurn?.turnId === turnId) {
        // Still in flight from our model's perspective — but server stopped
        // emitting status. Treat as aborted.
        this.broadcast({ type: "turn_done", threadId, turnId, durationMs: 0, summary: "aborted", ok: false });
      }
    }, WsServer.TURN_ABORT_GRACE_MS);
    t.unref();
    this.abortWatchers.set(threadId, t);
  }

  private cancelAbortWatcher(threadId: string): void {
    const t = this.abortWatchers.get(threadId);
    if (t) {
      clearTimeout(t);
      this.abortWatchers.delete(threadId);
    }
  }

  // --- agent text batching -------------------------------------------------

  /**
   * Open a fresh batch for a newly-started agentMessage item. Captures
   * the message's `phase` so subsequent chunks can be tagged. Idempotent
   * — reopening for an itemId we already track is a no-op.
   */
  private openBatch(
    threadId: string,
    turnId: string,
    itemId: string,
    phase: MessagePhase | null,
  ): void {
    if (this.textBatches.has(itemId)) return;
    this.textBatches.set(itemId, {
      threadId,
      turnId,
      itemId,
      phase,
      buf: "",
      timer: null,
    });
  }

  private appendToBatch(threadId: string, turnId: string, itemId: string, delta: string): void {
    let b = this.textBatches.get(itemId);
    if (!b) {
      // Race: delta arrived before we processed item/started for this
      // message. Open a batch with phase unknown; the eventual
      // item/completed will carry the authoritative phase and replace
      // it on the agent_text_done event.
      b = { threadId, turnId, itemId, phase: null, buf: "", timer: null };
      this.textBatches.set(itemId, b);
    }
    b.buf += delta;
    if (Buffer.byteLength(b.buf, "utf8") >= TEXT_BATCH_MAX_BYTES) {
      this.flushBatch(itemId);
      return;
    }
    if (!b.timer) {
      b.timer = setTimeout(() => this.flushBatch(itemId), TEXT_BATCH_FLUSH_MS);
    }
  }

  /**
   * Drain the named batch's buffer to all subscribed devices and clear
   * the timer. Returns the batch's `phase` so the caller (item_completed
   * handler) can use it on the trailing agent_text_done.
   */
  private flushBatch(itemId: string): MessagePhase | null {
    const b = this.textBatches.get(itemId);
    if (!b) return null;
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    if (b.buf.length === 0) return b.phase;
    const text = b.buf;
    b.buf = "";
    for (const c of this.connections) {
      if (c.filters.has("agent_text_chunk")) continue;
      this.send(c, {
        type: "agent_text_chunk",
        threadId: b.threadId,
        turnId: b.turnId,
        text,
        phase: b.phase,
      });
    }
    return b.phase;
  }

  private subscribePet(): void {
    this.opts.pet.on(
      "change",
      (e: {
        state: PetState;
        transientState: TransientPetState | null;
        reason: string;
        holdMs: number;
      }) => {
        this.broadcast({
          type: "pet_state",
          state: e.state,
          transientState: e.transientState,
          holdMs: e.holdMs,
          reason: e.reason,
        });
      },
    );
  }

  private statsSummary(): StatsSummary {
    const g = this.opts.state.getGlobalStats();
    return {
      threadsTotal: g.threadsTotal,
      tokens: g.tokens,
      turnsStarted: g.turnsStarted,
      turnsCompleted: g.turnsCompleted,
      turnsErrored: g.turnsErrored,
      commandsStarted: g.commandsStarted,
      commandsCompleted: g.commandsCompleted,
      filesChanged: g.filesChanged,
      loc: g.loc,
      approvalsReceived: g.approvalsReceived,
      approvalsResolved: g.approvalsResolved,
      uptimeMs: g.uptimeMs,
    };
  }

  private broadcastStats(): void {
    this.broadcast({ type: "stats_updated", stats: this.statsSummary() });
  }

  // ====================================================================
  // Helpers
  // ====================================================================

  private statusEvent(conv: ConversationState): ServerEvent {
    return { type: "thread_status", threadId: conv.threadId, status: conv.status as ThreadStatus };
  }

  private makeWelcome(conn: DeviceConnection): ServerEvent {
    const s = this.opts.state;
    const active = s.getActive();
    const allConversations = s.list();
    const pendingApprovals: PendingApprovalSummary[] = [];
    for (const c of allConversations) {
      for (const a of c.pendingApprovals.values()) {
        pendingApprovals.push({
          id: a.requestId,
          threadId: c.threadId,
          kind: APPROVAL_KIND_BY_METHOD[a.method] ?? "command",
          summary: summarizeApproval(a.method, a.params),
          receivedAt: a.receivedAt,
        });
      }
    }
    const pet = this.opts.pet.getCurrent();
    const snapshot: Snapshot = {
      active: active ? this.toSummary(active) : null,
      threads: allConversations.slice(0, 10).map(this.toSummary),
      pendingApprovals,
      pet: {
        name: this.opts.petName,
        state: pet.state,
        // Welcome snapshot is the steady state. Greeting transients are
        // sent as a separate per-device pet_state right after welcome.
        transientState: null,
        holdMs: pet.holdMs,
        spriteUrl: this.opts.petSpriteUrl,
      },
      stats: this.statsSummary(),
    };
    const base = {
      type: "welcome" as const,
      v: ESP32_PROTOCOL_VERSION,
      daemonVersion: this.opts.daemonVersion,
      snapshot,
    };
    // Bootstrap connections receive an unsigned welcome (no nonce, no
    // mac). Per-device tokens always include daemonId + nonce + mac so
    // the device can verify the daemon at the other end of this WS
    // connection knows its per-device token.
    if (conn.deviceId === "bootstrap" || conn.nonce === null) {
      return base;
    }
    const daemonId = this.opts.daemonId;
    return {
      ...base,
      daemonId,
      nonce: conn.nonce,
      mac: welcomeMac(conn.bearerToken, conn.deviceId, conn.nonce, daemonId),
    };
  }

  /**
   * Cap thread names sent to ESP32 clients + strip markdown link syntax.
   *
   * Length cap: some Codex threads have multi-KB system-prompt-as-name
   * (e.g. when a user starts a session by pasting a long prompt).
   * Without truncation a snapshot with 10 threads can exceed 32 KB,
   * which fragments badly on ESP-IDF's WebSocket client. 80 chars is
   * plenty for a small-screen list view.
   *
   * Markdown stripping: Codex's auto-naming sometimes produces names
   * like "[$skill-installer](/Users/.../SKILL.md)". UART log handles
   * that fine; on a 240×240 display it would render literally with
   * brackets, parens, and a long absolute path. Replace `[label](url)`
   * with just `label` before truncation. Keeps emphasis (`**foo**`)
   * intact — those are short and the firmware can ignore them.
   */
  private static readonly MAX_NAME_BYTES = 80;
  private static readonly MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
  private static truncateName(name: string | null): string | null {
    if (!name) return name;
    const stripped = name.replace(WsServer.MARKDOWN_LINK_RE, "$1");
    if (stripped.length <= WsServer.MAX_NAME_BYTES) return stripped;
    return stripped.slice(0, WsServer.MAX_NAME_BYTES) + "…";
  }

  private toSummary = (c: ConversationState): ConversationSummary => {
    return {
      threadId: c.threadId,
      name: WsServer.truncateName(c.name),
      status: c.status as ThreadStatus,
    };
  };

  private send(conn: DeviceConnection, ev: ServerEvent): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify(ev));
  }

  private broadcast(ev: ServerEvent): void {
    const frame = JSON.stringify(ev);
    for (const c of this.connections) {
      // Per-event-type filter
      if (c.filters.has(ev.type)) continue;
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(frame);
    }
  }
}

/**
 * Validate the X-PlaiPin-Nonce header value: base64 string that
 * decodes to exactly 16 raw bytes. Reject empty / wrong-length nonces
 * before we're committed to the WS upgrade.
 */
function isValidNonce(s: string): boolean {
  // Accept standard or URL-safe base64. 16 raw bytes encodes to 24
  // chars including the 2 trailing `=` (or 22 without padding for
  // URL-safe). Be permissive about the form, strict about the byte
  // count after decoding.
  if (typeof s !== "string" || s.length === 0 || s.length > 32) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return false;
  try {
    const buf = Buffer.from(s, "base64");
    return buf.length === 16;
  } catch {
    return false;
  }
}

function summarizeApproval(method: string, params: unknown): string {
  const p = params as { command?: string; reason?: string; itemId?: string };
  if (method === "item/commandExecution/requestApproval") {
    return p.command ? p.command.slice(0, 200) : "command exec";
  }
  if (method === "item/fileChange/requestApproval") return "file change";
  if (method === "item/permissions/requestApproval") return p.reason ?? "permissions";
  if (method === "item/tool/requestUserInput") return p.reason ?? "tool input";
  return method;
}

function buildApprovalResult(method: string, decision: string): unknown {
  // The codex protocol's response envelope varies by approval kind, but for
  // "accept"/"decline" the field name is consistently `decision`.
  return { decision };
}

/**
 * Truncate `text` to at most `max` chars, breaking at the last whitespace
 * so we don't slice through a word like "for more than a thou…". If no
 * whitespace exists in the first `max` chars, falls back to a hard slice.
 * Adds an ellipsis only when truncation actually happened.
 */
/**
 * Coerce raw `phase` from a codex item payload into our typed
 * `MessagePhase | null`. Codex's schema explicitly says providers may
 * not emit phase consistently; treat unknown / missing as null.
 */
function normalizePhase(raw: unknown): MessagePhase | null {
  return raw === "commentary" || raw === "final_answer" ? raw : null;
}

/**
 * Item types we surface to the ESP32 as `tool_started` / `tool_done`.
 * Codex emits many other item types (commandExecution, agentMessage,
 * userMessage, fileChange, planImplementation, ...) which already have
 * dedicated events; this list is the agent's *internal* tool use.
 */
const TOOL_ITEM_TYPES = new Set(["webSearch", "reasoning", "mcpToolCall", "fileRead"]);

function isToolItemType(t: string): boolean {
  return TOOL_ITEM_TYPES.has(t);
}

/**
 * Best-effort short label for a tool item. webSearch carries `query`
 * which is the most user-visible. reasoning items rarely carry text
 * (we opt out of the deltas) so usually return null.
 */
function extractToolLabel(item: { type: string }): string | null {
  if (item.type === "webSearch") {
    const q = (item as { query?: unknown }).query;
    return typeof q === "string" && q.length > 0 ? q : null;
  }
  return null;
}

function clipOnWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastSpace = head.search(/\s\S*$/);
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return cut + "…";
}
