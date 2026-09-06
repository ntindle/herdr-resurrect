'use strict';
// Where the plugin keeps its durable state and user config. The host injects
// HERDR_PLUGIN_STATE_DIR / HERDR_PLUGIN_CONFIG_DIR; we fall back to sane per-user
// locations so the scripts also work when run by hand (e.g. `node bin/save.js`).
//
// The state dir is one per plugin, shared by every herdr session (`herdr --session
// <name>`), so crash-recovery snapshots are scoped under sessions/<session>/. Two
// servers autosaving into one last.json would otherwise restore each other's herd.
// Saved spaces are a library the user picks from by name and stay shared.
const os = require('os');
const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..');

const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  path.join(os.homedir(), '.local', 'state', 'herdr-resurrect');

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ||
  path.join(os.homedir(), '.config', 'herdr-resurrect');

// herdr keeps one API socket per session: <config>/herdr.sock for the default
// session and <config>/sessions/<name>/herdr.sock for named ones. HERDR_SOCKET_PATH
// is the only per-session value every plugin process is handed, so the session name
// comes from it. Off-herdr (no socket path) honor HERDR_SESSION, the CLI's own
// selector, with the same precedence the herdr CLI uses.
const safeName = (s) => {
  const t = String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return t && t !== '.' && t !== '..' ? t : 'default';
};
function sessionName() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (sock) {
    const dir = path.dirname(sock);
    return path.basename(path.dirname(dir)) === 'sessions' ? safeName(path.basename(dir)) : 'default';
  }
  return safeName(process.env.HERDR_SESSION || 'default');
}

const SESSION = sessionName();
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const SESSION_DIR = path.join(SESSIONS_DIR, SESSION);
const SNAP_DIR = path.join(SESSION_DIR, 'snapshots');
const LAST = path.join(SESSION_DIR, 'last.json');
// Named, user-saved single-workspace snapshots ("spaces"), one file per name.
// These are a library of reusable layouts, distinct from the crash-recovery
// snapshots in SNAP_DIR.
const SPACES_DIR = path.join(STATE_DIR, 'spaces');

// Before sessions were scoped, snapshots/, last.json and the boot locks sat directly
// in STATE_DIR. Adopt them as the default session's state so an upgrade keeps its
// restore point; the locks are per-boot and just go. Renames are atomic, so two
// handlers racing here leave one winner and one harmless ENOENT.
function migrateLegacyState() {
  const legacySnaps = path.join(STATE_DIR, 'snapshots');
  const legacyLast = path.join(STATE_DIR, 'last.json');
  let entries;
  try { entries = fs.readdirSync(STATE_DIR); } catch { return; }
  const defaultDir = path.join(SESSIONS_DIR, 'default');
  if (entries.includes('snapshots')) {
    try { fs.mkdirSync(defaultDir, { recursive: true }); fs.renameSync(legacySnaps, path.join(defaultDir, 'snapshots')); } catch {}
  }
  if (entries.includes('last.json')) {
    try { fs.mkdirSync(defaultDir, { recursive: true }); fs.renameSync(legacyLast, path.join(defaultDir, 'last.json')); } catch {}
  }
  for (const f of entries)
    if (f.startsWith('.boot-')) { try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch {} }
}
migrateLegacyState();

function ensureDirs() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function ensureSpacesDir() {
  fs.mkdirSync(SPACES_DIR, { recursive: true });
}

module.exports = {
  PLUGIN_ROOT, STATE_DIR, CONFIG_DIR, SESSION, SESSION_DIR, SNAP_DIR, LAST, SPACES_DIR,
  ensureDirs, ensureSpacesDir,
};
