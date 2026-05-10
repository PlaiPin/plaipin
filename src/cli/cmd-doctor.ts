// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin doctor` — health check. Walks through the install/hook/daemon
// chain and reports ✓/✗ on each. Exits 0 if all pass, 1 otherwise.
//
// Known false negative: the "App-server socket" check uses PATHS.appServerSock
// which respects PLAIPIN_HOME from the *current shell*, not from the running
// daemon. Run from a shell where PLAIPIN_HOME is unset and the check looks
// at ~/.plaipin/run/... — fine if you installed normally.

import { existsSync, statSync, readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import WebSocket from "ws";
import { PATHS, resolveCodexBinary } from "../shared/util.js";
import { ensureBootstrapToken } from "../daemon/auth.js";
import { ok as okLine, fail as failLine, color, pln, spinner, printBrandLine } from "./style.js";

const PLIST = join(homedir(), "Library/LaunchAgents/com.plaipin.daemon.plist");
const CODEX_APP = "/Applications/Codex.app";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * Library-mode entry point: runs every check, prints results, returns
 * `true` iff all checks passed. Doesn't terminate the process.
 *
 * Used by `cmdSetup` so it can keep going after a failed health check
 * (the setup is mostly idempotent and partial pass is still useful).
 * The CLI-mode `cmdDoctor` wraps this and exits with the right code.
 */
export async function runDoctor(): Promise<boolean> {
  const spin = spinner("Running diagnostics …").start();
  const checks: Check[] = [];

  // 1. Codex installed
  const codex = resolveCodexBinary();
  if (existsSync(codex)) {
    let version = "?";
    try {
      version = execSync(`"${codex}" --version`).toString().trim();
    } catch (e) {
      version = `error: ${(e as Error).message}`;
    }
    checks.push({ name: "Codex binary", pass: true, detail: `${codex} (${version})` });
  } else {
    checks.push({ name: "Codex binary", pass: false, detail: `not found at ${codex}` });
  }

  // 2. Codex.app codesign
  if (existsSync(CODEX_APP)) {
    const cs = spawnSync("codesign", ["-dv", CODEX_APP], { encoding: "utf8" });
    const teamLine = (cs.stderr ?? "").split("\n").find((l) => l.includes("TeamIdentifier"));
    checks.push({
      name: "Codex.app codesign",
      pass: cs.status === 0,
      detail: teamLine?.trim() ?? "no team identifier line",
    });
  }

  // 3. Shim installed
  const shim = join(PATHS.bin, "codex-shim");
  if (existsSync(shim)) {
    checks.push({ name: "Shim installed", pass: true, detail: shim });
  } else {
    checks.push({ name: "Shim installed", pass: false, detail: `missing ${shim} (run: plaipin install)` });
  }

  // 4. Hook installed (Info.plist patched)
  if (existsSync(`${CODEX_APP}/Contents/Info.plist`)) {
    const out = spawnSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :LSEnvironment:CODEX_CLI_PATH", `${CODEX_APP}/Contents/Info.plist`],
      { encoding: "utf8" },
    );
    const path = (out.stdout ?? "").trim();
    if (path === shim) {
      checks.push({ name: "Codex.app hook", pass: true, detail: `LSEnvironment.CODEX_CLI_PATH = ${path}` });
    } else if (path) {
      checks.push({
        name: "Codex.app hook",
        pass: false,
        detail: `LSEnvironment.CODEX_CLI_PATH = ${path} (expected ${shim})`,
      });
    } else {
      checks.push({
        name: "Codex.app hook",
        pass: false,
        detail: "LSEnvironment.CODEX_CLI_PATH not set (run: plaipin hook-codex --enable)",
      });
    }
  }

  // 5. LaunchAgent installed
  if (existsSync(PLIST)) {
    checks.push({ name: "LaunchAgent installed", pass: true, detail: PLIST });
  } else {
    checks.push({ name: "LaunchAgent installed", pass: false, detail: `missing ${PLIST} (run: plaipin install)` });
  }

  // 6. Daemon running (via WS handshake)
  const wsCheck = await checkDaemonWs();
  checks.push(wsCheck);

  // 6b. Control HTTP plane (loopback 48757). Probes /v1/health and the
  // pairing-code expect endpoint via DELETE /v1/devices/expect/000000
  // (idempotent — returns 200 with {removed: false} when no such code
  // is registered). Catches the "LaunchAgent boot race" case where WS
  // is up but the control listener hasn't bound yet, plus confirms the
  // pairing endpoint is responsive.
  const ctrlChecks = await checkControlHttp();
  for (const c of ctrlChecks) checks.push(c);

  // 7. Daemon socket present
  if (existsSync(PATHS.appServerSock)) {
    const s = statSync(PATHS.appServerSock);
    checks.push({ name: "App-server socket", pass: true, detail: `${PATHS.appServerSock} (${s.mode.toString(8)})` });
  } else {
    checks.push({ name: "App-server socket", pass: false, detail: `missing ${PATHS.appServerSock}` });
  }

  // 8. Codex.app running?
  const ps = execSync(`pgrep -f "Contents/MacOS/Codex" || true`).toString().trim();
  checks.push({
    name: "Codex.app running",
    pass: ps.length > 0,
    detail: ps ? `pid(s): ${ps.replace(/\n/g, ",")}` : "not running (start it to verify hook)",
  });

  // Stop the spinner so per-check lines print clean (without the spinner
  // overwriting the last line via cursor-up). Then print the results.
  spin.stop();

  let allPass = true;
  let failCount = 0;
  for (const c of checks) {
    const namePad = c.name.padEnd(28);
    if (c.pass) {
      console.log(okLine(`${namePad} ${color.info(c.detail)}`));
    } else {
      allPass = false;
      failCount++;
      console.log(failLine(`${namePad} ${color.info(c.detail)}`));
    }
  }
  pln();
  if (allPass) {
    console.log(okLine(color.emphasis(`All ${checks.length} checks passed`)));
  } else {
    console.log(failLine(color.emphasis(
      `${failCount} of ${checks.length} checks failed`,
    )));
  }
  return allPass;

  // suppress unused lints
  void readFileSync;
  void net;
}

