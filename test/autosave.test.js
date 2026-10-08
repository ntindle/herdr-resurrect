'use strict';
// bin/autosave.js (the timer pane) must honor the startup-restore gate like the
// event hooks do. Run as a real subprocess against test/fake-herdr.js; it saves
// once on start and once on SIGTERM, which spawnSync's timeout delivers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, test } = require('./helpers');

const AUTOSAVE = path.join(__dirname, '..', 'bin', 'autosave.js');
const FAKE = path.join(__dirname, 'fake-herdr.js');

function runAutosave({ marker }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-autosave-'));
  const state = path.join(dir, 'state');
  const sessionDir = path.join(state, 'sessions', 'default');
  fs.mkdirSync(sessionDir, { recursive: true });
  if (marker) fs.writeFileSync(path.join(sessionDir, '.restore-in-progress'), '{}');

  let bin = FAKE;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'fake-herdr.cmd');
    fs.writeFileSync(bin, `@node "${FAKE}" %*\r\n`);
  }
  const fixture = path.join(dir, 'live.json');
  fs.writeFileSync(fixture, JSON.stringify({
    snapshot: { workspaces: [{ workspace_id: 'w1', number: 1, label: 'proj' }] },
    tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1 }],
    panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/tmp' }],
  }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HERDR_')) delete env[k];
  Object.assign(env, {
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, 'config'),
    HERDR_BIN_PATH: bin,
    HERDR_FAKE_FIXTURE: fixture,
  });
  const r = spawnSync(process.execPath, [AUTOSAVE], { encoding: 'utf8', env, timeout: 1500 });
  return { r, last: path.join(sessionDir, 'last.json') };
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
