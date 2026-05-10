// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Send a single approval decision to the running daemon, then exit.
// Lets you simulate an ESP32 approval button press from the CLI — useful
// for verifying the daemon → app-server → desktop UI dismissal path
// without flashing firmware.

import WebSocket from "ws";
import { ensureBootstrapToken } from "../daemon/auth.js";

const VALID_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const;
type Decision = (typeof VALID_DECISIONS)[number];

interface ApproveOpts {
  host: string;
  port: string;
}

export async function cmdApprove(idArg: string, decisionArg: string, opts: ApproveOpts): Promise<void> {
  if (!VALID_DECISIONS.includes(decisionArg as Decision)) {
    console.error(`decision must be one of: ${VALID_DECISIONS.join(", ")}`);
    process.exit(2);
  }
  // Approval IDs in the protocol are number | string. Try numeric coercion;
  // fall back to raw string if not a number.
  const id: number | string = /^-?\d+$/.test(idArg) ? Number(idArg) : idArg;

  const token = ensureBootstrapToken();
  const url = `ws://${opts.host}:${opts.port}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

  let resolved = false;
  const finish = (code: number) => {
    if (resolved) return;
    resolved = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "approval_decide", id, decision: decisionArg }));
    console.log(`sent: approval_decide id=${JSON.stringify(id)} decision=${decisionArg}`);
  });
  ws.on("message", (data) => {
    const text = data.toString("utf8");
    try {
      const obj = JSON.parse(text);
      if (obj.type === "approval_resolved" && JSON.stringify(obj.id) === JSON.stringify(id)) {
        console.log(`resolved: by=${obj.by}${obj.decision ? ` decision=${obj.decision}` : ""}`);
        finish(0);
      }
    } catch {
      /* ignore */
    }
  });
  ws.on("error", (e) => {
    console.error(`error: ${e.message}`);
    finish(1);
  });
  ws.on("close", () => finish(resolved ? 0 : 1));

  // Safety: wait at most 5 s for the server to echo approval_resolved
  setTimeout(() => {
    if (!resolved) {
      console.error("timed out waiting for approval_resolved (sent OK, but server didn't echo within 5s)");
      finish(2);
    }
  }, 5000).unref();
}
