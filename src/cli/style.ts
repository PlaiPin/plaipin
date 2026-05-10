// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Centralized CLI style + branding.
//
// Two priorities:
//   1. Consistent visual vocabulary (one set of status glyphs / colors used
//      everywhere — change one constant, all CLI output updates).
//   2. Faithful degradation for non-TTY / NO_COLOR / dumb terminals — we
//      MUST stay scrapable when piped to a file or grep.
//
// All ANSI / color emission flows through `pc` from picocolors, which
// honors NO_COLOR and isTTY automatically. Spinners come from ora, which
// also detects TTY and degrades to no-op when piped.
//
// IMPORTANT: don't import this module from src/daemon/* — daemon logs go
// through pino with its own formatting. This is CLI-only.

import pc from "picocolors";
import { PACKAGE_VERSION } from "../shared/version.js";
import ora, { type Ora } from "ora";

// -------------------------------------------------------------------
// TTY + capability detection
// -------------------------------------------------------------------

/** True if stdout is an interactive terminal (not piped, not redirected). */
export const isTTY: boolean = Boolean(process.stdout.isTTY);

/** True if we should suppress ANSI color emission (NO_COLOR, dumb term, no TTY). */
export const noColor: boolean =
  !isTTY ||
  process.env.NO_COLOR != null ||
  process.env.TERM === "dumb";

/** Width of the terminal in columns, or 80 as a safe fallback. */
export function termWidth(): number {
  return process.stdout.columns ?? 80;
}

// -------------------------------------------------------------------
// Status glyphs — semantic names; changing the glyph set is one-line
// -------------------------------------------------------------------
// Pure Unicode (no emoji, no Nerd Font dependencies). Fallback to ASCII
// only on truly dumb terminals or when explicitly requested via
// PLAIPIN_NO_UNICODE — Unicode bytes pass cleanly through pipes,
// log files, etc., so we don't gate on TTY here.

const useUnicode =
  process.env.TERM !== "dumb" && process.env.PLAIPIN_NO_UNICODE == null;

export const glyph = {
  /** Success — completed action that worked. */
  ok: useUnicode ? "✓" : "[ok]",
  /** Failure — something errored. */
  fail: useUnicode ? "✗" : "[!!]",
  /** Warning — non-fatal degradation or note. */
  warn: useUnicode ? "⚠" : "[!]",
  /** Informational — neutral side-context. */
  info: useUnicode ? "ⓘ" : "[i]",
  /** Action / step — "doing X right now". */
  action: useUnicode ? "▸" : ">",
  /** Inline progress placeholder (replaced by ora's spinner frames). */
  progress: useUnicode ? "⠿" : "...",
  /** Online status indicator (filled circle). */
  dotOn: useUnicode ? "●" : "[on]",
  /** Offline status indicator (outline circle). */
  dotOff: useUnicode ? "○" : "[off]",
  /** Revoked / disabled (struck circle). */
  dotRevoked: useUnicode ? "⊘" : "[x]",
  /** Bullet / list item. */
  bullet: useUnicode ? "·" : "*",
} as const;

// -------------------------------------------------------------------
// Color helpers — semantic, not literal. Use these everywhere.
// -------------------------------------------------------------------
// `pc.green(...)` etc. are no-ops when noColor is true.

export const color = {
  ok: pc.green,
  fail: pc.red,
  warn: pc.yellow,
  info: pc.dim,
  action: pc.cyan,
  brand: pc.magenta,
  subBrand: pc.dim,
  emphasis: pc.bold,
  pathlike: pc.cyan,
  // For tail event types — six distinguishable hues
  tailUserMsg: pc.cyan,
  tailTurnBoundary: pc.bold,
  tailCommand: pc.blue,
  tailAgentText: pc.dim,
  tailApproval: pc.yellow,
  tailError: pc.red,
  tailPet: pc.magenta,
} as const;

// -------------------------------------------------------------------
// Status-line helpers — combine glyph + color + indent
// -------------------------------------------------------------------

