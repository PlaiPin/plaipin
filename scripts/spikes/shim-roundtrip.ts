#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0
/**
 * Architectural spike: end-to-end shim → daemon → app-server roundtrip.
 *
 *   1. Start the daemon in an isolated PLAIPIN_HOME.
 *   2. Spawn `codex-shim app-server --analytics-default-enabled` as a child
 *      (simulating Codex.app's spawn). The shim should redirect to
 *      `codex app-server proxy --sock <daemon's sock>`.
 *   3. Send `initialize` over the proxy's stdio.
 *   4. Verify a response comes back (proxy correctly bridges WS↔stdio).
 *
 * Confirms the proxy subcommand works when driven by a Node child
 * process pipe — the same shape Codex.app's Electron main uses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";

const HOME = "/tmp/plaipin-roundtrip";
const SHIM = join(process.cwd(), "shim/codex-shim.sh");
const DAEMON_ENTRY = join(process.cwd(), "src/daemon/index.ts");

function killTree(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
}

async function main() {
  if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });

  console.log("=== Step 1: spawn daemon ===");
  const daemon = spawn("npx", ["tsx", DAEMON_ENTRY], {
    env: { ...process.env, PLAIPIN_HOME: HOME, PLAIPIN_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (b: Buffer) => process.stderr.write(`[daemon] ${b}`));
  daemon.stderr.on("data", (b: Buffer) => process.stderr.write(`[daemon e] ${b}`));
  daemon.on("exit", (c, s) => console.error(`[daemon] exited ${c}/${s}`));

  // Wait for daemon to be ready
  const sock = join(HOME, "run/app-server.sock");
  for (let i = 0; i < 50; i++) {
    if (existsSync(sock)) break;
    await sleep(100);
  }
  if (!existsSync(sock)) {
    console.error("daemon never created socket");
    killTree(daemon.pid!);
    process.exit(1);
  }
  console.log(`Socket: ${sock}`);
  await sleep(500); // give internal client time to initialize

  console.log("\n=== Step 2: spawn fake Codex.app via shim ===");
  const fakeCodex: ChildProcess = spawn(SHIM, ["app-server", "--analytics-default-enabled"], {
    env: { ...process.env, PLAIPIN_HOME: HOME },
    stdio: ["pipe", "pipe", "pipe"],
  });
  fakeCodex.stderr!.on("data", (b: Buffer) => process.stderr.write(`[shim e] ${b}`));
  fakeCodex.on("exit", (c, s) => console.error(`[shim] exited ${c}/${s}`));

  const responses: string[] = [];
  let buf = "";
  fakeCodex.stdout!.on("data", (b: Buffer) => {
    const text = b.toString();
    process.stderr.write(`[shim raw stdout ${b.length}B] ${JSON.stringify(text.slice(0, 200))}\n`);
    buf += text;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) responses.push(line);
    }
  });

  await sleep(500); // give proxy time to connect
  console.log("\n=== Step 3: send initialize via shim's stdin ===");
  fakeCodex.stdin!.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "fake-codex", title: "Fake Codex", version: "0.0.1" },
        capabilities: {},
      },
    }) + "\n",
  );

  await sleep(2000);

  console.log("\n=== RESULTS ===");
  console.log(`Responses captured: ${responses.length}`);
  for (const r of responses) {
    try {
      const parsed = JSON.parse(r);
      console.log(`  → ${JSON.stringify(parsed).slice(0, 250)}`);
    } catch {
      console.log(`  raw: ${r.slice(0, 200)}`);
    }
  }

  // Cleanup
  fakeCodex.kill();
  await sleep(200);
  killTree(daemon.pid!);
  await sleep(500);
  killTree(daemon.pid!);
  process.exit(responses.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
