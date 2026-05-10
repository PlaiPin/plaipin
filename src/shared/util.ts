// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Shared helpers used across daemon and CLI:
//   - PATHS: canonical directory layout under PLAIPIN_HOME (~/.plaipin)
//   - ensureDirs: create the layout with 0700 perms
//   - resolveCodexBinary: where to find the bundled `codex` CLI
//   - shortJson: log-friendly truncation of arbitrary values
//
// PLAIPIN_HOME env var override exists for sandbox testing; in
// production it is always ~/.plaipin.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLAIPIN_HOME = process.env.PLAIPIN_HOME ?? join(homedir(), ".plaipin");

export const PATHS = {
  home: PLAIPIN_HOME,
  bin: join(PLAIPIN_HOME, "bin"),
  run: join(PLAIPIN_HOME, "run"),
  state: join(PLAIPIN_HOME, "state"),
  log: join(PLAIPIN_HOME, "log"),
  appServerSock: join(PLAIPIN_HOME, "run", "app-server.sock"),
  daemonLock: join(PLAIPIN_HOME, "run", "daemon.lock"),
  stateDb: join(PLAIPIN_HOME, "state", "state.db"),
  pairingFile: join(PLAIPIN_HOME, "state", "pairing.json"),
};

export function ensureDirs(): void {
  for (const p of [PATHS.home, PATHS.bin, PATHS.run, PATHS.state, PATHS.log]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 });
  }
}

export function resolveCodexBinary(): string {
  const env = process.env.PLAIPIN_REAL_CODEX;
  if (env && existsSync(env)) return env;
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(bundled)) return bundled;
  // last-ditch: $PATH (will throw if absent)
  return "codex";
}

export function shortJson(o: unknown, max = 200): string {
  const s = JSON.stringify(o);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
