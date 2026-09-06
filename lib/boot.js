'use strict';
// Per-boot coordination between the startup hook (bin/on-startup.js, which performs
// the one-shot auto-restore) and the event hooks (bin/on-event.js, which autosave).
// The startup hook marks the boot `restoring` before it touches the session and
// `done` afterwards; event hooks skip autosave in between so the pre-crash snapshot
// isn't overwritten with bare-shell state before it has been applied.
//
// Locks are keyed by a per-boot token derived from herdr's socket file, which herdr
// rewrites on every server start (on Unix it's a real socket, so only its mtime is
// usable), so a lock left behind by a crashed hook can't outlive its own boot.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATE_DIR, ensureDirs } = require('./paths');

// A `restoring` lock older than this is treated as abandoned (the hook died).
const STALE_MS = 10 * 60 * 1000;

function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  // Fallbacks for running scripts by hand (herdr injects the env var at runtime).
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA)
    candidates.push(path.join(process.env.APPDATA, 'herdr', 'herdr.sock'));
  if (process.env.XDG_RUNTIME_DIR) candidates.push(path.join(process.env.XDG_RUNTIME_DIR, 'herdr', 'herdr.sock'));
  candidates.push(path.join(os.homedir(), '.herdr', 'herdr.sock'));
  return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}

// A string that changes whenever the server restarts, or null if we can't tell.
function token() {
  const sp = socketPath();
  if (!sp) return null;
  try {
    const content = fs.readFileSync(sp, 'utf8').trim();
    const mtime = fs.statSync(sp).mtimeMs;
    return `${content}@${Math.round(mtime)}`;
  } catch {
    try { return `mtime@${Math.round(fs.statSync(sp).mtimeMs)}`; } catch { return null; }
  }
}

const sanitize = (t) => String(t).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80);
const lockPath = (t) => path.join(STATE_DIR, `.boot-${sanitize(t)}.lock`);

// Remove locks from previous boots so the dir doesn't accumulate.
function cleanupOldLocks(keepToken) {
  const keep = keepToken ? path.basename(lockPath(keepToken)) : null;
  try {
    for (const f of fs.readdirSync(STATE_DIR))
      if (f.startsWith('.boot-') && f !== keep) { try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch {} }
  } catch {}
}

function write(t, status) {
  const p = lockPath(t);
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ token: t, status, ts: Date.now() }));
    fs.renameSync(tmp, p);
  } catch {}
}

// Startup hook: this boot's restore is underway.
function markRestoring(t) {
  ensureDirs();
  cleanupOldLocks(t);
  write(t, 'restoring');
}

function markDone(t) {
  write(t, 'done');
}

// Event hooks: is the startup hook still applying the snapshot for this boot?
function restoring(t) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(t), 'utf8'));
    return lock.status === 'restoring' && Date.now() - (lock.ts || 0) < STALE_MS;
  } catch { return false; }
}

module.exports = { socketPath, token, markRestoring, markDone, restoring, lockPath };
