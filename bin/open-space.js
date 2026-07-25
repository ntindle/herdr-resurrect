#!/usr/bin/env node
'use strict';
// Open a saved space as a brand-new workspace.
// Usage: node bin/open-space.js --name "<name>" [--dry-run]
//        node bin/open-space.js "<name>"
const { openSpace } = require('../lib/space');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
function opt(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

let name = opt('--name');
if (!name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { i++; continue; }
    name = a;
    break;
  }
}

try {
  if (!name || !name.trim()) throw new Error('a space name is required');
  const { result } = openSpace(name, { dryRun, log: (line) => console.log(`  ${line}`) });
  const n = result.actions.length;
  console.log(
    dryRun
      ? `herdr-resurrect: would open space "${name}" (${n} step(s) — dry run)`
      : `herdr-resurrect: opened space "${name}" (${n} step(s))`
  );
} catch (e) {
  console.error(`herdr-resurrect open-space failed: ${e.message}`);
  process.exit(1);
}
