#!/usr/bin/env node
'use strict';
// Save the current (or a given) workspace as a named, reusable space.
// Usage: node bin/save-space.js --name "<name>" [--workspace <id>]
//        node bin/save-space.js "<name>"
// The workspace id defaults to HERDR_RESURRECT_ORIGIN_WS / HERDR_WORKSPACE_ID,
// which the host injects for the invoking workspace.
const { saveSpace } = require('../lib/space');

const argv = process.argv.slice(2);
function opt(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const workspaceId =
  opt('--workspace') ||
  process.env.HERDR_RESURRECT_ORIGIN_WS ||
  process.env.HERDR_WORKSPACE_ID ||
  undefined;

// name: prefer --name, else the first bare (non-flag, non-flag-value) argument.
let name = opt('--name');
if (!name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { i++; continue; } // skip flag + its value
    name = a;
    break;
  }
}

try {
  if (!name || !name.trim()) throw new Error('a space name is required');
  const r = saveSpace({ workspaceId, name });
  const s = r.summary;
  console.log(
    `herdr-resurrect: saved space "${r.name}" ` +
      `(${s.tabs} tab, ${s.panes} pane — ${s.commands} cmd, ${s.agents} agent)\n  -> ${r.file}`
  );
} catch (e) {
  console.error(`herdr-resurrect save-space failed: ${e.message}`);
  process.exit(1);
}
