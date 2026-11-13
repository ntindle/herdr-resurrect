'use strict';
// bin/autosave.js (the timer pane) must honor the startup-restore gate like the
// event hooks do. Run as a real subprocess against test/fake-herdr.js; it saves
// once on start and once on SIGTERM, which spawnSync's timeout delivers.
const fs = require('fs');
const path = require('path');
const { assert, test, fakeHerdrEnv } = require('./helpers');

const AUTOSAVE = path.join(__dirname, '..', 'bin', 'autosave.js');

function runAutosave({ marker }) {
  const h = fakeHerdrEnv();
  if (marker) fs.writeFileSync(path.join(h.sessionDir, '.restore-in-progress'), '{}');
  const r = h.run(AUTOSAVE, {
    snapshot: { workspaces: [{ workspace_id: 'w1', number: 1, label: 'proj' }] },
    tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1 }],
    panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/tmp' }],
  }, { timeout: 1500 });
  return { r, last: path.join(h.sessionDir, 'last.json') };
}

test('autosave timer: saves normally (control for the gate test below)', () => {
  const { r, last } = runAutosave({ marker: false });
  assert.ok(fs.existsSync(last), r.stdout + r.stderr);
});

test('autosave timer: a fresh restore marker keeps it from writing last.json', () => {
  const { r, last } = runAutosave({ marker: true });
  assert.ok(!fs.existsSync(last), 'last.json must not be written during a startup restore');
  assert.ok(r.stdout.includes('skipped, startup restore in progress'), r.stdout + r.stderr);
});
