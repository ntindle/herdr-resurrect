#!/usr/bin/env bash
# Pane `open-space-ui`: fuzzy-pick a saved space (real TTY) and open it as a new
# workspace.
set -uo pipefail
root="${HERDR_PLUGIN_ROOT:?}"
die() { printf '%s\n' "$*" >&2; printf 'Press any key to close…' >&2; read -r -n1 _ 2>/dev/null || sleep 2; exit 1; }

command -v fzf >/dev/null 2>&1 || die "open-space: fzf is not installed or not on PATH."

lines="$(node "$root/bin/list-spaces.js" --picker 2>/dev/null)"
[ -n "$lines" ] || die "open-space: no saved spaces yet — use “save this space as…” first."

choice="$(
  printf '%s\n' "$lines" \
    | fzf --delimiter=$'\t' --with-nth=2 \
          --prompt='open space ▸ ' \
          --header='↑↓ select · enter open · esc cancel' \
          --reverse --cycle --no-multi --no-sort
)" || true
[ -n "$choice" ] || exit 0
slug="${choice%%$'\t'*}"

out="$(node "$root/bin/open-space.js" --name "$slug" 2>&1)" || die "$out"
printf '%s\n' "$out"
sleep 0.5
