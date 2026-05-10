// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Patch (or unpatch) /Applications/Codex.app/Contents/Info.plist with
// LSEnvironment.CODEX_CLI_PATH pointing to our shim, then ad-hoc re-sign.
//
// macOS 13+ requires "App Management" privacy permission for the parent
// process (Terminal/iTerm/etc.) to modify other apps' bundles in
// /Applications/. If that's not granted, PlistBuddy and codesign fail
// with "Operation not permitted". We detect that and bail without
// leaving the system in a half-patched state.

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../shared/util.js";

const CODEX_APP = "/Applications/Codex.app";
const INFO_PLIST = join(CODEX_APP, "Contents/Info.plist");
const SHIM_PATH = join(PATHS.bin, "codex-shim");
const BACKUP_INFO_PLIST = join(PATHS.state, "Info.plist.original");

interface HookOpts {
  enable?: boolean;
  disable?: boolean;
}

export async function cmdHookCodex(opts: HookOpts): Promise<void> {
  if (!existsSync(CODEX_APP)) fail(`${CODEX_APP} not found`);
  if (!existsSync(INFO_PLIST)) fail(`${INFO_PLIST} not found`);
  if (opts.enable === opts.disable) fail("specify exactly one of --enable / --disable");
  if (opts.enable) {
    enableHook();
  } else {
    disableHook();
  }
}

function enableHook(): void {
  if (!existsSync(SHIM_PATH)) {
    fail(`shim not installed at ${SHIM_PATH}; run: plaipin install`);
  }

  // Backup Info.plist if we don't already have one. We make the backup BEFORE
  // any write attempts so disableHook() can always restore. If we then fail
  // mid-patch, we delete the backup so we don't lie about hook state to the
  // doctor command (which checks for Info.plist:LSEnvironment:CODEX_CLI_PATH
  // — not the backup file).
  const createdBackupThisRun = !existsSync(BACKUP_INFO_PLIST);
  if (createdBackupThisRun) {
    copyFileSync(INFO_PLIST, BACKUP_INFO_PLIST);
    console.log(`=> Backup → ${BACKUP_INFO_PLIST}`);
  }

  // Helper: run PlistBuddy capturing stderr so we can detect TCC denial.
  const plistbuddy = (cmd: string): { ok: boolean; stderr: string } => {
    const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", cmd, INFO_PLIST], { encoding: "utf8" });
    return { ok: r.status === 0, stderr: (r.stderr ?? "").trim() };
  };

  // Idempotent delete (may legitimately fail if key absent — ignore that)
  plistbuddy("Delete :LSEnvironment");

  console.log(`=> Setting LSEnvironment.CODEX_CLI_PATH = ${SHIM_PATH}`);
  const addDict = plistbuddy("Add :LSEnvironment dict");
  if (!addDict.ok && /Operation not permitted/i.test(addDict.stderr)) {
    return abortAndCleanup(createdBackupThisRun, addDict.stderr, "PlistBuddy");
  }
  if (!addDict.ok && !/already exists/i.test(addDict.stderr)) {
    return abortAndCleanup(createdBackupThisRun, addDict.stderr, "PlistBuddy");
  }
  const addKey = plistbuddy(`Add :LSEnvironment:CODEX_CLI_PATH string ${SHIM_PATH}`);
  if (!addKey.ok) {
    return abortAndCleanup(createdBackupThisRun, addKey.stderr, "PlistBuddy");
  }

  // Ad-hoc re-sign to keep Gatekeeper happy.
  console.log("=> Re-signing (ad-hoc)…");
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", CODEX_APP], {
    encoding: "utf8",
  });
  if (sign.status !== 0) {
    if (/Operation not permitted/i.test(sign.stderr ?? "")) {
      return abortAndCleanup(createdBackupThisRun, sign.stderr ?? "", "codesign");
    }
    console.warn("WARNING: codesign returned non-zero. Codex.app may show a Gatekeeper prompt:");
    if (sign.stderr) console.warn(sign.stderr.trim());
  }

  console.log("");
  console.log("Hook installed. Quit and reopen Codex.app for the change to take effect.");
  console.log("(Gatekeeper may prompt to re-approve once.)");
}

