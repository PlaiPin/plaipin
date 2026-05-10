#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0
// plaipin CLI. Run `plaipin --help` for the full subcommand list.

import { Command } from "commander";
import { cmdInstall } from "./cmd-install.js";
import { cmdSetup } from "./cmd-setup.js";
import { cmdUninstall } from "./cmd-uninstall.js";
import { cmdStart, cmdStop, cmdRestart, cmdStatus } from "./cmd-launchctl.js";
import { cmdDeviceAdd, cmdDeviceList, cmdDeviceRevoke, cmdDeviceReset } from "./cmd-device.js";
import { cmdHookCodex } from "./cmd-hook-codex.js";
import { cmdTail } from "./cmd-tail.js";
import { cmdApprove } from "./cmd-approve.js";
import { cmdDemo } from "./cmd-demo.js";
import { cmdDoctor } from "./cmd-doctor.js";
import { cmdVersion } from "./cmd-version.js";
import { printBrandBanner, color, pln } from "./style.js";
import { PACKAGE_VERSION } from "../shared/version.js";

const program = new Command();
program
  .name("plaipin")
  .description("Mirror Codex desktop sessions to an ESP32 device on your local network.")
  .version(PACKAGE_VERSION)
  .addHelpText("beforeAll", () => {
    // Banner only on top-level --help (subcommand --help skips it).
    return "";
  });

// No-args / no-subcommand path: show the banner + a curated short help
// instead of commander's default "you need a command" terse error.
if (process.argv.length <= 2) {
  printBrandBanner();
  pln("Usage:  " + color.action("plaipin <command> [options]"));
  pln();
  pln(color.emphasis("Common commands:"));
  pln("  " + color.action("setup") + "          one-shot install + Codex hook + doctor");
  pln("  " + color.action("device add <name>") + "  pair an ESP32 over USB or wireless");
  pln("  " + color.action("device list") + "    list paired devices");
  pln("  " + color.action("doctor") + "         health checks");
  pln("  " + color.action("tail") + "           stream live events");
  pln();
  pln("Run " + color.action("plaipin --help") + " for the full command list.");
  pln();
  process.exit(0);
}

program
  .command("setup")
  .description("Bundled first-time install: daemon + hook Codex.app + doctor in one command")
  .option("-y, --yes", "skip the consent prompt for the bundle-modifying hook step")
  .option("--skip-hook", "skip the Codex.app hook (daemon runs but won't mirror sessions)")
  .action(cmdSetup);

program
  .command("install")
  .description("Lower-level: create dirs + write LaunchAgent plist (without hook). Prefer `setup`.")
  .option("--no-hook-codex", "skip patching /Applications/Codex.app's Info.plist")
  .option("--no-launchctl", "do not load the LaunchAgent (useful for dev)")
  .action(cmdInstall);

program.command("start").description("Start the daemon (launchctl)").action(cmdStart);
program.command("stop").description("Stop the daemon").action(cmdStop);
program.command("restart").description("Restart the daemon").action(cmdRestart);
program.command("status").description("Daemon status").action(cmdStatus);

program
  .command("uninstall")
  .description("Safely undo install: restore Codex.app/Info.plist, stop daemon, remove ~/.plaipin")
  .option("-y, --yes", "skip confirmation prompt")
  .option("--keep-state", "preserve ~/.plaipin/state (pairings) and ~/.plaipin/bin (shim)")
  .action(cmdUninstall);

const device = program.command("device").description("Manage paired devices");
device
  .command("add <name>")
  .description(
    "Authorize a device with the daemon (USB-CDC identity pairing or wireless claim confirm). " +
      "Does NOT push WiFi creds — those come from Kconfig dev mode or the SoftAP setup flow.",
  )
  .option("--usb-only", "skip the wireless pending-claims watcher")
  .option("--wireless", "skip the USB watcher")
  .option("--port <path>", "explicit serial-port path (e.g. /dev/cu.usbserial-XXX)")
  .option("--timeout <seconds>", "discovery timeout in seconds", "60")
  .action(cmdDeviceAdd);
device
  .command("list")
  .description("List paired devices (relative time format; --json for raw)")
  .option("--json", "emit JSON instead of human-readable table")
  .action(cmdDeviceList);
device
  .command("revoke <name>")
  .description("Revoke a device's daemon-side token (401 on next reconnect)")
  .action(cmdDeviceRevoke);
device
  .command("reset <name>")
  .description(
    "Revoke daemon-side token + print instructions for wiping device NVS " +
      "(long-press GPIO 0 or USB pair/factoryReset).",
  )
  .action(cmdDeviceReset);

program
  .command("hook-codex")
  .description("Enable or disable the Codex.app Info.plist patch (CODEX_CLI_PATH)")
  .option("--enable", "patch Codex.app + ad-hoc re-sign", false)
  .option("--disable", "remove the patch + ad-hoc re-sign", false)
  .action(cmdHookCodex);

program
  .command("tail")
  .description("Stream live ESP32-facing events from the running daemon (uses bootstrap token)")
  .option("-h, --host <addr>", "daemon host", "127.0.0.1")
  .option("-p, --port <n>", "daemon port", "48756")
  .action(cmdTail);

program
  .command("approve <id> <decision>")
  .description("Send a single approval decision (accept|acceptForSession|decline|cancel) and wait for resolution")
  .option("-h, --host <addr>", "daemon host", "127.0.0.1")
  .option("-p, --port <n>", "daemon port", "48756")
  .action(cmdApprove);

program
  .command("demo")
  .description("Inject a synthetic Codex event sequence into the running daemon (no Codex.app needed)")
  .option("-s, --scenario <name>", "basic | approval", "basic")
  .option("-h, --host <addr>", "control HTTP host", "127.0.0.1")
  .option("-p, --port <n>", "control HTTP port", "48757")
  .action(cmdDemo);

program
  .command("doctor")
  .description("Run health checks (Codex install, hook status, daemon, schema)")
  .action(cmdDoctor);

program.command("version").description("Print versions of daemon, shim, codex").action(cmdVersion);

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`plaipin: ${e.message}`);
  process.exit(1);
});
