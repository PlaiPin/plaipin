#!/usr/bin/env node
// plaipin codex-shim NDJSON↔WS bridge (invoked by codex-shim.sh).
//
// Codex.app's Electron main spawns the codex binary expecting newline-
// delimited JSON-RPC over stdio. Our daemon's app-server speaks JSON-RPC
// over WebSocket (over a unix socket). This shim bridges the two:
//
//   stdin  (NDJSON) ─────────► WebSocket text frames ─► daemon app-server
//   stdout (NDJSON) ◄───────── WebSocket text frames ─◄ daemon app-server
//
// We deliberately avoid TypeScript here — fewer deps, faster startup.
//
// Resilience contract: this process MUST NOT crash. If anything is wrong,
// log a single line to stderr and exit non-zero so Codex.app's parent
// observes the failure and can fall back to its built-in error handling.
//
// Args mirror what Codex.app passed; we ignore them and always speak v2.

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { existsSync } from "node:fs";

const SOCK = process.env.PLAIPIN_SOCK ||
  `${process.env.PLAIPIN_HOME || `${process.env.HOME}/.plaipin`}/run/app-server.sock`;
const WS_HOST = "codex-app-server";
const WS_PATH = "/rpc";

function bail(msg, code = 1) {
  process.stderr.write(`plaipin-shim: ${msg}\n`);
  process.exit(code);
}

if (!existsSync(SOCK)) bail(`daemon socket missing at ${SOCK}`, 2);

// Build the HTTP/1.1 Upgrade request manually so we can hand the upgraded
// socket to a WebSocket framer. Avoids pulling in `ws` (smaller install).
const key = crypto.randomBytes(16).toString("base64");
const expectedAccept = crypto
  .createHash("sha1")
  .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
  .digest("base64");

const req = http.request({
  createConnection: () => net.createConnection({ path: SOCK }),
  method: "GET",
  path: WS_PATH,
  headers: {
    Host: WS_HOST,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
  },
});

req.on("error", (e) => bail(`upgrade request failed: ${e.message}`));
req.on("response", (res) => bail(`server did not upgrade; status=${res.statusCode}`));

req.on("upgrade", (res, socket /*, head */) => {
  if (res.headers["sec-websocket-accept"] !== expectedAccept) {
    bail("invalid Sec-WebSocket-Accept");
  }
  // Tiny WebSocket framer (text frames only, client→server masked, no extensions).
  // Codex's app-server uses no permessage-deflate (we never advertise it).

  // ===== outbound: NDJSON line → WS text frame =====
  let inBuf = "";
  process.stdin.on("data", (chunk) => {
    inBuf += chunk.toString("utf8");
    let idx;
    while ((idx = inBuf.indexOf("\n")) >= 0) {
      const line = inBuf.slice(0, idx).trim();
      inBuf = inBuf.slice(idx + 1);
      if (!line) continue;
      sendTextFrame(socket, line);
    }
  });
  process.stdin.on("end", () => {
    sendCloseFrame(socket);
    socket.end();
  });

  // ===== inbound: WS frames → NDJSON lines on stdout =====
  let recvBuf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    while (true) {
      const parsed = tryParseFrame(recvBuf);
      if (!parsed) break;
      recvBuf = recvBuf.slice(parsed.totalLen);
      if (parsed.opcode === 0x1 /* text */) {
        process.stdout.write(parsed.payload.toString("utf8") + "\n");
      } else if (parsed.opcode === 0x8 /* close */) {
        socket.end();
        process.exit(0);
      } else if (parsed.opcode === 0x9 /* ping */) {
        sendPongFrame(socket, parsed.payload);
      }
      // ignore pong (0xA) and binary (0x2)
    }
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", (e) => bail(`socket error: ${e.message}`, 3));
});

req.end();

// =====================================================================
// WebSocket framer (RFC 6455, the bare minimum we need)
// =====================================================================

function sendTextFrame(sock, text) {
  const payload = Buffer.from(text, "utf8");
  sock.write(buildFrame(0x1, payload, true));
}
function sendPongFrame(sock, payload) {
  sock.write(buildFrame(0xa, payload, true));
}
function sendCloseFrame(sock) {
  sock.write(buildFrame(0x8, Buffer.alloc(0), true));
}

function buildFrame(opcode, payload, masked) {
  const len = payload.length;
  let header;
  let lenBytes;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | len]);
    lenBytes = Buffer.alloc(0);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | 126]);
    lenBytes = Buffer.alloc(2);
    lenBytes.writeUInt16BE(len, 0);
  } else {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | 127]);
    lenBytes = Buffer.alloc(8);
    lenBytes.writeBigUInt64BE(BigInt(len), 0);
  }
  if (!masked) return Buffer.concat([header, lenBytes, payload]);
  const mask = crypto.randomBytes(4);
  const masked2 = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked2[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, lenBytes, mask, masked2]);
}

function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0],
    b1 = buf[1];
  // const fin = (b0 & 0x80) !== 0;  // we assume fin=1; codex doesn't fragment
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let pos = 2;
  if (len === 126) {
    if (buf.length < pos + 2) return null;
    len = buf.readUInt16BE(pos);
    pos += 2;
  } else if (len === 127) {
    if (buf.length < pos + 8) return null;
    const big = buf.readBigUInt64BE(pos);
    if (big > BigInt(2 ** 31)) return null; // sanity
    len = Number(big);
    pos += 8;
  }
  let mask = null;
  if (masked) {
    if (buf.length < pos + 4) return null;
    mask = buf.slice(pos, pos + 4);
    pos += 4;
  }
  if (buf.length < pos + len) return null;
  let payload = buf.slice(pos, pos + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { opcode, payload, totalLen: pos + len };
}
