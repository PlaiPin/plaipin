// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin start | stop | restart | status` — thin wrappers over launchctl
// against the LaunchAgent plist that `plaipin install` wrote. Bails out
// with a friendly hint if the plist isn't there yet.
//
// We always run `launchctl enable gui/<uid>/<label>` before load. macOS
// launchd persists an explicit "disabled" override that can stick around
// after a failed unload/bootout, and `launchctl load -w` doesn't always
// clear it reliably. The explicit enable is idempotent and harmless when
// the label is already enabled, so it's safe to do unconditionally.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { ok, fail, color } from "./style.js";

const PLIST = join(homedir(), "Library/LaunchAgents/com.plaipin.daemon.plist");
const LABEL = "com.plaipin.daemon";

function ensurePlist(): void {
  if (!existsSync(PLIST)) {
    console.error(fail(`LaunchAgent not installed at ${color.pathlike(PLIST)}.`));
    console.error(fail("Run " + color.action("plaipin install") + " first."));
    process.exit(2);
  }
}

export function cmdStart(): void {
  ensurePlist();
  enableLabel();
  execSync(`launchctl load -w "${PLIST}"`, { stdio: "inherit" });
  console.log(ok("daemon started"));
}

/**
 * Idempotent: clears any persistent "disabled" override. Safe to call
 * even if the label is already enabled or never seen.
 */
function enableLabel(): void {
  try {
    execSync(`launchctl enable gui/${userInfo().uid}/${LABEL}`, { stdio: "ignore" });
  } catch {
    // older macOS or unusual launchd state — ignore; load -w will try too
  }
}

export function cmdStop(): void {
  ensurePlist();
  try {
    execSync(`launchctl unload -w "${PLIST}"`, { stdio: "inherit" });
  } catch {
    // already stopped
  }
  console.log(ok("daemon stopped"));
}

export function cmdRestart(): void {
  cmdStop();
  cmdStart();
}

export function cmdStatus(): void {
  ensurePlist();
  try {
    const out = execSync(`launchctl list | grep ${LABEL} || true`).toString().trim();
    if (!out) {
      console.log(fail("daemon not running"));
      process.exit(1);
    }
    console.log(ok(`daemon running ${color.info(`(${out})`)}`));
  } catch (e) {
    console.error(fail(`status check failed: ${(e as Error).message}`));
    process.exit(1);
  }
}
