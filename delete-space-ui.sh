#!/usr/bin/env bash
# Pane `delete-space-ui`: fuzzy-pick a saved space and delete it (with confirm).
set -uo pipefail
root="${HERDR_PLUGIN_ROOT:?}"
die() { printf '%s\n' "$*" >&2; printf 'Press any key to close…' >&2; read -r -n1 _ 2>/dev/null || sleep 2; exit 1; }
command -v fzf >/dev/null 2>&1 || die "delete-space: fzf is not installed or not on PATH."

lines="$(node "$root/bin/list-spaces.js" --picker 2>/dev/null)"
[ -n "$lines" ] || die "delete-space: no saved spaces to delete."

choice="$(
  printf '%s\n' "$lines" \
    | fzf --delimiter=$'\t' --with-nth=2 \
          --prompt='delete space ▸ ' \
          --header='↑↓ select · enter choose · esc cancel' \
          --reverse --cycle --no-multi --no-sort
)" || true
[ -n "$choice" ] || exit 0
slug="${choice%%$'\t'*}"
name="$(printf '%s' "${choice#*$'\t'}" | sed 's/  —.*//')"

printf 'Delete saved space "%s"? [y/N] ' "$name"
IFS= read -r ans || exit 0
case "$ans" in
  y|Y|yes|YES) ;;
  *) printf 'Cancelled.\n'; sleep 0.4; exit 0 ;;
esac
out="$(node "$root/bin/delete-space.js" --name "$slug" 2>&1)" || die "$out"
printf '%s\n' "$out"
sleep 0.5