/** CLI-mode entry point. Runs the same checks but exits with 0/1. */
export async function cmdDoctor(): Promise<void> {
  printBrandLine("doctor");
  const passed = await runDoctor();
  process.exit(passed ? 0 : 1);
}

async function checkControlHttp(): Promise<Check[]> {
  const out: Check[] = [];
  const health = await probe("/v1/health");
  if (health.ok) {
    out.push({
      name: "Control HTTP /v1/health",
      pass: true,
      detail: `127.0.0.1:48757 reachable (daemonVersion=${health.body?.daemonVersion ?? "?"})`,
    });
  } else {
    out.push({
      name: "Control HTTP /v1/health",
      pass: false,
      detail: `${health.error ?? "unreachable"} (run: plaipin start)`,
    });
    // Skip the rendezvous probe if /v1/health failed — same daemon, no
    // point in pretending the second check is independent.
    return out;
  }
  // Probe the pairing endpoint via DELETE /v1/devices/expect/000000 —
  // idempotent, returns 200 with {removed: false} on a daemon with no
  // pending expect for code "000000" (the common case). Confirms the
  // loopback control plane has the endpoint wired in, without
  // triggering the long-poll path.
  const expectProbe = await probe("/v1/devices/expect/000000", "DELETE");
  if (expectProbe.ok) {
    out.push({
      name: "Pairing endpoint",
      pass: true,
      detail: `127.0.0.1:48757/v1/devices/expect OK`,
    });
  } else {
    out.push({
      name: "Pairing endpoint",
      pass: false,
      detail: expectProbe.error ?? "unreachable",
    });
  }
  return out;
}

interface ProbeResult {
  ok: boolean;
  body?: { daemonVersion?: string; devices?: unknown[]; [k: string]: unknown };
  error?: string;
}

function probe(path: string, method: "GET" | "DELETE" = "GET"): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 48757, path, method, timeout: 2000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${text.slice(0, 80)}` });
            return;
          }
          try {
            resolve({ ok: true, body: text ? JSON.parse(text) : {} });
          } catch (e) {
            resolve({ ok: false, error: `invalid JSON: ${(e as Error).message}` });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (e) => {
      const msg = (e as NodeJS.ErrnoException).code ?? e.message;
      resolve({ ok: false, error: msg });
    });
    req.end();
  });
}

async function checkDaemonWs(): Promise<Check> {
  const token = (() => {
    try {
      return ensureBootstrapToken();
    } catch {
      return null;
    }
  })();
  if (!token) {
    return { name: "Daemon WS", pass: false, detail: "no bootstrap token (daemon never run?)" };
  }
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:48756", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const t = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve({ name: "Daemon WS", pass: false, detail: "timeout (daemon not running?)" });
    }, 2000);
    ws.on("open", () => {
      clearTimeout(t);
      ws.close();
      resolve({ name: "Daemon WS", pass: true, detail: "ws://127.0.0.1:48756 reachable" });
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      resolve({ name: "Daemon WS", pass: false, detail: `${e.message}` });
    });
  });
}
