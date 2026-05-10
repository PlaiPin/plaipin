// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Drift detector for the device/CLI shared protocol surface. The TypeScript
// daemon side (`src/shared/nvsSchema.ts`, `src/shared/pairProtocol.ts`) and
// a checked-out device implementation must agree on every namespace + key +
// schema version + protocol magic, or pairing fails silently.
//
// This script reads both sources, derives the expected `#define` lines
// from the TS constants, and asserts each one is present in the C
// headers. Run via `npx tsx scripts/dev/nvs-schema-parity.ts` from a workspace
// that also has the matching device sources checked out.

import fs from "node:fs";

import { NVS_NS, NVS_KEY, NVS_SCHEMA_VERSION, DEFAULT_DAEMON_PORT } from "../../src/shared/nvsSchema.js";
import { PLAIPIN_PAIR_MAGIC } from "../../src/shared/pairProtocol.js";

const headerPath = process.env.PLAIPIN_NVS_HEADER;
const pairHeaderPath = process.env.PLAIPIN_PAIR_HEADER;

if (!headerPath || !pairHeaderPath) {
  console.error("Set PLAIPIN_NVS_HEADER and PLAIPIN_PAIR_HEADER to the matching device header paths.");
  process.exit(2);
}

const header = fs.readFileSync(headerPath, "utf8");
const pairHeader = fs.readFileSync(pairHeaderPath, "utf8");

const expected: Array<{ define: string; expected: string; label: string }> = [
  {
    define: "PLAIPIN_NVS_SCHEMA_VERSION",
    expected: String(NVS_SCHEMA_VERSION),
    label: "schema version",
  },
  {
    define: "PLAIPIN_DEFAULT_DAEMON_PORT",
    expected: String(DEFAULT_DAEMON_PORT),
    label: "default daemon port",
  },
  // namespaces
  { define: "PLAIPIN_NVS_NS_META", expected: `"${NVS_NS.META}"`, label: "meta namespace" },
  { define: "PLAIPIN_NVS_NS_WIFI", expected: `"${NVS_NS.WIFI}"`, label: "wifi namespace" },
  { define: "PLAIPIN_NVS_NS_AUTH", expected: `"${NVS_NS.AUTH}"`, label: "auth namespace" },
  { define: "PLAIPIN_NVS_NS_NET",  expected: `"${NVS_NS.NET}"`,  label: "net namespace" },
  // keys
  { define: "PLAIPIN_NVS_KEY_SCHEMA_VERSION",   expected: `"${NVS_KEY.SCHEMA_VERSION}"`,   label: "schema version key" },
  { define: "PLAIPIN_NVS_KEY_WIFI_SSID",        expected: `"${NVS_KEY.WIFI_SSID}"`,        label: "wifi ssid key" },
  { define: "PLAIPIN_NVS_KEY_WIFI_PSK",         expected: `"${NVS_KEY.WIFI_PSK}"`,         label: "wifi psk key" },
  { define: "PLAIPIN_NVS_KEY_AUTH_TOKEN",       expected: `"${NVS_KEY.AUTH_TOKEN}"`,       label: "auth token key" },
  { define: "PLAIPIN_NVS_KEY_AUTH_DEVICE_ID",   expected: `"${NVS_KEY.AUTH_DEVICE_ID}"`,   label: "auth device id key" },
  { define: "PLAIPIN_NVS_KEY_AUTH_DAEMON_ID",   expected: `"${NVS_KEY.AUTH_DAEMON_ID}"`,   label: "auth daemon id key" },
  { define: "PLAIPIN_NVS_KEY_NET_DAEMON_HOST",  expected: `"${NVS_KEY.NET_DAEMON_HOST}"`,  label: "net daemon host key" },
  { define: "PLAIPIN_NVS_KEY_NET_DAEMON_PORT",  expected: `"${NVS_KEY.NET_DAEMON_PORT}"`,  label: "net daemon port key" },
];

let failures = 0;
for (const { define, expected: want, label } of expected) {
  const re = new RegExp(`^\\s*#define\\s+${define}\\s+(.+?)\\s*(?:/\\*|//|$)`, "m");
  const m = header.match(re);
  if (!m) {
    console.error(`✗ ${label}: missing #define ${define}`);
    failures++;
    continue;
  }
  const got = m[1]!.trim();
  if (got !== want) {
    console.error(`✗ ${label}: ${define} = ${got} (want ${want})`);
    failures++;
    continue;
  }
  console.log(`✓ ${label}: ${define} = ${got}`);
}

// NVS hard limits: namespace + key names ≤ 15 bytes each.
const NVS_NAME_MAX = 15;
const allNames: Array<[string, string]> = [
  ...Object.entries(NVS_NS).map(([k, v]) => [`namespace ${k}`, v] as [string, string]),
  ...Object.entries(NVS_KEY).map(([k, v]) => [`key ${k}`, v] as [string, string]),
];
for (const [label, name] of allNames) {
  if (name.length > NVS_NAME_MAX) {
    console.error(`✗ ${label} = "${name}" exceeds ${NVS_NAME_MAX}-byte NVS limit`);
    failures++;
  }
}

// --- Pair-protocol magic preamble parity ---
// usbPair.ts and pair_usb.h both define PLAIPIN_PAIR_MAGIC. The TS
// side now imports from src/shared/pairProtocol.ts; the C side has a
// #define. Check the C #define matches the TS constant verbatim.
{
  const re = /^\s*#define\s+PLAIPIN_PAIR_MAGIC\s+"([^"]+)"\s*$/m;
  const m = pairHeader.match(re);
  if (!m) {
    console.error(`✗ pair-protocol magic: missing #define PLAIPIN_PAIR_MAGIC in pair_usb.h`);
    failures++;
  } else if (m[1] !== PLAIPIN_PAIR_MAGIC) {
    console.error(
      `✗ pair-protocol magic: pair_usb.h has "${m[1]}", pairProtocol.ts has "${PLAIPIN_PAIR_MAGIC}"`,
    );
    failures++;
  } else {
    console.log(`✓ pair-protocol magic: "${PLAIPIN_PAIR_MAGIC}"`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) — TS and C protocol surfaces have drifted.`);
  process.exit(1);
} else {
  console.log(
    "\nProtocol parity OK between TS shared modules and device headers.",
  );
}
