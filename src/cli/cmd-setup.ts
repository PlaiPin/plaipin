// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin setup` — bundles install + hook-codex + doctor in one
// guided command, with a single consent prompt for the bundle-modifying
// hook step. The result: one command brings plaipin from "freshly
// installed via npm" to "running with Codex.app fully mirrored" — the
// daemon-side equivalent of `plaipin device add` for the device-side.
//
// Composition:
//   1. cmdInstall (LaunchAgent plist + shim copy + start daemon)
//   2. Confirm prompt (skippable with --yes; matches cmd-uninstall convention)
//   3. cmdHookCodex({enable:true}) — only this step needs consent because
//      it patches Codex.app's Info.plist + ad-hoc re-signs the bundle.
//   4. cmdDoctor — final health check; surfaces anything that didn't go right.
//
// The user is reminded to restart Codex.app at the end. Codex.app must
// be relaunched for the env-var hook to take effect on its next codex
// app-server spawn.

import { createInterface } from "node:readline";
import { cmdInstall } from "./cmd-install.js";
import { cmdHookCodex } from "./cmd-hook-codex.js";
import { runDoctor } from "./cmd-doctor.js";
import {
  printBrandBanner,
  header,
  ok,
  warn,
  pln,
  color,
  glyph,
} from "./style.js";

interface SetupOpts {
  yes?: boolean;
  skipHook?: boolean;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(question, (a) => resolve(a));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function cmdSetup(opts: SetupOpts): Promise<void> {
  printBrandBanner();

  // Step 1: install (idempotent — safe to re-run on a partially-set-up host).
  header("Step 1/3 · install daemon");
  await cmdInstall({ hookCodex: false, launchctl: true });

  // Step 2: hook Codex.app — needs explicit consent because it modifies the bundle.
  header("Step 2/3 · hook Codex.app");
  if (opts.skipHook) {
    console.log(warn("SKIPPED (--skip-hook). Without the hook, the daemon runs but"));
    pln("           your Codex.app session won't be mirrored. Run");
    pln("           " + color.action("plaipin hook-codex --enable") + " later to enable mirroring.");
  } else {
    let proceed = opts.yes ?? false;
    if (!proceed) {
      pln("plaipin needs to patch Codex.app's Info.plist to mirror your");
      pln("sessions. This adds one entry (LSEnvironment.CODEX_CLI_PATH) and");
      pln("ad-hoc re-signs the bundle. Fully reversible via " + color.action("plaipin uninstall") + ".");
      pln();
      proceed = await confirm("   Continue? [y/N] ");
    }
    if (proceed) {
      await cmdHookCodex({ enable: true });
      pln();
      console.log(warn("Codex.app must be restarted for the hook to take effect."));
      pln("Quit + reopen Codex.app, then run " + color.action("plaipin tail") + " to verify.");
    } else {
      console.log(warn("Hook skipped. Daemon is running but Codex.app sessions won't be"));
      pln("mirrored. Run " + color.action("plaipin hook-codex --enable") + " later to enable.");
    }
  }

  // Step 3: doctor — final health check. Doesn't fail the command (a
  // partial-pass setup is still usable). `runDoctor` returns the
  // pass/fail boolean and prints the per-check report; we only use the
  // boolean for the final summary message.
  header("Step 3/3 · doctor");
  const allPass = await runDoctor();
  pln();
  if (allPass) {
    console.log(ok(color.emphasis("Setup complete — your pet's home is ready!")));
    pln("Try " + color.action("plaipin tail") + " to see live events from Codex.app.");
    pln("Pair an ESP32 with " + color.action("plaipin device add <name>") + " to wake your pet.");
  } else {
    console.log(warn(color.emphasis("Setup partially complete — some checks failed (see above).")));
    pln("The daemon is still running. Re-run " + color.action("plaipin doctor") +
      " after addressing each " + color.fail(glyph.fail) + ".");
  }
}
