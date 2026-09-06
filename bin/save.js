#!/usr/bin/env node
'use strict';
// Save a durable snapshot of the current herd.
// Invoked as an action, from the autosave pane, or by host events (--event, debounced).
const fs = require('fs');
const { save } = require('../lib/snapshot');
const { LAST } = require('../lib/paths');
const notify = require('../lib/notify');

const isEvent = process.argv.includes('--event');
const DEBOUNCE_MS = Number(process.env.HERDR_RESURRECT_DEBOUNCE || 20000);

function tooSoon() {
  try {
    const age = Date.now() - fs.statSync(LAST).mtimeMs;
    return age < DEBOUNCE_MS;
  } catch { return false; }
}

try {
  if (isEvent && tooSoon()) {
    // A snapshot was taken moments ago; skip to avoid thrashing on event storms.
    process.exit(0);
  }
  const r = save();
  console.log(
    `herdr-resurrect: saved ${r.panes} pane(s) — ${r.commands} command(s), ${r.agents} agent(s)\n  -> ${r.file}`
  );
  notify.saved(r, { auto: isEvent });
} catch (e) {
  console.error(`herdr-resurrect save failed: ${e.message}`);
  notify.saveFailed(e, { auto: isEvent });
  process.exit(1);
}
