// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the bonjour-service A/AAAA record filter. Locks down a
// regression case (an iPhone connected via USB to a Mac causes a
// 169.254.x.x link-local address to be advertised as discoverable,
// triggering 10 s WS connect timeouts on every device retry).

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Service } from "bonjour-service";
import {
  filterAddressRecords,
  installRecordFilter,
  isLinkLocalIPv4,
  isLinkLocalIPv6,
} from "./mdnsRecordFilter.js";

// Group A — address classification

test("isLinkLocalIPv4: 169.254.x.x is link-local", () => {
  assert.equal(isLinkLocalIPv4("169.254.0.1"), true);
  assert.equal(isLinkLocalIPv4("169.254.211.102"), true);
  assert.equal(isLinkLocalIPv4("169.254.255.254"), true);
});

test("isLinkLocalIPv4: neighbour ranges and RFC1918 are not link-local", () => {
  assert.equal(isLinkLocalIPv4("169.253.0.1"), false);
  assert.equal(isLinkLocalIPv4("169.255.0.1"), false);
  assert.equal(isLinkLocalIPv4("192.168.1.1"), false);
  assert.equal(isLinkLocalIPv4("10.0.0.1"), false);
  assert.equal(isLinkLocalIPv4("127.0.0.1"), false);
});

test("isLinkLocalIPv6: covers fe80, fe90, fea0, feb0 (the /10 block)", () => {
  assert.equal(isLinkLocalIPv6("fe80::1"), true);
  assert.equal(isLinkLocalIPv6("fe80::abcd:1234"), true);
  assert.equal(isLinkLocalIPv6("fe90::1"), true);
  assert.equal(isLinkLocalIPv6("fea0::1"), true);
  assert.equal(isLinkLocalIPv6("feb0::1"), true);
});

test("isLinkLocalIPv6: case-insensitive and tolerates zone suffix", () => {
  assert.equal(isLinkLocalIPv6("FE80::1"), true);
  assert.equal(isLinkLocalIPv6("fe80::1%en0"), true);
  assert.equal(isLinkLocalIPv6("FE80::1%en0"), true);
});

test("isLinkLocalIPv6: non-link-local v6 is not flagged", () => {
  assert.equal(isLinkLocalIPv6("fe7f::1"), false);
  // fec0::/10 was site-local (deprecated); not link-local.
  assert.equal(isLinkLocalIPv6("fec0::1"), false);
  assert.equal(isLinkLocalIPv6("2001:db8::1"), false);
  assert.equal(isLinkLocalIPv6("::1"), false);
});

// Group B — filterAddressRecords (pure)

test("filterAddressRecords: keeps PTR/SRV/TXT records as-is", () => {
  const recs = [
    { name: "_plaipin._tcp.local", type: "PTR" as const, ttl: 28800, data: "x" },
    {
      name: "x.local",
      type: "SRV" as const,
      ttl: 120,
      data: { port: 1, target: "x.local" },
    },
    { name: "x.local", type: "TXT" as const, ttl: 4500, data: Buffer.from("v=1") },
  ];
  assert.deepEqual(filterAddressRecords(recs), recs);
});

test("filterAddressRecords: drops A records in 169.254/16 only", () => {
  const recs = [
    { name: "h.local", type: "A" as const, ttl: 120, data: "192.168.8.221" },
    { name: "h.local", type: "A" as const, ttl: 120, data: "169.254.211.102" },
    { name: "h.local", type: "A" as const, ttl: 120, data: "10.0.0.5" },
  ];
  const out = filterAddressRecords(recs);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.data, "192.168.8.221");
  assert.equal(out[1]!.data, "10.0.0.5");
});

test("filterAddressRecords: drops AAAA records in fe80::/10 only", () => {
  const recs = [
    { name: "h.local", type: "AAAA" as const, ttl: 120, data: "2001:db8::1" },
    { name: "h.local", type: "AAAA" as const, ttl: 120, data: "fe80::abcd" },
  ];
  const out = filterAddressRecords(recs);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.data, "2001:db8::1");
});

