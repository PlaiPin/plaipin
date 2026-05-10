#!/bin/sh
# plaipin codex-shim (POSIX shell, spike version)
#
# Codex.app spawns this binary because we set CODEX_CLI_PATH to point at it.
# Our job:
#   1. If the invocation is `app-server` (the regular daemon spawn from
#      Codex.app's main process) AND the plaipin daemon socket exists,
#      redirect via `<real_codex> app-server proxy --sock $DSOCK`.
#   2. Otherwise (any other subcommand, or daemon not running):
#      exec the real codex untouched.
#
# Never crash. If anything is wrong, fall back to direct `exec real_codex`.

set -u

# Locate the real codex binary.
real_codex=""
if [ -n "${PLAIPIN_REAL_CODEX:-}" ] && [ -x "$PLAIPIN_REAL_CODEX" ]; then
  real_codex="$PLAIPIN_REAL_CODEX"
elif [ -x "/Applications/Codex.app/Contents/Resources/codex" ]; then
  real_codex="/Applications/Codex.app/Contents/Resources/codex"
else
  # last resort: $PATH lookup; if missing, exec will error and Codex.app will
  # show the failure (better than silent hang).
  real_codex="codex"
fi

# Determine the daemon socket path.
sock="${PLAIPIN_SOCK:-${PLAIPIN_HOME:-$HOME/.plaipin}/run/app-server.sock}"

# If first arg is `app-server` and there's no recognized sub-subcommand and
# the daemon socket exists, redirect through the proxy.
if [ "${1:-}" = "app-server" ]; then
  case "${2:-}" in
    proxy|generate-ts|generate-json-schema|help|"-h"|"--help")
      # Pass through unchanged — daemon does not own these.
      ;;
    *)
      if [ -S "$sock" ]; then
        # The codex `app-server proxy` subcommand is a raw byte forwarder
        # (designed for SSH stdio piping where Codex.app does WS framing
        # itself). Codex.app's Electron main expects plain NDJSON on
        # stdio though, so we need our own NDJSON↔WS bridge.
        bridge="$(dirname "$0")/codex-shim-bridge.js"
        if [ -x "$bridge" ] || [ -f "$bridge" ]; then
          exec node "$bridge" "$@"
        fi
        # If the bridge is missing for any reason, fall through.
      fi
      ;;
  esac
fi

exec "$real_codex" "$@"
