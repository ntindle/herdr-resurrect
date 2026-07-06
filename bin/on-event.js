#!/usr/bin/env node
'use strict';
// Single handler for herdr lifecycle events. Two jobs:
//   1. Debounced autosave (<= 1 write / HERDR_RESURRECT_DEBOUNCE ms).
//   2. Optional one-shot auto-restore on the first event after a server (re)start.
//
// Ordering matters on boot: the good pre-crash snapshot must be READ before any
// autosave overwrites last.json with the post-crash bare-shell state. The boot
// "claimer" reads it first, stands other handlers down until restore is `done`.
const fs = require('fs');
const settings = require('../lib/settings').load();
const boot = require('../lib/boot');
const { save } = require('../lib/snapshot');
const { loadModel, restore } = require('../lib/restore');
const { LAST } = require('../lib/paths');

const DEBOUNCE_MS = Number(process.env.HERDR_RESURRECT_DEBOUNCE || 20000);

function autosaveDebounced() {
  try { if (Date.now() - fs.statSync(LAST).mtimeMs < DEBOUNCE_MS) return; } catch { /* no last.json yet */ }
  try { save(); } catch (e) { console.error('herdr-resurrect autosave failed:', e.message); }
}

async function main() {
  if (!settings.autoRestore) return autosaveDebounced();

  const token = boot.token();
  if (!token) return autosaveDebounced();          // can't detect boots -> just autosave

  const st = boot.status(token);
  if (st === 'done') return autosaveDebounced();     // normal mid-session event
  if (st === 'restoring') return;                    // boot restore underway: skip autosave (would clobber snapshot)

  if (boot.claim(token) !== 'claimed') return;       // another handler just claimed the boot

  // We own this boot's restore. Capture the pre-crash snapshot before autosave can touch it.
  let model = null;
  try { model = loadModel(); } catch { /* nothing saved yet */ }

  if (model) {
    await new Promise((r) => setTimeout(r, settings.autoRestoreSettleMs)); // let herdr finish recreating panes
    try {
      const res = restore(model, { mode: 'rehydrate', log: (l) => console.log('[auto-restore] ' + l) });
      console.log(`herdr-resurrect: auto-restore ran ${res.actions.length} action(s) on boot`);
    } catch (e) {
      console.error('herdr-resurrect auto-restore failed:', e.message);
    }
  }
  boot.markDone(token);
  try { save(); } catch { /* refresh snapshot now that it's safe */ }
}

main();
