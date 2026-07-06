'use strict';
// Decides which foreground programs are safe to auto-relaunch on restore.
// Mirrors tmux-resurrect's `resurrect_processes`: an idle shell is never restored,
// agents go through the agent path, and everything else must be on the allowlist
// (or the allowlist must contain a single `*`).
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, PLUGIN_ROOT } = require('./paths');

const USER_ALLOWLIST = path.join(CONFIG_DIR, 'allowlist.txt');
const DEFAULT_ALLOWLIST = path.join(PLUGIN_ROOT, 'config', 'allowlist.default.txt');

// Common interactive shells — these mean "the pane is idle", nothing to restore.
const SHELLS = new Set([
  'sh', 'bash', 'dash', 'ash', 'zsh', 'fish', 'nu', 'nushell', 'elvish', 'xonsh',
  'pwsh', 'powershell', 'cmd', 'command', 'tcsh', 'csh', 'ksh', 'git-bash', 'busybox',
]);

function baseName(nameOrPath) {
  if (!nameOrPath) return '';
  let b = path.basename(String(nameOrPath));
  b = b.toLowerCase();
  if (b.endsWith('.exe')) b = b.slice(0, -4);
  return b;
}

let _cache = null;
function load() {
  if (_cache) return _cache;
  // Seed the user's editable copy from the packaged default on first use.
  try {
    if (!fs.existsSync(USER_ALLOWLIST) && fs.existsSync(DEFAULT_ALLOWLIST)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.copyFileSync(DEFAULT_ALLOWLIST, USER_ALLOWLIST);
    }
  } catch { /* non-fatal: fall back to reading the default in place */ }

  const file = fs.existsSync(USER_ALLOWLIST) ? USER_ALLOWLIST : DEFAULT_ALLOWLIST;
  let names = [];
  try {
    names = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => baseName(l));
  } catch { names = []; }

  _cache = { all: names.includes('*'), set: new Set(names) };
  return _cache;
}

function isShell(fg) {
  return SHELLS.has(baseName(fg && (fg.name || fg.argv0)));
}

function restorable(fg) {
  if (!fg) return false;
  const { all, set } = load();
  if (all) return true;
  const n = baseName(fg.name || fg.argv0);
  if (set.has(n)) return true;
  // also match on argv0 basename in case `name` was truncated by the OS
  return set.has(baseName(fg.argv0));
}

module.exports = { load, isShell, restorable, baseName, SHELLS };
