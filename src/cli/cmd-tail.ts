// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// `plaipin tail` — connect to the daemon's ESP32-facing WS as a
// generic client (using the bootstrap token) and print every event.
// Useful for debugging the wire from your terminal without flashing
// firmware. Same auth path an ESP32 would take — what you see here is
// what an ESP32 would see.

import WebSocket from "ws";
import { ensureBootstrapToken } from "../daemon/auth.js";
import { color, glyph, isTTY, printBrandLine } from "./style.js";

interface TailOpts {
  host: string;
  port: string;
}

/**
 * Map a wire-event `type` to a (1-char prefix, color) pair. New event
 * types degrade to a neutral rendering — keeps `tail` future-proof
 * against protocol additions without code changes here.
 */
function styleEvent(type: string): { prefix: string; paint: (s: string) => string } {
  switch (type) {
    case "user_message":
      return { prefix: "→", paint: color.tailUserMsg };
    case "turn_started":
      return { prefix: "▸", paint: color.tailTurnBoundary };
    case "turn_done":
      return { prefix: "✓", paint: color.tailTurnBoundary };
    case "command_started":
    case "command_done":
      return { prefix: "⚙", paint: color.tailCommand };
    case "command_output_chunk":
      return { prefix: "·", paint: color.tailCommand };
    case "agent_text_chunk":
    case "agent_text_done":
      return { prefix: "…", paint: color.tailAgentText };
    case "tool_started":
    case "tool_done":
      return { prefix: "⚒", paint: color.tailCommand };
    case "approval_required":
      return { prefix: glyph.warn, paint: color.tailApproval };
    case "approval_resolved":
    case "approval_stale":
      return { prefix: "✓", paint: color.tailApproval };
    case "error":
      return { prefix: glyph.fail, paint: color.tailError };
    case "degraded":
      return { prefix: glyph.warn, paint: color.tailError };
    case "pet_state":
      return { prefix: "🜨", paint: color.tailPet };
    case "thread_status":
    case "thread_focus":
      return { prefix: "·", paint: color.info };
    case "welcome":
      return { prefix: glyph.action, paint: color.action };
    case "stats_updated":
    case "token_usage":
    case "context_compacted":
    case "file_changed":
      return { prefix: "·", paint: color.info };
    case "pong":
      return { prefix: "·", paint: color.info };
    default:
      return { prefix: "·", paint: color.info };
  }
}

/**
 * Render a parsed event for human reading. Strips the noise (full
 * threadIds, etc.), keeps the most-useful fields. Falls back to
 * compact JSON for unknown shapes.
 */
function renderEvent(obj: { type?: unknown; [k: string]: unknown }): string {
  const type = typeof obj.type === "string" ? obj.type : "?";
  const { prefix, paint } = styleEvent(type);
  const head = `${paint(prefix)}  ${paint(type.padEnd(20))}`;
  // Build a short summary depending on type. Each branch picks the
  // 1-3 fields most useful to a human glancing at the stream.
  let summary: string;
  switch (type) {
    case "agent_text_chunk":
    case "agent_text_done": {
      const text = (obj.text ?? obj.summary ?? "") as string;
      const phase = obj.phase ?? "";
      summary = `${color.info(`[${phase || "?"}]`)} ${text}`;
      break;
    }
    case "user_message":
      summary = String(obj.text ?? "");
      break;
    case "command_started":
      summary = `${String(obj.summary ?? "")} ${color.info(`(cwd ${obj.cwd ?? "?"})`)}`;
      break;
    case "command_done":
      summary = `exit ${obj.exitCode ?? "?"}`;
      break;
    case "turn_started":
      summary = String(obj.turnId ?? "");
      break;
    case "turn_done":
      summary = `${String(obj.summary ?? "?")} ${color.info(`· ${obj.durationMs ?? "?"}ms`)}`;
      break;
    case "approval_required":
      summary = `id ${obj.id} · ${obj.kind} · ${String(obj.summary ?? "")}`;
      break;
    case "approval_resolved":
      summary = `id ${obj.id} · ${obj.decision ?? obj.by ?? ""}`;
      break;
    case "approval_stale":
      summary = `id ${obj.id}`;
      break;
    case "pet_state": {
      const tr = obj.transientState ? ` + transient=${obj.transientState}` : "";
      summary = `state=${obj.state}${tr} ${color.info(`(${obj.reason ?? ""})`)}`;
      break;
    }
    case "tool_started":
    case "tool_done": {
      const label = obj.label ? ` "${obj.label}"` : "";
      summary = `${obj.kind ?? "?"}${label}`;
      break;
    }
    case "error":
    case "degraded":
      summary = String(obj.message ?? obj.reason ?? "");
      break;
    case "welcome":
      summary = color.info("snapshot received");
      break;
    case "thread_focus":
      summary = `${String(obj.name ?? "(no name)")} ${color.info(String(obj.threadId ?? ""))}`;
      break;
    case "thread_status":
      summary = `${String(obj.status ?? "?")}`;
      break;
    case "pong":
      return ""; // Suppress pong by default — too noisy
    default:
      summary = JSON.stringify(obj).slice(0, 120);
      break;
  }
  return `${head} ${summary}`;
}

export async function cmdTail(opts: TailOpts): Promise<void> {
  const token = ensureBootstrapToken();
  const url = `ws://${opts.host}:${opts.port}`;

  if (isTTY) {
    printBrandLine("tail · live event stream");
    console.error(color.info(`   connecting to ${url}`));
  } else {
    // Non-TTY: keep the original silent connect-line (compatible with
    // existing scrapers that expect the parenthesized status lines).
    console.error(`(connecting to ${url})`);
  }

  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

  ws.on("open", () => {
    if (isTTY) console.error(color.ok(`   ${glyph.ok} connected`));
    else console.error("(connected)");
  });

  ws.on("message", (data) => {
    const text = data.toString("utf8");
    if (!isTTY) {
      // Non-TTY: emit raw JSON line for grep/jq compatibility.
      try {
        const obj = JSON.parse(text);
        console.log(JSON.stringify(obj));
      } catch {
        console.log(text);
      }
      return;
    }
    try {
      const obj = JSON.parse(text);
      const line = renderEvent(obj);
      if (line) console.log(line);
    } catch {
      console.log(color.info(text));
    }
  });

  ws.on("close", (code, reason) => {
    if (isTTY) {
      console.error(color.info(`   closed ${code} ${reason.toString()}`));
    } else {
      console.error(`(closed ${code} ${reason.toString()})`);
    }
    process.exit(0);
  });

  ws.on("error", (e) => {
    console.error(isTTY ? color.fail(`   ${glyph.fail} ${e.message}`) : `error: ${e.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    ws.close();
    setTimeout(() => process.exit(0), 100).unref();
  });
}
