#!/usr/bin/env node
'use strict';
// Delete a saved space.  Usage: node bin/delete-space.js --name "<name>"
const { deleteSpace } = require('../lib/space');
const argv = process.argv.slice(2);
function opt(f) { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; }
let name = opt('--name');
if (!name) for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { i++; continue; } name = argv[i]; break; }
try {
  if (!name || !name.trim()) throw new Error('a space name is required');
  const r = deleteSpace(name);
  console.log(`herdr-resurrect: deleted space "${r.name}"`);
} catch (e) {
  console.error(`herdr-resurrect delete-space failed: ${e.message}`);
  process.exit(1);
}
