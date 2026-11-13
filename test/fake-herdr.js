#!/usr/bin/env node
'use strict';
// Minimal stand-in for the herdr CLI, used by subprocess tests. Serves the read
// commands lib/herdr.js issues from a fixture file named by HERDR_FAKE_FIXTURE
// (shaped like the in-process stub: { snapshot, tabs, panes }; the snapshot
// payload is composed the way the real `api snapshot` returns it — workspaces,
// tabs, panes, and layouts in one object). Every invocation is appended to
// HERDR_FAKE_LOG when set, so tests can assert what was actually executed.
// Unrecognized commands exit non-zero so prefix drift in lib/herdr.js surfaces.
const fs = require('fs');

const fx = JSON.parse(fs.readFileSync(process.env.HERDR_FAKE_FIXTURE, 'utf8'));
const args = process.argv.slice(2).join(' ');
if (process.env.HERDR_FAKE_LOG) {
  try { fs.appendFileSync(process.env.HERDR_FAKE_LOG, args + '\n'); } catch {}
}
const out = (result) => console.log(JSON.stringify({ id: 'fake', result }));

if (args.startsWith('api snapshot')) {
  out({ snapshot: { tabs: fx.tabs || [], panes: fx.panes || [], layouts: [], ...fx.snapshot } });
} else if (args.startsWith('tab list')) out({ tabs: fx.tabs || [] });
else if (args.startsWith('pane list')) out({ panes: fx.panes || [] });
else if (args.startsWith('pane process-info')) out({ process_info: null });
else if (args.startsWith('pane run')) out({ ok: true });
else if (args.startsWith('agent list')) out({ agents: [] });
else if (args.startsWith('notification show')) out({ shown: true, reason: 'shown' });
else if (args.startsWith('session list')) out({ sessions: [] });
else if (args.startsWith('workspace focus') || args.startsWith('tab focus')) out({ ok: true });
else { console.error(`fake-herdr: unrecognized command: ${args}`); process.exit(1); }
