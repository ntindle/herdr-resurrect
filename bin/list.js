#!/usr/bin/env node
'use strict';
// List saved snapshots, newest last, with a one-line summary each.
const fs = require('fs');
const path = require('path');
const { SNAP_DIR, LAST } = require('../lib/paths');

function summarize(model) {
  let w = model.workspaces.length, t = 0, p = 0, c = 0, a = 0;
  for (const ws of model.workspaces)
    for (const tab of ws.tabs) {
      t++;
      for (const pane of tab.panes) {
        p++;
        if (pane.agent) a++;
        else if (pane.command && pane.command.restorable) c++;
      }
    }
  return `${w}ws ${t}tab ${p}pane — ${c} cmd, ${a} agent`;
}

try {
  const files = fs.existsSync(SNAP_DIR)
    ? fs.readdirSync(SNAP_DIR).filter((f) => /^snapshot-.*\.json$/.test(f)).sort()
    : [];
  if (!files.length) {
    console.log('herdr-resurrect: no snapshots yet. Run the "save" action to make one.');
    process.exit(0);
  }
  // last.json is a copy, so mark the newest file (names are timestamp-sorted).
  const newest = files[files.length - 1];
  console.log(`herdr-resurrect snapshots (${files.length}) in ${SNAP_DIR}:\n`);
  for (const f of files) {
    const full = path.join(SNAP_DIR, f);
    let line;
    try {
      const model = JSON.parse(fs.readFileSync(full, 'utf8'));
      line = `${new Date(model.saved_at).toLocaleString().padEnd(22)}  ${summarize(model)}`;
    } catch {
      line = '(unreadable)';
    }
    const marker = f === newest ? ' *' : '  ';
    console.log(`${marker} ${f}\n     ${line}`);
  }
  console.log('\n( * = most recent / what "restore" uses )');
} catch (e) {
  console.error(`herdr-resurrect list failed: ${e.message}`);
  process.exit(1);
}
