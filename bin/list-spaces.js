#!/usr/bin/env node
'use strict';
// List saved spaces.
//   (default)   human-readable, newest first.
//   --picker    tab-separated "slug\tname — summary" lines for an fzf picker.
const { listSpaces } = require('../lib/space');

const picker = process.argv.includes('--picker');

try {
  const spaces = listSpaces();
  if (picker) {
    for (const s of spaces) {
      const sum = s.summary
        ? `${s.summary.tabs}tab ${s.summary.panes}pane, ${s.summary.commands}cmd ${s.summary.agents}agent`
        : '(unreadable)';
      process.stdout.write(`${s.slug}\t${s.name}  —  ${sum}\n`);
    }
    process.exit(0);
  }
  if (!spaces.length) {
    console.log('herdr-resurrect: no saved spaces yet. Use the "save-space" action to make one.');
    process.exit(0);
  }
  console.log(`herdr-resurrect saved spaces (${spaces.length}):\n`);
  for (const s of spaces) {
    const when = s.saved_at ? new Date(s.saved_at).toLocaleString() : 'unknown';
    const sum = s.summary
      ? `${s.summary.tabs}tab ${s.summary.panes}pane — ${s.summary.commands} cmd, ${s.summary.agents} agent`
      : '(unreadable)';
    console.log(`  ${s.name}\n     ${when.padEnd(22)}  ${sum}\n     ${s.file}`);
  }
} catch (e) {
  console.error(`herdr-resurrect list-spaces failed: ${e.message}`);
  process.exit(1);
}