test("filterAddressRecords: preserves order across mixed input", () => {
  const recs = [
    { name: "n", type: "PTR" as const, ttl: 0, data: "x" },
    { name: "n", type: "A" as const, ttl: 0, data: "169.254.1.1" }, // dropped
    {
      name: "n",
      type: "SRV" as const,
      ttl: 0,
      data: { port: 1, target: "x" },
    },
    { name: "n", type: "A" as const, ttl: 0, data: "192.168.1.1" }, // kept
  ];
  const out = filterAddressRecords(recs);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.type, "PTR");
  assert.equal(out[1]!.type, "SRV");
  assert.equal(out[2]!.type, "A");
});

// Group C — end-to-end on a real Service instance with stubbed
// `os.networkInterfaces` (the actual iPhone-USB repro shape)

test("Service.records() filters out 169.254 when patched", (t) => {
  installRecordFilter();

  t.mock.method(os, "networkInterfaces", () => ({
    en0: [
      {
        address: "192.168.8.221",
        family: "IPv4",
        internal: false,
        mac: "aa:bb:cc:dd:ee:ff",
        netmask: "255.255.255.0",
        cidr: "192.168.8.221/24",
      },
    ],
    en1: [
      {
        address: "169.254.211.102",
        family: "IPv4",
        internal: false,
        mac: "11:22:33:44:55:66",
        netmask: "255.255.0.0",
        cidr: "169.254.211.102/16",
      },
    ],
  }));

  const service = new Service({
    name: "plaipin",
    type: "plaipin",
    protocol: "tcp",
    port: 48756,
    host: "plaipin-deadbeefcafe.local",
    txt: { v: "1" },
    disableIPv6: true,
  });

  const records = service.records();
  const aRecords = records.filter((r) => r.type === "A");
  const srvRecord = records.find((r) => r.type === "SRV");

  assert.ok(srvRecord, "SRV record should be present");
  assert.equal(
    (srvRecord.data as { target: string }).target,
    "plaipin-deadbeefcafe.local",
    "SRV target is the explicit host we passed (not os.hostname())",
  );

  assert.equal(aRecords.length, 1, "exactly one A record after filter");
  assert.equal(aRecords[0]!.data, "192.168.8.221");

  for (const r of aRecords) {
    assert.equal(
      String(r.data).startsWith("169.254."),
      false,
      "no link-local A records should leak through",
    );
  }
});

// Group D — idempotence

test("installRecordFilter: multiple calls do not double-wrap or break behaviour", (t) => {
  installRecordFilter();
  installRecordFilter();
  installRecordFilter();

  t.mock.method(os, "networkInterfaces", () => ({
    en0: [
      {
        address: "192.168.8.221",
        family: "IPv4",
        internal: false,
        mac: "aa:bb:cc:dd:ee:ff",
        netmask: "255.255.255.0",
        cidr: "192.168.8.221/24",
      },
      {
        address: "169.254.99.99",
        family: "IPv4",
        internal: false,
        mac: "aa:bb:cc:dd:ee:ff",
        netmask: "255.255.0.0",
        cidr: "169.254.99.99/16",
      },
    ],
  }));

  const service = new Service({
    name: "plaipin",
    type: "plaipin",
    protocol: "tcp",
    port: 48756,
    host: "plaipin-x.local",
    disableIPv6: true,
  });

  const aRecords = service.records().filter((r) => r.type === "A");
  assert.equal(aRecords.length, 1);
  assert.equal(aRecords[0]!.data, "192.168.8.221");
});

// Group E — host-not-set fallback (regression guard for the SRV-target bug)

test("Service without explicit host falls back to os.hostname() — documents the trap mdns.ts routes around", (t) => {
  t.mock.method(os, "hostname", () => "MacBookPro.lan");

  const service = new Service({
    name: "plaipin",
    type: "plaipin",
    protocol: "tcp",
    port: 48756,
  });

  // This is the bug we route around in mdns.ts. Documented here so a
  // future contributor who removes the explicit `host:` from publish()
  // sees this test fail and finds this comment.
  assert.equal(service.host, "MacBookPro.lan");
});
