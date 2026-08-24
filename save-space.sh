#!/usr/bin/env bash
# Action `save-space`: open the overlay that prompts for a name and saves THIS
# workspace. Runs on the herdr server (no TTY), so the interactive prompt lives in
# the overlay pane (save-space-ui). We forward the origin workspace id + cwd, since
# the overlay is technically its own pane.
set -uo pipefail
herdr_bin="${HERDR_BIN_PATH:-herdr}"
plugin="${HERDR_PLUGIN_ID:-ntindle.herdr-resurrect}"
ctx="${HERDR_PLUGIN_CONTEXT_JSON:-}"

ws="${HERDR_WORKSPACE_ID:-}"
cwd="${HERDR_WORKSPACE_CWD:-}"
if [ -n "$ctx" ] && command -v jq >/dev/null 2>&1; then
  [ -n "$ws" ]  || ws="$(printf '%s' "$ctx"  | jq -r '.workspace_id // empty' 2>/dev/null || true)"
  [ -n "$cwd" ] || cwd="$(printf '%s' "$ctx" | jq -r '.workspace_cwd // empty' 2>/dev/null || true)"
fi

set -- plugin pane open --plugin "$plugin" --entrypoint save-space-ui --placement overlay --focus
[ -n "$ws" ]  && set -- "$@" --env "HERDR_RESURRECT_ORIGIN_WS=$ws"
[ -n "$cwd" ] && [ -d "$cwd" ] && set -- "$@" --cwd "$cwd"
exec "$herdr_bin" "$@"
