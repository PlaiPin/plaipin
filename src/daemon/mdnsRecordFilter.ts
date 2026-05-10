// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Patches `bonjour-service` to drop address records that are useless for
// service discovery on a LAN — specifically IPv4 link-local (169.254.0.0/16,
// RFC 3927) and IPv6 link-local (fe80::/10, RFC 4291).
//
// Why we need this. The library's `Service.records()` iterates
// `os.networkInterfaces()` and emits an A or AAAA record for every
// non-internal address it finds, with no filter knob (see
// node_modules/bonjour-service/dist/lib/service.js, the `records()` method).
// On a Mac with an iPhone connected via USB, macOS auto-creates an `enN`
// interface that gets self-assigned a 169.254.x.x APIPA address. The
// library publishes that as a routable A record, devices on the LAN
// resolve to it, and every WS connect attempt times out at the kernel
// `select()` boundary because the address isn't reachable from the LAN.
//
// We monkey-patch `Service.prototype.records` once at module load. The
// patch is idempotent; calling `installRecordFilter()` more than once is
// a no-op. RFC 6762 §11 per-interface-scoping work that this filter
// does *not* address is left as future work.

import { Service } from "bonjour-service";

interface AddressRecord {
  name: string;
  type: "PTR" | "SRV" | "TXT" | "A" | "AAAA";
  ttl: number;
  data: unknown;
}

const PATCH_MARKER = Symbol.for("plaipin.mdnsRecordFilter.applied");

/** True iff `ip` is in 169.254.0.0/16 (IPv4 link-local). */
export function isLinkLocalIPv4(ip: string): boolean {
  return ip.startsWith("169.254.");
}

/**
 * True iff `ip` is in fe80::/10 (IPv6 link-local). Tolerates zone suffix
 * (e.g. "fe80::1%en0") and case differences.
 *
 * fe80::/10 means the first byte is 0xfe AND the high two bits of the
 * second byte are 10. In hex: starts with "fe" followed by 8/9/a/b.
 */
export function isLinkLocalIPv6(ip: string): boolean {
  const addr = (ip.split("%")[0] ?? "").toLowerCase();
  const m = addr.match(/^fe([0-9a-f])/);
  if (!m) return false;
  const c = m[1];
  return c === "8" || c === "9" || c === "a" || c === "b";
}

/**
 * Drop A/AAAA records pointing at link-local addresses. Order- and
 * type-preserving for non-address records.
 */
export function filterAddressRecords(records: AddressRecord[]): AddressRecord[] {
  return records.filter((r) => {
    if (r.type === "A" && typeof r.data === "string") {
      return !isLinkLocalIPv4(r.data);
    }
    if (r.type === "AAAA" && typeof r.data === "string") {
      return !isLinkLocalIPv6(r.data);
    }
    return true;
  });
}

/**
 * Apply the filter to every Service instance produced by `bonjour-service`.
 * Idempotent — calling more than once is a no-op (we set a Symbol marker
 * on the prototype the first time and short-circuit thereafter).
 */
export function installRecordFilter(): void {
  const proto = Service.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[PATCH_MARKER]) return;

  const original = proto["records"] as (this: Service) => AddressRecord[];
  proto["records"] = function (this: Service): AddressRecord[] {
    const recs = original.call(this);
    return filterAddressRecords(recs);
  };
  proto[PATCH_MARKER] = true;
}
