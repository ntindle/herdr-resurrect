#!/usr/bin/env node
'use strict';
// Restore the session from a snapshot.
//   --dry-run            show the plan, change nothing
//   --recreate           always build workspaces from scratch
//   --rehydrate          only fill existing workspaces (herdr already restored the shape)
//   --file <path>        restore a specific snapshot (default: last.json)
// Default mode is "auto": rehydrate workspaces that already exist, recreate the rest.
const { loadModel, restore } = require('../lib/restore');

function parseArgs(argv) {
  const o = { mode: 'auto', dryRun: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') o.dryRun = true;
    else if (a === '--recreate') o.mode = 'recreate';
    else if (a === '--rehydrate') o.mode = 'rehydrate';
    else if (a === '--auto') o.mode = 'auto';
    else if (a === '--file') o.file = argv[++i];
  }
  return o;
}

try {
  const o = parseArgs(process.argv.slice(2));
  const model = loadModel(o.file);
  const when = new Date(model.saved_at).toLocaleString();
  console.log(
    `herdr-resurrect: restoring snapshot from ${when} ` +
    `(${model.workspaces.length} workspace(s))` + (o.dryRun ? '  [DRY RUN]' : '') + `\n`
  );
  const res = restore(model, { ...o, log: (line) => console.log('  ' + line) });
  console.log(
    `\nherdr-resurrect: ${o.dryRun ? 'would run' : 'ran'} ${res.actions.length} action(s). ` +
    res.steps.map((s) => `#${s.number}:${s.mode}`).join(' ')
  );
  if (o.dryRun) console.log('Re-run without --dry-run to apply.');
} catch (e) {
  console.error(`herdr-resurrect restore failed: ${e.message}`);
  process.exit(1);
}
