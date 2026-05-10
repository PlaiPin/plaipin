// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin install` — first-time setup. Idempotent (re-running just
// re-copies the shim files and re-writes the LaunchAgent plist).
//
// What it does NOT do: patch Codex.app's Info.plist. That's `hook-codex`
// — separate command because it's the only step that modifies a
// pristine Apple-signed bundle, and we want explicit user consent.
//
// Sandbox-friendly via PLAIPIN_HOME (~/.plaipin by default) and
// PLAIPIN_LAUNCHAGENTS_DIR (~/Library/LaunchAgents by default), so
// dev/test runs don't pollute the real install location.

import { copyFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs, PATHS } from "../shared/util.js";
import { ensureBootstrapToken } from "../daemon/auth.js";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { ok, action, detail, warn, pln, color } from "./style.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface InstallOpts {
  hookCodex?: boolean;
  launchctl?: boolean;
}

export async function cmdInstall(opts: InstallOpts): Promise<void> {
  console.log(action("Creating directory layout"));
  console.log(detail("path", PATHS.home));
  ensureDirs();

  // Copy shim files into ~/.plaipin/bin/
  // We assume the package layout: <pkgRoot>/shim/{codex-shim.sh, codex-shim-bridge.js}
  const pkgRoot = findPkgRoot();
  const srcShim = join(pkgRoot, "shim", "codex-shim.sh");
  const srcBridge = join(pkgRoot, "shim", "codex-shim-bridge.js");
  const dstShim = join(PATHS.bin, "codex-shim");
  const dstBridge = join(PATHS.bin, "codex-shim-bridge.js");
  copyFileSync(srcShim, dstShim);
  copyFileSync(srcBridge, dstBridge);
  chmodSync(dstShim, 0o755);
  chmodSync(dstBridge, 0o755);
  console.log(ok("Shim installed"));
  console.log(detail("path", dstShim));

  // Write LaunchAgent plist
  // PLAIPIN_LAUNCHAGENTS_DIR overrides the standard location for testing.
  const launchAgentsDir = process.env.PLAIPIN_LAUNCHAGENTS_DIR ?? join(homedir(), "Library/LaunchAgents");
  const plistPath = join(launchAgentsDir, "com.plaipin.daemon.plist");
  if (!existsSync(launchAgentsDir)) mkdirSync(launchAgentsDir, { recursive: true });
  const daemonEntry = join(pkgRoot, "dist", "daemon", "index.js");
  const plist = launchAgentPlist({
    label: "com.plaipin.daemon",
    nodeBin: process.execPath,
    daemonEntry,
    homeDir: PATHS.home,
    logDir: PATHS.log,
  });
  writeFileSync(plistPath, plist);
  console.log(ok("LaunchAgent written"));
  console.log(detail("path", plistPath));

  if (opts.launchctl !== false) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    // Clear any persistent "disabled" override left by a previous failed
    // unload — see KNOWN_ISSUES "launchctl disabled state".
    try {
      execSync(`launchctl enable gui/${process.getuid?.() ?? 501}/com.plaipin.daemon`, {
        stdio: "ignore",
      });
    } catch {
      /* older macOS may not support; load -w will still try */
    }
    execSync(`launchctl load -w "${plistPath}"`, { stdio: "inherit" });
    console.log(ok("LaunchAgent loaded · daemon running"));
  }

  if (opts.hookCodex !== false) {
    pln();
    pln("To patch Codex.app, run " + color.action("plaipin hook-codex --enable"));
  }

  const token = ensureBootstrapToken();
  pln();
  console.log(ok("Bootstrap pairing token (use this for the first ESP32):"));
  console.log(detail("token", token));
  pln();
  pln("Next: connect an ESP32 to this network, then run " + color.action("plaipin doctor") + ".");
  pln();
  console.log(warn(color.emphasis("To remove plaipin cleanly LATER, always run:")));
  pln("    " + color.action("plaipin uninstall"));
  pln();
  pln(color.info(
    "Do NOT just `rm -rf ~/.plaipin` if you have run `hook-codex --enable`.\n" +
    "   The hook makes Codex.app spawn a shim under ~/.plaipin/bin/; if that\n" +
    "   file is missing while the hook is still installed, Codex.app will fail to\n" +
    "   launch. `plaipin uninstall` removes things in the safe order.",
  ));
}

function findPkgRoot(): string {
  // dist/cli/index.js → up to package root.
  // src/cli/index.ts (dev) → up to package root.
  // Both end up two dirs above this file.
  return join(__dirname, "..", "..");
}

function launchAgentPlist(opts: {
  label: string;
  nodeBin: string;
  daemonEntry: string;
  homeDir: string;
  logDir: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodeBin}</string>
    <string>${opts.daemonEntry}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLAIPIN_HOME</key><string>${opts.homeDir}</string>
    <key>PLAIPIN_LOG_LEVEL</key><string>info</string>
  </dict>
  <key>StandardOutPath</key><string>${opts.logDir}/daemon.out.log</string>
  <key>StandardErrorPath</key><string>${opts.logDir}/daemon.err.log</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
}
