// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Spawns and supervises the bundled `codex app-server --listen unix://PATH`
// child process. Owns its lifecycle. The internal client connects to the
// resulting socket; Codex.app's wrapper invocations (via codex-shim) also
// connect as additional clients to the same socket.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { PATHS, resolveCodexBinary } from "../shared/util.js";
import pino from "pino";

const log = pino({
  level: process.env.PLAIPIN_LOG_LEVEL ?? "info",
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
    : undefined,
});

export interface AppServerOptions {
  socketPath?: string;
  /** Args appended to `app-server`. Default mirrors what Codex.app passes. */
  extraArgs?: string[];
  /** RUST_LOG override for the child. Default "warn". */
  rustLog?: string;
  /** ms to wait for socket file before erroring. */
  startupTimeoutMs?: number;
}

/**
 * Manages a child `codex app-server` process. Restarts on crash with backoff.
 * Emits:
 *   - "ready"  () — socket file appeared
 *   - "exit"   (code, signal)
 *   - "log"    (stream: 'stderr', line: string)
 */
export class AppServer extends EventEmitter {
  private child: ChildProcess | null = null;
  private socketPath: string;
  private extraArgs: string[];
  private rustLog: string;
  private startupTimeoutMs: number;
  private codexBin: string;
  private restartCount = 0;
  private lastRestartAt = 0;
  private shuttingDown = false;

  constructor(opts: AppServerOptions = {}) {
    super();
    this.socketPath = opts.socketPath ?? PATHS.appServerSock;
    this.extraArgs = opts.extraArgs ?? ["--analytics-default-enabled"];
    this.rustLog = opts.rustLog ?? process.env.RUST_LOG ?? "warn";
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 5000;
    this.codexBin = resolveCodexBinary();
  }

  get socket(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    // Kill any orphan codex app-server pointing at OUR socket from a
    // previous daemon run. macOS has no PR_SET_PDEATHSIG, so when we
    // crash or get SIGKILL'd, the child becomes init's. Since we know
    // the exact socket path, we can identify our orphans precisely
    // (without affecting unrelated codex CLI processes).
    this.killOrphans();

    // Stale socket from previous run?
    if (existsSync(this.socketPath)) {
      log.warn({ socket: this.socketPath }, "removing stale socket");
      try {
        rmSync(this.socketPath);
      } catch (e) {
        log.error({ err: e }, "failed to remove stale socket");
      }
    }

    log.info(
      { codex: this.codexBin, socket: this.socketPath, extraArgs: this.extraArgs },
      "spawning codex app-server",
    );

    this.child = spawn(
      this.codexBin,
      ["app-server", "--listen", `unix://${this.socketPath}`, ...this.extraArgs],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, RUST_LOG: this.rustLog },
      },
    );

    let stderrBuf = "";
    this.child.stderr!.on("data", (b: Buffer) => {
      stderrBuf += b.toString();
      let idx;
      while ((idx = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, idx).replace(/\x1b\[[0-9;]*m/g, "");
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.trim()) this.emit("log", "stderr", line);
      }
    });

    this.child.on("exit", (code, signal) => {
      log.warn({ code, signal }, "codex app-server exited");
      this.emit("exit", code, signal);
      this.child = null;
      if (!this.shuttingDown) this.scheduleRestart();
    });

    // Wait for socket to appear
    const start = Date.now();
    while (Date.now() - start < this.startupTimeoutMs) {
      if (existsSync(this.socketPath)) {
        log.info({ socket: this.socketPath, ms: Date.now() - start }, "app-server socket ready");
        this.emit("ready");
        return;
      }
      await sleep(50);
    }
    throw new Error(
      `codex app-server did not create socket ${this.socketPath} within ${this.startupTimeoutMs}ms`,
    );
  }

  private async scheduleRestart() {
    const now = Date.now();
    if (now - this.lastRestartAt < 60_000) {
      this.restartCount++;
    } else {
      this.restartCount = 1;
    }
    this.lastRestartAt = now;
    if (this.restartCount > 5) {
      log.error({ restartCount: this.restartCount }, "too many restarts in 60s; giving up");
      this.emit("crashloop");
      return;
    }
    const backoffMs = Math.min(1000 * 2 ** (this.restartCount - 1), 30_000);
    log.warn({ backoffMs, attempt: this.restartCount }, "restarting app-server");
    await sleep(backoffMs);
    if (!this.shuttingDown) {
      try {
        await this.start();
      } catch (e) {
        log.error({ err: e }, "restart failed");
      }
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (!this.child) return;
    const c = this.child;
    return new Promise((resolve) => {
      c.once("exit", () => resolve());
      c.kill("SIGTERM");
      // Hard kill after 3s
      setTimeout(() => c.kill("SIGKILL"), 3000).unref();
    });
  }

  /**
   * Find any codex app-server process whose argv references THIS daemon's
   * socket path and kill it. Survival mode: covers the case where the
   * previous daemon was SIGKILL'd or otherwise died without cleaning up.
   *
   * We match precisely on the full socket path so we don't touch unrelated
   * codex children (Codex.app's own bundled-binary spawn, sandbox spawns
   * with different PLAIPIN_HOMEs, etc.).
   */
  private killOrphans(): void {
    try {
      // pgrep -f matches against the full command line. The pattern is the
      // exact `--listen unix://<socket>` string we'd pass to spawn.
      const needle = `app-server --listen unix://${this.socketPath}`;
      const r = spawnSync("pgrep", ["-f", needle], { encoding: "utf8" });
      if (r.status !== 0) return; // none found
      const pids = (r.stdout ?? "")
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
          log.warn({ pid, socket: this.socketPath }, "killed orphan codex app-server");
        } catch (e) {
          log.warn({ pid, err: (e as Error).message }, "failed to kill orphan");
        }
      }
      // Give the kernel a beat to release the socket file before we re-bind.
      if (pids.length > 0) {
        const start = Date.now();
        while (Date.now() - start < 500 && existsSync(this.socketPath)) {
          // sync wait — short, only on cleanup path
          spawnSync("sleep", ["0.05"]);
        }
      }
    } catch (e) {
      log.debug({ err: (e as Error).message }, "killOrphans skipped");
    }
  }
}
