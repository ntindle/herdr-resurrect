#!/usr/bin/env bash
# Pane `save-space-ui`: prompt for a name (real TTY) and save the origin workspace.
set -uo pipefail
root="${HERDR_PLUGIN_ROOT:?}"
die() { printf '%s\n' "$*" >&2; printf 'Press any key to close…' >&2; read -r -n1 _ 2>/dev/null || sleep 2; exit 1; }

origin="${HERDR_RESURRECT_ORIGIN_WS:-${HERDR_WORKSPACE_ID:-}}"
printf 'Save this space as: '
IFS= read -r name || exit 0
name="${name#"${name%%[![:space:]]*}"}"; name="${name%"${name##*[![:space:]]}"}"
[ -n "$name" ] || exit 0

out="$(node "$root/bin/save-space.js" --workspace "$origin" --name "$name" 2>&1)" || die "$out"
printf '%s\n' "$out"
sleep 0.7
