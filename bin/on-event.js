#!/usr/bin/env node
'use strict';
// Debounced autosave on herdr lifecycle events: at most one write per
// HERDR_RESURRECT_DEBOUNCE ms, keyed on last.json's mtime. Auto-restore lives in
// bin/on-startup.js; the only coupling left is the gate — while a startup restore
// is in flight, autosave must not overwrite the pre-boot snapshot with the
// freshly-restored bare-shell state. The gate self-heals (a stale marker is
// deleted and ignored), so autosave can never be suppressed permanently.
const fs = require('fs');
const gate = require('../lib/gate');
const { save } = require('../lib/snapshot');
const notify = require('../lib/notify');
const { LAST } = require('../lib/paths');

const DEBOUNCE_MS = Number(process.env.HERDR_RESURRECT_DEBOUNCE || 20000);

function main() {
  if (gate.active()) return; // startup restore under way — don't clobber its snapshot
  try { if (Date.now() - fs.statSync(LAST).mtimeMs < DEBOUNCE_MS) return; } catch { /* no last.json yet */ }
  let r;
  try { r = save(); } catch (e) {
    console.error('herdr-resurrect autosave failed:', e.message);
    notify.saveFailed(e, { auto: true });
    return;
  }
  notify.saved(r, { auto: true });
}

main();
