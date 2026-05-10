// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const pkgPath = join(here, "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`invalid package version in ${pkgPath}`);
  }
  return pkg.version;
}

export const PACKAGE_VERSION = readPackageVersion();