/**
 * The patch failed partway through (most commonly: TCC App Management
 * denial). Restore the bundle to its pre-plaipin state and remove the
 * backup we just created so doctor reports an honest "not hooked" state.
 */
function abortAndCleanup(createdBackupThisRun: boolean, stderr: string, tool: string): void {
  console.error("");
  console.error(`hook-codex: ${tool} failed: ${stderr.split("\n")[0] || "unknown error"}`);

  // Best-effort: try to restore from backup. If we couldn't write to the file
  // before, we can't write to it now either, but if some keys partially
  // applied we want to at least try.
  if (existsSync(BACKUP_INFO_PLIST)) {
    try {
      copyFileSync(BACKUP_INFO_PLIST, INFO_PLIST);
      console.error(`hook-codex: restored Info.plist from backup`);
    } catch (e) {
      console.error(`hook-codex: could not restore Info.plist (${(e as Error).message})`);
      console.error(`hook-codex: backup is at ${BACKUP_INFO_PLIST} for manual recovery`);
    }
  }

  // If we made the backup THIS run and the patch never took effect, remove it
  // so disable/uninstall don't think we hooked anything.
  if (createdBackupThisRun && existsSync(BACKUP_INFO_PLIST)) {
    try {
      unlinkSync(BACKUP_INFO_PLIST);
    } catch {
      /* ignore */
    }
  }

  if (/Operation not permitted/i.test(stderr)) {
    printAppManagementHelp();
  }
  process.exit(3);
}

function printAppManagementHelp(): void {
  console.error("");
  console.error("──────────────────────────────────────────────────────────────────────────────");
  console.error(" macOS App Management privacy permission required");
  console.error("──────────────────────────────────────────────────────────────────────────────");
  console.error(" macOS 13+ blocks one app from modifying another app's bundle in");
  console.error(" /Applications/ unless your terminal has 'App Management' permission.");
  console.error("");
  console.error(" Fix:");
  console.error("   1. System Settings  →  Privacy & Security  →  App Management");
  console.error("   2. Click + and add Terminal.app (or iTerm.app — whichever runs `node`)");
  console.error("   3. Quit and re-open that terminal app fully");
  console.error("   4. Re-run:  plaipin hook-codex --enable");
  console.error("");
  console.error(" If your Codex.app was installed from the App Store it cannot be patched");
  console.error(" at all (App Store apps are protected even with permission). Check:");
  console.error("   mdls -name kMDItemAppStoreReceiptURL /Applications/Codex.app");
  console.error("──────────────────────────────────────────────────────────────────────────────");
}

function disableHook(): void {
  if (existsSync(BACKUP_INFO_PLIST)) {
    console.log(`=> Restoring Info.plist from backup ${BACKUP_INFO_PLIST}`);
    try {
      copyFileSync(BACKUP_INFO_PLIST, INFO_PLIST);
    } catch (e) {
      if (/Operation not permitted/i.test((e as Error).message)) {
        console.error(`hook-codex: cannot write to ${INFO_PLIST}: ${(e as Error).message}`);
        printAppManagementHelp();
        process.exit(3);
      }
      throw e;
    }
  } else {
    console.log("=> No backup found; removing LSEnvironment.CODEX_CLI_PATH");
    const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Delete :LSEnvironment:CODEX_CLI_PATH", INFO_PLIST], {
      encoding: "utf8",
    });
    if (r.status !== 0 && /Operation not permitted/i.test(r.stderr ?? "")) {
      console.error(`hook-codex: PlistBuddy: ${(r.stderr ?? "").trim()}`);
      printAppManagementHelp();
      process.exit(3);
    }
  }
  console.log("=> Re-signing (ad-hoc)…");
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", CODEX_APP], { encoding: "utf8" });
  if (sign.status !== 0) {
    if (/Operation not permitted/i.test(sign.stderr ?? "")) {
      printAppManagementHelp();
      process.exit(3);
    }
    console.warn("WARNING: codesign returned non-zero:");
    if (sign.stderr) console.warn(sign.stderr.trim());
  }
  console.log("Hook removed. Quit and reopen Codex.app.");
}

function fail(msg: string): never {
  console.error(`hook-codex: ${msg}`);
  process.exit(2);
}
