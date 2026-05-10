// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin version` — prints versions of plaipin, codex (the bundled
// binary we'll spawn), node, and platform. Cheap diagnostic for bug reports.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveCodexBinary } from "../shared/util.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import { color, pln } from "./style.js";

function row(label: string, value: string): void {
  pln(`${color.info(label.padEnd(14))}${value}`);
}

export function cmdVersion(): void {
  pln();
  row("plaipin", color.brand(color.emphasis(PACKAGE_VERSION)));
  const codex = resolveCodexBinary();
  if (existsSync(codex)) {
    try {
      const v = execSync(`"${codex}" --version`).toString().trim();
      row("codex", v);
    } catch {
      row("codex", color.fail(`(error invoking ${codex})`));
    }
  } else {
    row("codex", color.fail(`(not found at ${codex})`));
  }
  row("node", process.version);
  row("platform", `${process.platform} ${process.arch}`);
  pln();
}
