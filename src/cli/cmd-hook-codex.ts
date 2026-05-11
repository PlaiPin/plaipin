// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Patch (or unpatch) /Applications/Codex.app/Contents/Info.plist with
// LSEnvironment.CODEX_CLI_PATH pointing to our shim, then ad-hoc re-sign.
//
// We only ever read or write the one key we own (:LSEnvironment:CODEX_CLI_PATH).
// Snapshotting and restoring the whole Info.plist would clobber Codex-owned
// data — most importantly ElectronAsarIntegrity, whose hash is updated by
// Codex's auto-updater every time app.asar changes. Restoring a stale
// snapshot causes Electron's asar integrity check to fail at launch.
//
// macOS 13+ requires "App Management" privacy permission for the parent
// process (Terminal/iTerm/etc.) to modify other apps' bundles in
// /Applications/. If that's not granted, PlistBuddy and codesign fail
// with "Operation not permitted". We detect that and bail without
// leaving the system in a half-patched state.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../shared/util.js";

const CODEX_APP = "/Applications/Codex.app";
const INFO_PLIST = join(CODEX_APP, "Contents/Info.plist");
const SHIM_PATH = join(PATHS.bin, "codex-shim");

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

  // Helper: run PlistBuddy capturing stderr so we can detect TCC denial.
  const plistbuddy = (cmd: string): { ok: boolean; stderr: string } => {
    const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", cmd, INFO_PLIST], { encoding: "utf8" });
    return { ok: r.status === 0, stderr: (r.stderr ?? "").trim() };
  };

  console.log(`=> Setting LSEnvironment.CODEX_CLI_PATH = ${SHIM_PATH}`);

  // Idempotent: drop only our own key first so the Add below always works,
  // even on a partially-patched plist. Ignore "Does Not Exist" — bail on TCC.
  const delKey = plistbuddy("Delete :LSEnvironment:CODEX_CLI_PATH");
  if (!delKey.ok && /Operation not permitted/i.test(delKey.stderr)) {
    return abortAndCleanup(delKey.stderr, "PlistBuddy");
  }

  // Add the parent dict if it doesn't already exist. We must not touch any
  // other keys inside LSEnvironment — they may belong to Codex or the user.
  const addDict = plistbuddy("Add :LSEnvironment dict");
  if (!addDict.ok && /Operation not permitted/i.test(addDict.stderr)) {
    return abortAndCleanup(addDict.stderr, "PlistBuddy");
  }
  if (!addDict.ok && !/already exists/i.test(addDict.stderr)) {
    return abortAndCleanup(addDict.stderr, "PlistBuddy");
  }

  const addKey = plistbuddy(`Add :LSEnvironment:CODEX_CLI_PATH string ${SHIM_PATH}`);
  if (!addKey.ok) {
    return abortAndCleanup(addKey.stderr, "PlistBuddy");
  }

  // Ad-hoc re-sign the outer bundle. No --deep: editing Info.plist only
  // invalidates the bundle's own signature, not the nested helpers/framework.
  console.log("=> Re-signing (ad-hoc)…");
  const sign = spawnSync("codesign", ["--force", "--sign", "-", CODEX_APP], {
    encoding: "utf8",
  });
  if (sign.status !== 0) {
    if (/Operation not permitted/i.test(sign.stderr ?? "")) {
      return abortAndCleanup(sign.stderr ?? "", "codesign");
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
 * denial). Best-effort: try to remove our key so the bundle isn't left
 * in a half-patched state. If the failure was TCC we won't have write
 * access anyway — print the App Management help so the user can fix it.
 */
function abortAndCleanup(stderr: string, tool: string): void {
  console.error("");
  console.error(`hook-codex: ${tool} failed: ${stderr.split("\n")[0] || "unknown error"}`);

  // Best-effort surgical undo. If TCC denied us before, it'll deny us now.
  spawnSync("/usr/libexec/PlistBuddy", ["-c", "Delete :LSEnvironment:CODEX_CLI_PATH", INFO_PLIST], {
    encoding: "utf8",
  });

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
  console.log("=> Removing LSEnvironment.CODEX_CLI_PATH");
  const r = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Delete :LSEnvironment:CODEX_CLI_PATH", INFO_PLIST],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    if (/Operation not permitted/i.test(stderr)) {
      console.error(`hook-codex: PlistBuddy: ${stderr}`);
      printAppManagementHelp();
      process.exit(3);
    }
    // "Does Not Exist" is fine — uninstall is idempotent.
  }

  console.log("=> Re-signing (ad-hoc)…");
  const sign = spawnSync("codesign", ["--force", "--sign", "-", CODEX_APP], { encoding: "utf8" });
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
