// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// USB-CDC pairing client. Talks to the device's pair-mode serial service.
// Wire format:
// each command + response is a single NDJSON line prefixed with the
// magic preamble `PLAIPIN-PAIR `. Non-magic lines are ignored —
// they're regular firmware log output passing through.
//
// `serialport` is a native module; we lazy-import so `plaipin` works
// without it for users who never run `device add`.

import { Buffer } from "node:buffer";
import { PLAIPIN_PAIR_MAGIC } from "../shared/pairProtocol.js";

/** USB vendor IDs we recognise as candidate plaipin boards. */
const SUPPORTED_VIDS = new Set([
  "303a", // Espressif (ESP32-S3 native USB)
  "10c4", // Silicon Labs CP21xx (M5 Core2)
  "1a86", // QinHeng CH9102 (M5 StickC Plus, generic)
]);

const DEFAULT_BAUD = 115200;
/** First-boot pair/info needs slack: opening the port can trigger a DTR reset
 *  on some bridge chips, and the rx_task only spins up after pairing_state.c
 *  decides the device is in SETUP mode. 15 s covers both. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PortCandidate {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  serialNumber?: string;
}

export interface InfoResult {
  fwVersion: string;
  chip: string;
  mac: string;
  schemaVersion: number;
  hasWifi: boolean;
  hasAuth: boolean;
  deviceId?: string;
  daemonId?: string;
}

export interface UsbPairClient {
  info(): Promise<InfoResult>;
  setNet(host?: string, port?: number): Promise<void>;
  setToken(token: string, deviceId: string, daemonId?: string): Promise<void>;
  reboot(): Promise<void>;
  factoryReset(): Promise<void>;
  close(): Promise<void>;
  readonly path: string;
  /**
   * True if the serial port has emitted any bytes since openClient
   * returned. Distinguishes "device unresponsive" from "device alive
   * but not in pair mode" (e.g. running in ONLINE after a prior
   * pair). Non-magic-prefixed lines — regular ESP_LOGI output — get
   * silently dropped by the parser; this flag captures the
   * existential fact that they arrived.
   */
  readonly sawAnyOutput: boolean;
}