const INDENT = "   "; // 3 spaces — same for all status lines

export function ok(text: string): string {
  return `${INDENT}${color.ok(glyph.ok)}  ${text}`;
}

export function fail(text: string): string {
  return `${INDENT}${color.fail(glyph.fail)}  ${text}`;
}

export function warn(text: string): string {
  return `${INDENT}${color.warn(glyph.warn)}  ${text}`;
}

export function info(text: string): string {
  return `${INDENT}${color.info(glyph.info + "  " + text)}`;
}

export function action(text: string): string {
  return `${INDENT}${color.action(glyph.action)}  ${text}`;
}

/**
 * Helper for "key: value" status lines — colored value, padded key.
 * Use after `ok()` / `warn()` to attach context details.
 *
 * Example:
 *   ok("Daemon running");
 *   detail("pid", "12345");      → "       pid 12345"
 */
export function detail(key: string, value: string): string {
  // 7 spaces = INDENT (3) + glyph (1) + double-space (2) + 1 of indent
  return `       ${color.info(key)} ${color.pathlike(value)}`;
}

// -------------------------------------------------------------------
// Branding — banner variants
// -------------------------------------------------------------------

/** Big banner — for setup, install, --help, no-args welcome. */
export function brandBanner(): string {
  // Total visible width INCLUDING the │ side borders. Capped so it fits
  // 80-col terminals with the standard 3-space indent applied by the
  // print helpers.
  const W = Math.min(termWidth() - 6, 60);
  const innerW = W - 2; // chars between the │ borders
  const bar = "─".repeat(innerW);

  const versionLine = "Codex pet companion · v" + PACKAGE_VERSION;
  return [
    `╭${bar}╮`,
    contentLine(W, "plaipin", color.brand(color.emphasis("plaipin"))),
    contentLine(W, "by PlaiPin", color.subBrand("by PlaiPin")),
    contentLine(W, versionLine, color.subBrand(versionLine)),
    `╰${bar}╯`,
  ].join("\n");
}

/**
 * Build a │-bordered content line with proper padding. `visible` is the
 * un-styled text used to compute width; `styled` is what we actually
 * print (may contain ANSI escapes, which don't take visual columns).
 */
function contentLine(W: number, visible: string, styled: string): string {
  // Layout: │ + 2sp + visible + pad + 1sp + │ → total = W
  const pad = Math.max(0, W - 5 - visible.length);
  return `│  ${styled}${" ".repeat(pad)} │`;
}

/** One-line brand — for doctor, device add, tail headers. */
export function brandLine(subtitle?: string): string {
  const head = `${color.action(glyph.progress)} ${color.brand(color.emphasis("plaipin"))} ${color.subBrand("· by PlaiPin")}`;
  return subtitle ? `${head} ${color.subBrand("· " + subtitle)}` : head;
}

// -------------------------------------------------------------------
// Spinner — wraps ora with a creature-themed frame set
// -------------------------------------------------------------------
// `creatureSpinner` rotates through frames that suggest a small egg /
// pet looking around. The 4-frame rotation is deliberate — it reads as
// "alive" without being distracting. ora handles TTY detection and
// SIGINT cleanup; our job is just frame design.
//
// On non-TTY environments, ora silently no-ops and the .text attribute
// can still be read; we use start()/succeed()/fail() as documented.

const CREATURE_FRAMES = useUnicode
  ? ["◓", "◑", "◒", "◐"] // rotating filled-half circle — egg-like
  : ["|", "/", "-", "\\"]; // ASCII fallback

const CREATURE_INTERVAL_MS = 140;

/** Start a spinner with the creature frame set. Returns the ora instance. */
export function spinner(text: string): Ora {
  return ora({
    text,
    color: "magenta",
    spinner: { frames: CREATURE_FRAMES, interval: CREATURE_INTERVAL_MS },
    isEnabled: isTTY && !noColor,
  });
}

