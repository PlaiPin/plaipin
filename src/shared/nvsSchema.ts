// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Source of truth for NVS namespaces and key names used by device-side storage
// to persist pairing credentials. Both sides must stay in sync — drift breaks
// pairing silently.
//
// NVS constraints to be aware of:
//   - Namespace name max 15 chars
//   - Key name max 15 chars
//   - String value max 4000 bytes (we use far less)
//   - Atomic writes via nvs_commit
//
// Schema version lives in the `meta` namespace under `ver`. Bump only
// when the field shape changes. The device reads `ver` at boot and
// rejects/migrates as appropriate.

/** Current schema revision. Bump on breaking field changes. */
export const NVS_SCHEMA_VERSION = 1;

/** Namespace names — keep ≤15 chars. */
export const NVS_NS = {
  META: "plaipin_meta",
  WIFI: "plaipin_wifi",
  AUTH: "plaipin_auth",
  NET:  "plaipin_net",
} as const;

/** Key names within each namespace — keep ≤15 chars. */
export const NVS_KEY = {
  // meta namespace
  SCHEMA_VERSION: "ver", // u8

  // wifi namespace
  WIFI_SSID: "ssid",     // string
  WIFI_PSK:  "psk",      // string

  // auth namespace
  AUTH_TOKEN:    "token",     // string (32-byte hex)
  AUTH_DEVICE_ID: "device_id", // string (e.g. "my-pet")
  AUTH_DAEMON_ID: "daemon_id", // string (16-char hex prefix of daemon's stable id)

  // net namespace (optional manual host override + cached daemon endpoint)
  NET_DAEMON_HOST: "daemon_host", // string (e.g. "192.168.1.10")
  NET_DAEMON_PORT: "daemon_port", // u16
} as const;

/** Default daemon WS port (matches `wsServer.opts.port` default). */
export const DEFAULT_DAEMON_PORT = 48756;