interface PendingRpc {
  id: number;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Errors that are expected after a successful pair/reboot or
 * pair/factoryReset response. The device reboots quickly; the response
 * can race the reset, and USB Serial JTAG drops the connection on
 * restart. Both manifest as either a timeout or a "closed before
 * response" rejection — both are benign here. */
function isExpectedAtReboot(err: Error): boolean {
  return /timeout|closed before response|serial port error/i.test(err.message);
}

async function loadSerialPort(): Promise<typeof import("serialport").SerialPort> {
  try {
    const mod: typeof import("serialport") = await import("serialport");
    return mod.SerialPort;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    throw new Error(
      `serialport native module unavailable: ${msg}\n` +
        `→ Run 'npm install serialport@^12' to provision the prebuild for your platform.`,
    );
  }
}

/**
 * Enumerate serial ports likely to be a plaipin board. Returns ports
 * matching one of the supported USB VIDs. Use `--port` flag to bypass
 * filtering when the chip uses an unrecognised bridge.
 */
export async function listCandidates(): Promise<PortCandidate[]> {
  const SerialPort = await loadSerialPort();
  const ports = await SerialPort.list();
  const out: PortCandidate[] = [];
  for (const p of ports) {
    const vid = p.vendorId?.toLowerCase();
    if (!vid || !SUPPORTED_VIDS.has(vid)) continue;
    out.push({
      path: p.path,
      vendorId: p.vendorId,
      productId: p.productId,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
    });
  }
  return out;
}

/**
 * Open a USB pairing client on the given serial port path. Throws if
 * the port is busy (e.g. `idf.py monitor` is attached) — surface the
 * EBUSY clearly in the caller.
 */
export async function openClient(
  path: string,
  opts: { baudRate?: number; timeoutMs?: number } = {},
): Promise<UsbPairClient> {
  const SerialPort = await loadSerialPort();
  const baudRate = opts.baudRate ?? DEFAULT_BAUD;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((resolve, reject) => {
    port.open((err) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (code === "EBUSY" || /busy|in use/i.test(err.message)) {
          reject(
            new Error(
              `serial port ${path} is busy. Close any open monitor (e.g. 'idf.py monitor') and try again.`,
            ),
          );
          return;
        }
        reject(err);
        return;
      }
      resolve();
    });
  });

  let lineBuf = "";
  let nextId = 1;
  const pending = new Map<number, PendingRpc>();
  /* Existential signal for the CLI's diagnostic logic. Flips true on
   * any chunk arrival regardless of magic prefix. Used by
   * cmd-device.ts:runUsbFlow to distinguish "device unresponsive" from
   * "device alive but not in pair mode" when pair/info times out. */
  let sawAnyOutput = false;

  /** Cap on the line accumulator. A misbehaving firmware spewing bytes
   * without newlines would otherwise grow lineBuf without bound and OOM
   * the CLI. 64 KB is plenty for any well-formed pair RPC; anything
   * longer is treated as garbage. */
  const MAX_LINE_BUF = 64 * 1024;

  const onData = (chunk: Buffer): void => {
    if (chunk.length > 0) sawAnyOutput = true;
    lineBuf += chunk.toString("utf8");
    while (true) {
      const nl = lineBuf.indexOf("\n");
      if (nl < 0) break;
      const raw = lineBuf.slice(0, nl).replace(/\r$/, "");
      lineBuf = lineBuf.slice(nl + 1);
      if (!raw.startsWith(PLAIPIN_PAIR_MAGIC)) continue; // log line, ignore
      const json = raw.slice(PLAIPIN_PAIR_MAGIC.length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as { id?: number; ok?: boolean; error?: string; result?: unknown };
      if (typeof obj.id !== "number") continue; // unsolicited event (e.g. setup banner); ignore
      const rpc = pending.get(obj.id);
      if (!rpc) continue;
      pending.delete(obj.id);
      clearTimeout(rpc.timer);
      if (obj.ok === false) {
        rpc.reject(new Error(obj.error ?? "device returned ok:false"));
      } else {
        rpc.resolve(obj.result ?? null);
      }
    }
    /* No newline arrived but the buffer is past the cap — single
     * unterminated "line" longer than MAX_LINE_BUF. Drop it. */
    if (lineBuf.length > MAX_LINE_BUF) {
      console.warn(
        `plaipin: dropping ${lineBuf.length}-byte unterminated line from ${path} (firmware may be misbehaving)`,
      );
      lineBuf = "";
    }
  };

  port.on("data", onData);

  const rejectAllPending = (err: Error): void => {
    for (const rpc of pending.values()) {
      clearTimeout(rpc.timer);
      rpc.reject(err);
    }
    pending.clear();
  };

  const onClose = (): void => {
    rejectAllPending(new Error(`serial port ${path} closed before response`));
  };
  port.on("close", onClose);

  /** Without an `error` listener, Node's EventEmitter throws on
   * unhandled `error` events, crashing the CLI mid-pairing on
   * cable-yank, USB reset, kernel hiccup, etc. Log + reject pending. */
  const onError = (err: Error): void => {
    console.warn(`plaipin: serial port error on ${path}: ${err.message}`);
    rejectAllPending(new Error(`serial port error: ${err.message}`));
  };
  port.on("error", onError);

  const sendRpc = <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const body: Record<string, unknown> = { id, method };
      if (params) body.params = params;
      const line = `${PLAIPIN_PAIR_MAGIC}${JSON.stringify(body)}\n`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`USB pair: timeout waiting for ${method} response (id=${id})`));
      }, timeoutMs);
      pending.set(id, {
        id,
        resolve: (r) => resolve(r as T),
        reject,
        timer,
      });
      port.write(line, "utf8", (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  };

  return {
    path,
    get sawAnyOutput() {
      return sawAnyOutput;
    },
    info: () => sendRpc<InfoResult>("pair/info"),
    setNet: async (host?: string, port?: number) => {
      const params: Record<string, unknown> = {};
      if (host) params.host = host;
      if (port) params.port = port;
      await sendRpc<null>("pair/setNet", params);
    },
    setToken: async (token: string, deviceId: string, daemonId?: string) => {
      const params: Record<string, unknown> = { token, deviceId };
      if (daemonId) params.daemonId = daemonId;
      await sendRpc<null>("pair/setToken", params);
    },
    reboot: async () => {
      // The device responds before resetting, but the response may race
      // with the reset itself. Two known benign failure modes after the
      // ack: (a) the response times out because the chip rebooted before
      // the response could be flushed; (b) the port closes "before
      // response" because USB Serial JTAG drops the connection on reset.
      // Either is expected — only re-throw genuinely unexpected errors.
      try {
        await sendRpc<null>("pair/reboot");
      } catch (e) {
        if (!isExpectedAtReboot(e as Error)) throw e;
      }
    },
    factoryReset: async () => {
      try {
        await sendRpc<null>("pair/factoryReset");
      } catch (e) {
        if (!isExpectedAtReboot(e as Error)) throw e;
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        port.close(() => resolve());
      }),
  };
}
