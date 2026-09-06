#!/usr/bin/env node
'use strict';
// Debounced autosave on herdr lifecycle events (<= 1 write / HERDR_RESURRECT_DEBOUNCE ms).
// Stands down while the startup hook (bin/on-startup.js) is still applying the
// pre-crash snapshot, so it can't be overwritten with bare-shell state first.
const fs = require('fs');
const boot = require('../lib/boot');
const { save } = require('../lib/snapshot');
const { LAST } = require('../lib/paths');

const DEBOUNCE_MS = Number(process.env.HERDR_RESURRECT_DEBOUNCE || 20000);

function main() {
  const token = boot.token();
  if (token && boot.restoring(token)) return;
  try { if (Date.now() - fs.statSync(LAST).mtimeMs < DEBOUNCE_MS) return; } catch { /* no last.json yet */ }
  try { save(); } catch (e) { console.error('herdr-resurrect autosave failed:', e.message); }
}

main();
