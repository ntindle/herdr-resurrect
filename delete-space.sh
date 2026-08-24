#!/usr/bin/env bash
# Action `delete-space`: open the overlay that lets you pick a saved space to delete.
set -uo pipefail
herdr_bin="${HERDR_BIN_PATH:-herdr}"
plugin="${HERDR_PLUGIN_ID:-ntindle.herdr-resurrect}"
exec "$herdr_bin" plugin pane open --plugin "$plugin" --entrypoint delete-space-ui --placement overlay --focus