// -------------------------------------------------------------------
// Walking-creature track
// -------------------------------------------------------------------
// A horizontal track in which a small creature glyph ping-pongs left
// and right. Designed for use during long polling waits (e.g.
// waitForConnect during `device add`). Uses TWO-frame walk-cycle
// alternation per step to suggest motion.
//
// Constraints:
//   - Width is bounded so it fits in 80 cols even with surrounding text
//   - Renders only on TTY (no-op otherwise)
//   - Single-line, uses \r carriage return + ansi clear-line for redraw
//   - Caller is responsible for calling .stop() in finally / on error
//   - Frame rate ~120ms (8 fps) — fast enough to feel alive, slow enough
//     to not flicker on Apple Terminal

const TRACK_WIDTH = 18; // chars between brackets
const WALK_FRAMES = useUnicode ? ["◓", "◑"] : ["o", "O"]; // alternates per step
const WALK_INTERVAL_MS = 150;

export interface WalkingCreature {
  /** Update the suffix shown after the track (e.g. "12s left"). */
  setSuffix(suffix: string): void;
  /** Stop animation and clear the line. */
  stop(): void;
}

/**
 * Start a walking-creature animation in stdout. Returns a handle so
 * callers can update the suffix text (e.g. countdown) and stop it.
 *
 * If we're not on a TTY, returns a no-op handle — the caller flow is
 * unchanged. They should also print a one-shot "still waiting" line
 * elsewhere for non-TTY visibility (or just rely on the final ✓).
 */
export function startWalkingCreature(
  prefix: string,
  initialSuffix: string,
): WalkingCreature {
  if (!isTTY || noColor) {
    return { setSuffix: () => {}, stop: () => {} };
  }

  let pos = 0;
  let dir: 1 | -1 = 1;
  let frameIdx = 0;
  let suffix = initialSuffix;

  const render = (): void => {
    const left = " ".repeat(pos);
    const right = " ".repeat(TRACK_WIDTH - pos - 1);
    const creature = color.brand(WALK_FRAMES[frameIdx]!);
    const line = `${prefix} [${left}${creature}${right}] ${color.info(suffix)}`;
    // \r returns to start of line; \x1b[2K clears the entire line first
    // so if the suffix shrinks we don't leave artifacts.
    process.stdout.write(`\r\x1b[2K${line}`);
  };

  const tick = (): void => {
    pos += dir;
    if (pos >= TRACK_WIDTH - 1) {
      pos = TRACK_WIDTH - 1;
      dir = -1;
    } else if (pos <= 0) {
      pos = 0;
      dir = 1;
    }
    frameIdx = (frameIdx + 1) % WALK_FRAMES.length;
    render();
  };

  render();
  const interval = setInterval(tick, WALK_INTERVAL_MS);

  return {
    setSuffix(s: string): void {
      suffix = s;
    },
    stop(): void {
      clearInterval(interval);
      // Clear the line so the caller's next println starts clean
      process.stdout.write("\r\x1b[2K");
    },
  };
}

// -------------------------------------------------------------------
// Convenience println — applies indent, no extras
// -------------------------------------------------------------------
// Plain print at the same indent as ok()/warn()/etc. for body text
// inside a section.

export function pln(text = ""): void {
  if (text) {
    console.log(`${INDENT}${text}`);
  } else {
    console.log("");
  }
}

/** Print a section header — bolded, no glyph, slightly looser spacing. */
export function header(text: string): void {
  console.log("");
  console.log(`${INDENT}${color.emphasis(text)}`);
  console.log("");
}

/** Print the small one-line brand header for a command. */
export function printBrandLine(subtitle?: string): void {
  console.log("");
  console.log(`${INDENT}${brandLine(subtitle)}`);
  console.log("");
}

/** Print the big banner. Use for setup / install / no-args. */
export function printBrandBanner(): void {
  console.log("");
  for (const line of brandBanner().split("\n")) {
    console.log(`${INDENT}${line}`);
  }
  console.log("");
}
