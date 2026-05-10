// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// JSON-RPC 2.0 client over WebSocket-over-Unix-domain-socket.
//   - Server: `codex app-server --listen unix://PATH`
//   - Handshake: GET /rpc HTTP/1.1, Host: codex-app-server,
//     Upgrade: websocket, no Sec-WebSocket-Extensions (deflate rejected).

import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";

export const WS_HOST = "codex-app-server";
export const WS_PATH = "/rpc";

export type RequestId = number | string;

export interface RpcRequest {
  jsonrpc?: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc?: "2.0";
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

class UnixHttpAgent extends http.Agent {
  constructor(private readonly socketPath: string) {
    super({ keepAlive: false });
  }
  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: import("node:stream").Duplex) => void,
  ): net.Socket {
    const sock: net.Socket = net.createConnection({ path: this.socketPath }, () => {
      callback?.(null, sock);
    });
    sock.on("error", (e) => callback?.(e, sock));
    return sock;
  }
}

export interface RpcClientOptions {
  /** Tag for log lines. */
  label?: string;
  /** Per-request timeout in ms. Default 10000. */
  requestTimeoutMs?: number;
}

/**
 * Connects to a codex app-server unix socket and provides JSON-RPC
 * request/response/notification primitives.
 *
 * Events emitted:
 *   - "request"   (msg: RpcRequest)         — server-initiated request that
 *                                             expects a response
 *   - "notification" (msg: RpcNotification) — server-initiated fire-and-forget
 *   - "open"
 *   - "close"  (code, reason)
 *   - "error"  (Error)
 */
export class RpcClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, (resp: RpcResponse) => void>();
  private requestTimeoutMs: number;
  public readonly label: string;

  constructor(opts: RpcClientOptions = {}) {
    super();
    this.label = opts.label ?? "rpc";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  }

  /**
   * Connect to a unix socket app-server. Resolves once WS handshake completes.
   */
  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${WS_HOST}${WS_PATH}`, {
        agent: new UnixHttpAgent(socketPath),
        headers: { Host: WS_HOST },
        perMessageDeflate: false,
      });
      this.ws = ws;
      ws.once("open", () => {
        this.emit("open");
        resolve();
      });
      ws.once("error", (err) => {
        reject(err);
      });
      ws.on("error", (err) => this.emit("error", err));
      ws.on("close", (code, reason) => this.emit("close", code, reason.toString()));
      ws.on("message", (data: RawData) => this.handleData(data));
    });
  }

  private handleData(data: RawData) {
    const text = typeof data === "string" ? data : data.toString("utf8");
    // Defensive: a frame may carry one JSON object, or in theory NDJSON.
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(t);
      } catch {
        this.emit("error", new Error(`[${this.label}] non-JSON frame: ${t.slice(0, 200)}`));
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage) {
    if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg as RpcResponse);
      }
      return;
    }
    if ("method" in msg && "id" in msg && msg.id !== undefined) {
      this.emit("request", msg as RpcRequest);
      return;
    }
    if ("method" in msg) {
      this.emit("notification", msg as RpcNotification);
      return;
    }
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`[${this.label}] not connected`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`[${this.label}] timeout: ${method}#${id}`));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        if (resp.error) {
          reject(
            Object.assign(new Error(`[${this.label}] ${method}: ${resp.error.message}`), {
              rpcError: resp.error,
            }),
          );
          return;
        }
        resolve(resp.result as T);
      });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: unknown): void {
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /**
   * Send a JSON-RPC response to a server-initiated request.
   * Used for ESP32-injected approval decisions.
   */
  respond(id: RequestId, result: unknown): void {
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: RequestId, error: { code: number; message: string; data?: unknown }): void {
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, error }));
  }

  close(): void {
    this.ws?.close();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
