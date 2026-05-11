// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Safe, ordered teardown. Order matters:
//   1. Unpatch Codex.app's Info.plist FIRST (so Codex stops trying to spawn
//      our shim). Delegated to cmdHookCodex({disable:true}) so there's a
//      single implementation of the plist surgery + codesign step.
//   2. Unload the LaunchAgent and remove the plist.
//   3. Remove ~/.plaipin/ (preserves pairings if --keep-state).
//
// If the user manually deletes ~/.plaipin/ before running this, Codex.app
// will fail to launch because Info.plist points at a now-missing shim.
// `plaipin uninstall` exists specifically to prevent that footgun.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import readline from "node:readline";
import { PATHS } from "../shared/util.js";
import { cmdHookCodex } from "./cmd-hook-codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CODEX_APP = "/Applications/Codex.app";
const CODEX_INFO_PLIST = join(CODEX_APP, "Contents/Info.plist");

interface UninstallOpts {
  yes?: boolean;
  keepState?: boolean;
  /** override LaunchAgents dir for tests */
  launchAgentsDir?: string;
}

export async function cmdUninstall(opts: UninstallOpts): Promise<void> {
  const launchAgentsDir =
    opts.launchAgentsDir ?? process.env.PLAIPIN_LAUNCHAGENTS_DIR ?? join(homedir(), "Library/LaunchAgents");
  const plistPath = join(launchAgentsDir, "com.plaipin.daemon.plist");

  // Detect what's currently installed
  const hookActive = isHookActive();
  const plistInstalled = existsSync(plistPath);
  const stateInstalled = existsSync(PATHS.home);

  if (!hookActive && !plistInstalled && !stateInstalled) {
    console.log("Nothing to uninstall — no plaipin traces found.");
    return;
  }

  console.log("Will perform the following steps in order:");
  if (hookActive) {
    console.log(`  1. Remove LSEnvironment.CODEX_CLI_PATH from Codex.app/Contents/Info.plist`);
    console.log(`     and ad-hoc re-sign Codex.app to keep Gatekeeper happy.`);
  }
  if (plistInstalled) {
    console.log(`  ${hookActive ? 2 : 1}. Stop and remove LaunchAgent at ${plistPath}`);
  }
  if (stateInstalled) {
    const step = (hookActive ? 1 : 0) + (plistInstalled ? 1 : 0) + 1;
    console.log(
      `  ${step}. Remove ${PATHS.home}${opts.keepState ? " (keeping state/ for re-install)" : ""}`,
    );
  }
  console.log("");

  if (!opts.yes) {
    const confirmed = await confirm("Proceed?");
    if (!confirmed) {
      console.log("Aborted. (Run with -y to skip the prompt.)");
      process.exit(1);
    }
  }

  // Step 1: hook-codex --disable. Delegated to cmdHookCodex so the
  // teardown logic lives in exactly one place (it surgically deletes
  // :LSEnvironment:CODEX_CLI_PATH and re-signs — no whole-file restore).
  if (hookActive) {
    console.log("");
    await cmdHookCodex({ disable: true });
  }

  // Step 2: stop + remove LaunchAgent
  if (plistInstalled) {
    console.log(`\n=> Stopping daemon and removing LaunchAgent at ${plistPath}…`);
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // already unloaded
    }
    try {
      unlinkSync(plistPath);
    } catch (e) {
      console.warn(`   could not delete plist: ${(e as Error).message}`);
    }
  }

  // Step 3: rm -rf ~/.plaipin/
  if (stateInstalled) {
    if (opts.keepState) {
      console.log(
        `\n=> --keep-state: leaving ${PATHS.state} (pairings) and ${PATHS.bin} (shim) in place.`,
      );
      // Remove the run dir so daemon can't accidentally come back via stale lock
      try {
        rmSync(PATHS.run, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      console.log(`\n=> Removing ${PATHS.home}…`);
      rmSync(PATHS.home, { recursive: true, force: true });
    }
  }

  console.log("\nDone. To remove plaipin from npm:  npm uninstall -g plaipin");
  if (hookActive) {
    console.log("");
    console.log(
      "Note: Codex.app's bundle is now ad-hoc-signed (it was Apple-signed before plaipin hooked it).",
    );
    console.log("To restore the original Apple signature, reinstall Codex.app from the official DMG");
    console.log("or wait for its next auto-update.");
  }

  // suppress unused
  void readFileSync;
}

function isHookActive(): boolean {
  if (!existsSync(CODEX_INFO_PLIST)) return false;
  const out = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :LSEnvironment:CODEX_CLI_PATH", CODEX_INFO_PLIST],
    { encoding: "utf8" },
  );
  return out.status === 0 && (out.stdout ?? "").trim().length > 0;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// suppress unused
void __dirname;
