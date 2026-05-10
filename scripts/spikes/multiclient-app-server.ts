#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0
/**
 * Architectural spike: verify the codex app-server in unix:// listen mode.
 *
 * The app-server speaks WebSocket over the unix socket (URL
 * `ws://codex-app-server/rpc`, with a standard HTTP Upgrade handshake).
 * This script connects two WS clients directly to the unix socket and
 * verifies:
 *
 *   1. Both clients can `initialize` and get their own response.
 *   2. Notifications fan out to all clients (validates that an
 *      "internal client" can sit alongside Codex.app's wrapper client
 *      and observe everything).
 *   3. (Optional, if a thread exists) thread/list responses route only
 *      to the requesting client.
 *
 * If any of these fail, the daemon-as-app-server design needs revisiting.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import net from "node:net";
import WebSocket from "ws";

/**
 * Kill any leftover codex app-server pointing at the spike's socket.
 * Repeated spike runs can leak children if the parent was Ctrl-C'd
 * mid-spawn, since macOS has no PR_SET_PDEATHSIG equivalent.
 */
function reapPriorChildren(socket: string): void {
  const r = spawnSync("pgrep", ["-f", `app-server --listen unix://${socket}`], { encoding: "utf8" });
  if (r.status !== 0) return;
  for (const line of (r.stdout ?? "").split("\n")) {
    const pid = parseInt(line.trim(), 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
      console.error(`[spike] killed orphan ${pid}`);
    } catch {
      /* ignore */
    }
  }
}

class UnixAgent extends http.Agent {
  constructor(private readonly path: string) {
    super({ keepAlive: false });
  }
  override createConnection(_opts: unknown, cb: (e: Error | null, sock?: net.Socket) => void): net.Socket {
    return net.createConnection({ path: this.path }, () => cb(null));
  }
}

const CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const SPIKE_DIR = join(homedir(), ".plaipin-spike");
const SOCK_PATH = join(SPIKE_DIR, "app-server.sock");
const WS_HOST = "codex-app-server";
const WS_PATH = "/rpc";

interface RpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function fmt(o: unknown, max = 250): string {
  const s = JSON.stringify(o);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Open a WebSocket against a unix-domain-socket-listening server. The
 * standard `ws` constructor wants an HTTP agent; we give it one that
 * dials the unix socket. The Host header becomes the virtual hostname
 * the server expects (`codex-app-server`).
 */
function connectUnixWs(socketPath: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${WS_HOST}${WS_PATH}`, {
      agent: new UnixAgent(socketPath),
      headers: { Host: WS_HOST },
      perMessageDeflate: false,
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

class RpcClient {
  private nextId = 1;
  private pending = new Map<number | string, (msg: RpcMessage) => void>();
  public readonly notifications: RpcMessage[] = [];
  public readonly serverRequests: RpcMessage[] = [];
  private ws: WebSocket;

  static async open(label: string, socketPath: string): Promise<RpcClient> {
    const ws = await connectUnixWs(socketPath);
    return new RpcClient(label, ws);
  }

  private constructor(public readonly label: string, ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: WebSocket.RawData) => {
      const text = data.toString("utf8");
      // Some servers send NDJSON inside one frame, others one msg per frame.
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let msg: RpcMessage;
        try {
          msg = JSON.parse(t);
        } catch {
          console.error(`[${label}] non-JSON frame: ${t.slice(0, 200)}`);
          continue;
        }
        this.handle(msg);
      }
    });
    ws.on("close", (code, reason) => {
      console.error(`[${label}] WS closed code=${code} reason=${reason.toString()}`);
    });
    ws.on("error", (e) => console.error(`[${label}] WS error: ${e.message}`));
  }

  private handle(msg: RpcMessage) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg);
      } else {
        console.log(`[${this.label}] STRAY response id=${msg.id}: ${fmt(msg)}`);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.serverRequests.push(msg);
      console.log(`[${this.label}] SERVER REQUEST id=${msg.id} method=${msg.method}: ${fmt(msg.params)}`);
      return;
    }
    if (msg.method) {
      this.notifications.push(msg);
      console.log(`[${this.label}] NOTIFY method=${msg.method}: ${fmt(msg.params)}`);
      return;
    }
    console.log(`[${this.label}] OTHER: ${fmt(msg)}`);
  }

  async request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.ws.send(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Timeout ${method}#${id}`));
      }, 8_000);
    });
  }

  notify(method: string, params: unknown) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: number | string, result: unknown) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  reapPriorChildren(SOCK_PATH);
  if (existsSync(SPIKE_DIR)) rmSync(SPIKE_DIR, { recursive: true, force: true });
  mkdirSync(SPIKE_DIR, { recursive: true });

  console.log(`Spawning server: ${CODEX_BIN} app-server --listen unix://${SOCK_PATH}`);
  const server: ChildProcess = spawn(
    CODEX_BIN,
    ["app-server", "--listen", `unix://${SOCK_PATH}`, "--analytics-default-enabled"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, RUST_LOG: "warn" },
    }
  );
  server.stderr!.on("data", (b: Buffer) => {
    const s = b.toString();
    // Strip ANSI for readability and tag
    process.stderr.write(s.replace(/\x1b\[[0-9;]*m/g, "").replace(/^/gm, "[svr] "));
  });
  server.on("exit", (c, s) => console.error(`SERVER EXIT code=${c} sig=${s}`));

  for (let i = 0; i < 50; i++) {
    if (existsSync(SOCK_PATH)) break;
    await sleep(100);
  }
  if (!existsSync(SOCK_PATH)) {
    console.error("Socket never appeared");
    server.kill();
    process.exit(1);
  }
  console.log(`Socket: ${SOCK_PATH}`);

  const a = await RpcClient.open("A", SOCK_PATH);
  const b = await RpcClient.open("B", SOCK_PATH);
  await sleep(200);

  console.log("\n--- Step 1: initialize on A ---");
  const initA = await a.request("initialize", {
    clientInfo: { name: "plaipin-spike-a", title: "Spike A", version: "0.0.1" },
    capabilities: {},
  });
  console.log(`A init result: ${fmt(initA)}`);
  a.notify("initialized", {});

  console.log("\n--- Step 2: initialize on B ---");
  const initB = await b.request("initialize", {
    clientInfo: { name: "plaipin-spike-b", title: "Spike B", version: "0.0.1" },
    capabilities: {},
  });
  console.log(`B init result: ${fmt(initB)}`);
  b.notify("initialized", {});

  console.log("\n--- Step 3: thread/list from A (lightweight, no agent) ---");
  try {
    const list = await a.request("thread/list", { limit: 5 });
    console.log(`A thread/list: ${fmt(list, 400)}`);
  } catch (e: unknown) {
    console.error(`A thread/list error: ${(e as Error).message}`);
  }

  await sleep(1500);

  console.log("\n=== SUMMARY ===");
  console.log(`A notifications: ${a.notifications.length} | B notifications: ${b.notifications.length}`);
  console.log(`A server-requests: ${a.serverRequests.length} | B server-requests: ${b.serverRequests.length}`);
  console.log(`A notify methods: ${JSON.stringify(a.notifications.map((m) => m.method))}`);
  console.log(`B notify methods: ${JSON.stringify(b.notifications.map((m) => m.method))}`);

  a.close();
  b.close();
  server.kill();
  await sleep(300);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
