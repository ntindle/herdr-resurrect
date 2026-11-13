'use strict';
// The autosave gate must self-heal: a marker left behind by a crashed startup
// restore may suppress autosave briefly, never permanently (the old boot-lock's
// stuck-"restoring" failure disabled autosave for the whole session).
const fs = require('fs');
const { assert, test } = require('./helpers');
const gate = require('../lib/gate');

test('gate: fresh marker suppresses autosave until cleared', () => {
  gate.start();
  assert.strictEqual(gate.active(), true);
  gate.clear();
  assert.strictEqual(gate.active(), false);
});

test('gate: a stale marker is ignored and deleted (self-heal)', () => {
  gate.start();
  const old = new Date(Date.now() - 2 * gate.MAX_AGE_MS);
  fs.utimesSync(gate.MARKER, old, old);
  assert.strictEqual(gate.active(), false); // ignored…
  assert.strictEqual(fs.existsSync(gate.MARKER), false); // …and removed
});

test('gate: active() honors an explicit maxAgeMs, and start() refreshes the age', () => {
  gate.start();
  const past = new Date(Date.now() - 10000);
  fs.utimesSync(gate.MARKER, past, past);
  assert.strictEqual(gate.active(5000), false); // 10 s old marker fails a 5 s budget
  gate.start(); // a refresh makes it young again
  assert.strictEqual(gate.active(5000), true);
  gate.clear();
});

test('gate: the marker is per herdr session — one session restoring never mutes another', () => {
  const path = require('path');
  const { execFileSync } = require('child_process');
  const { STATE_DIR, SESSION_DIR } = require('../lib/paths');
  assert.strictEqual(path.dirname(gate.MARKER), SESSION_DIR);
  gate.start();
  try {
    // A plugin process of the named session "work", sharing the same state dir.
    const sock = path.join(STATE_DIR, 'fake-config', 'sessions', 'work', 'herdr.sock');
    const out = execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./lib/gate').active()))"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HERDR_SOCKET_PATH: sock },
    }).toString();
    assert.strictEqual(out, 'false');
  } finally {
    gate.clear();
  }
});
