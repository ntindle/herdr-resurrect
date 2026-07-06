#!/usr/bin/env node
'use strict';
// Long-lived autosave loop (tmux-continuum style). Runs in its own pane; snapshots
// every HERDR_RESURRECT_INTERVAL seconds and once more on exit. Keep this pane open.
const { save } = require('../lib/snapshot');

const INTERVAL = Math.max(30, Number(process.env.HERDR_RESURRECT_INTERVAL || 900)) * 1000;

function tick(reason) {
  try {
    const r = save();
    console.log(`[${new Date().toLocaleTimeString()}] ${reason}: ${r.panes} pane(s), ${r.commands} cmd, ${r.agents} agent -> ${r.file.split(/[\\/]/).pop()}`);
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] save failed: ${e.message}`);
  }
}

console.log(`herdr-resurrect autosave: every ${INTERVAL / 1000}s. Close this pane to stop.\n`);
tick('startup');
const timer = setInterval(() => tick('autosave'), INTERVAL);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    clearInterval(timer);
    tick('shutdown');
    process.exit(0);
  });
}
