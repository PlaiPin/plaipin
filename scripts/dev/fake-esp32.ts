#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0
/**
 * Fake ESP32 client. Connects to the daemon's WS server with a bearer
 * token and prints all incoming events. Use PLAIPIN_TOKEN env var.
 */
import WebSocket from "ws";

const url = process.env.PLAIPIN_URL ?? "ws://127.0.0.1:48756";
const token = process.env.PLAIPIN_TOKEN;
if (!token) {
  console.error("Set PLAIPIN_TOKEN (use the bootstrap token printed by the daemon)");
  process.exit(1);
}

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${token}` },
});

ws.on("open", () => {
  console.log("[esp32] connected");
  ws.send(JSON.stringify({ type: "hello", deviceId: "fake-esp32-01", fwVersion: "0.0.1-spike" }));
  setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 15_000).unref();
});
ws.on("message", (d) => {
  const text = d.toString("utf8");
  try {
    const obj = JSON.parse(text);
    console.log("[esp32 ⇐]", JSON.stringify(obj).slice(0, 400));
  } catch {
    console.log("[esp32 raw]", text.slice(0, 200));
  }
});
ws.on("close", (code, reason) => {
  console.log(`[esp32] closed code=${code} reason=${reason.toString()}`);
  process.exit(0);
});
ws.on("error", (e) => console.error("[esp32 err]", e.message));
