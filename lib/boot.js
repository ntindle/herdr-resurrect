'use strict';
// Per-boot coordination for auto-restore.
//
// herdr has no "server ready" plugin event (yet), so we detect a fresh server boot
// from the socket file: herdr rewrites it on every start (its contents are a
// pid:nonce token, and the mtime changes too). The first plugin event after a boot
// "claims" that boot via an atomic lock file; the claimer performs the one-shot
// restore while other concurrent event handlers stand down until it's `done`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATE_DIR, ensureDirs } = require('./paths');

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

// Try to become the restorer for this boot. Returns 'claimed' | 'exists'.
function claim(t) {
  ensureDirs();
  cleanupOldLocks(t);
  const p = lockPath(t);
  try {
    const fd = fs.openSync(p, 'wx'); // atomic: fails if another handler already claimed
    fs.writeFileSync(fd, JSON.stringify({ token: t, status: 'restoring', ts: Date.now() }));
    fs.closeSync(fd);
    return 'claimed';
  } catch (e) {
    if (e.code === 'EEXIST') return 'exists';
    return 'exists'; // treat any lock error conservatively (don't double-restore)
  }
}

function status(t) {
  try { return JSON.parse(fs.readFileSync(lockPath(t), 'utf8')).status; } catch { return null; }
}

function markDone(t) {
  const p = lockPath(t);
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ token: t, status: 'done', ts: Date.now() }));
    fs.renameSync(tmp, p);
  } catch {}
}

module.exports = { socketPath, token, claim, status, markDone, lockPath };
