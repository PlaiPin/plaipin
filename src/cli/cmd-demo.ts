// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Drives a synthetic Codex-style event sequence through the daemon's
// control HTTP plane. Lets the user verify notification + command paths
// without hooking Codex.app and without a real ESP32.
//
// Run `plaipin tail` in another terminal to watch the events fan out;
// run `plaipin approve <id> accept` to dismiss the synthetic approval
// (id is printed by this script when it injects the request).

import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

interface DemoOpts {
  host: string;
  port: string;
  scenario: string;
}

const SCENARIOS = ["basic", "approval"] as const;
type Scenario = (typeof SCENARIOS)[number];

export async function cmdDemo(opts: DemoOpts): Promise<void> {
  if (!SCENARIOS.includes(opts.scenario as Scenario)) {
    console.error(`unknown scenario "${opts.scenario}"; pick one of: ${SCENARIOS.join(", ")}`);
    process.exit(2);
  }

  const post = makePoster(opts.host, Number(opts.port));
  const ok = await healthCheck(opts.host, Number(opts.port));
  if (!ok) {
    console.error(
      `daemon control HTTP not reachable at http://${opts.host}:${opts.port}/v1/health\n` +
        `(make sure the daemon is running: 'node dist/daemon/index.js' or 'plaipin start')`,
    );
    process.exit(1);
  }

  const threadId = `demo-${Date.now().toString(36)}`;
  const turnId = `t-${Date.now().toString(36)}`;
  const itemId = `i-${Date.now().toString(36)}`;
  console.log(`scenario=${opts.scenario} threadId=${threadId} turnId=${turnId}`);

  if (opts.scenario === "basic") await scenarioBasic(post, threadId, turnId, itemId);
  if (opts.scenario === "approval") await scenarioApproval(post, threadId, turnId, itemId);

  console.log("\ndone. The events above were synthetic; the daemon's StateModel + WS broadcast");
  console.log("treated them exactly like real Codex events. Anything connected via WebSocket");
  console.log("(`plaipin tail`, fake-esp32 script, real ESP32) saw and reacted to them.");
}

async function scenarioBasic(
  post: Poster,
  threadId: string,
  turnId: string,
  itemId: string,
): Promise<void> {
  console.log("\n[1/6] thread/started");
  await post("inject", { kind: "notification", method: "thread/started", params: { threadId, thread: { id: threadId, name: "demo: lightweight" } } });
  await sleep(150);
  console.log("[2/6] turn/started");
  await post("inject", { kind: "notification", method: "turn/started", params: { threadId, turn: { id: turnId, status: "running" } } });
  await sleep(150);
  console.log("[3/6] item/started (agentMessage)");
  await post("inject", { kind: "notification", method: "item/started", params: { threadId, turnId, item: { id: itemId, type: "agentMessage" } } });
  console.log("[4/6] item/agentMessage/delta ×4");
  for (const piece of ["I'll start by ", "reading the file ", "to figure out ", "what's there."]) {
    await post("inject", { kind: "notification", method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: piece } });
    await sleep(180);
  }
  console.log("[5/6] item/completed");
  await post("inject", { kind: "notification", method: "item/completed", params: { threadId, turnId, item: { id: itemId, type: "agentMessage" } } });
  await sleep(150);
  console.log("[6/6] turn/completed");
  await post("inject", { kind: "notification", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}

async function scenarioApproval(
  post: Poster,
  threadId: string,
  turnId: string,
  itemId: string,
): Promise<void> {
  console.log("\n[1/5] thread/started");
  await post("inject", { kind: "notification", method: "thread/started", params: { threadId, thread: { id: threadId, name: "demo: approval" } } });
  await sleep(150);
  console.log("[2/5] turn/started");
  await post("inject", { kind: "notification", method: "turn/started", params: { threadId, turn: { id: turnId, status: "running" } } });
  await sleep(150);
  console.log("[3/5] item/started (commandExecution)");
  await post("inject", { kind: "notification", method: "item/started", params: { threadId, turnId, item: { id: itemId, type: "commandExecution" } } });
  await sleep(150);

  const approvalId = Math.floor(Math.random() * 100000);
  console.log(`[4/5] item/commandExecution/requestApproval id=${approvalId}`);
  await post("inject", {
    kind: "request",
    method: "item/commandExecution/requestApproval",
    id: approvalId,
    params: {
      threadId,
      turnId,
      itemId,
      command: "rm -rf /tmp/demo-cache",
      cwd: "/tmp",
      reason: "synthetic demo approval — safe to accept or decline from another terminal",
    },
  });
  console.log(`\nApproval is now pending. From another terminal:\n`);
  console.log(`    plaipin approve ${approvalId} accept`);
  console.log(`    (or 'decline'/'acceptForSession'/'cancel')\n`);
  console.log("Watching for resolution for 30s…");

  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const summary = await getJson(post.host, post.port, "/v1/health");
    // No direct way to query the approval; rely on user observation.
    await sleep(500);
    if (!summary) break;
  }

  console.log("[5/5] turn/completed (synthetic; whether or not the approval was actually answered)");
  await post("inject", { kind: "notification", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}

interface Poster {
  (path: string, body: unknown): Promise<void>;
  host: string;
  port: number;
}

function makePoster(host: string, port: number): Poster {
  const fn = async (path: string, body: unknown): Promise<void> => {
    const fullPath = path.startsWith("/") ? path : `/v1/test/${path}`;
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: host,
          port,
          path: fullPath,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`));
            } else {
              resolve();
            }
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  };
  // attach host/port for callers
  return Object.assign(fn, { host, port });
}

async function healthCheck(host: string, port: number): Promise<boolean> {
  try {
    const r = await getJson(host, port, "/v1/health");
    return Boolean(r && (r as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

function getJson(host: string, port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: host, port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });
}
