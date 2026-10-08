'use strict';
// Autosave suppression while a startup restore is in flight. A single marker file
// replaces the old per-boot lock protocol (lib/boot.js): bin/on-startup.js creates
// the marker, rehydrates, and removes it; event handlers skip autosave while it
// exists so they can't overwrite the pre-boot snapshot mid-restore.
//
// Self-healing is the point. The old lock could stay "restoring" forever if the
// claiming handler died between claim() and markDone(), silently disabling autosave
// for the entire session. Here a marker older than MAX_AGE_MS is treated as debris
// from a crashed restore: deleted and ignored, never obeyed. The holder must call
// start() again after any long wait (bin/on-startup.js refreshes it after the
// settle sleep and before its final save) so a slow restore is not mistaken for
// debris.
const fs = require('fs');
const path = require('path');
const { SESSION_DIR, ensureDirs } = require('./paths');

const MARKER = path.join(SESSION_DIR, '.restore-in-progress');
const MAX_AGE_MS = 5 * 60 * 1000;

function start() {
  ensureDirs();
  try { fs.writeFileSync(MARKER, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch {}
}

function clear() {
  try { fs.unlinkSync(MARKER); } catch {}
}

function active(maxAgeMs = MAX_AGE_MS) {
  let st;
  try { st = fs.statSync(MARKER); } catch { return false; }
  if (Date.now() - st.mtimeMs <= maxAgeMs) return true;
  clear(); // stale marker from a crashed restore — heal instead of suppressing forever
  return false;
}

module.exports = { start, clear, active, MARKER, MAX_AGE_MS };
