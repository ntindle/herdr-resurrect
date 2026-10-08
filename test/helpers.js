'use strict';
// Shared stubs and a tiny test() harness for the plain-Node test scripts.
//
// lib modules hold the same cached object require() returns here, so overwriting
// properties on lib/herdr's exports swaps the live-server calls for fixture-driven
// fakes. That makes even non-dry restore() runs fully offline: writes land in the
// returned `calls` list instead of a live herdr session.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const herdr = require('../lib/herdr');
const pstree = require('../lib/pstree');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error('  ' + String(e.stack || e).split('\n').join('\n  '));
  }
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

// fixture = { snapshot, tabs, panes, processInfo: { <pane_id>: process_info } }
// Returns `calls`, a log of every write-style herdr call the code under test made.
// The snapshot herdr.snapshot() serves is composed like the real `api snapshot`
// payload: fixture.snapshot plus the top-level tabs/panes (and any layouts the
// fixture nested in snapshot), so code reading live.panes/live.layouts sees them.
let seq = 0;
function stubHerdr(fixture) {
  const calls = [];
  const log = (name, args, ret) => { calls.push({ name, args }); return ret; };
  herdr.snapshot = () => ({ tabs: fixture.tabs || [], panes: fixture.panes || [], layouts: [], ...fixture.snapshot });
  herdr.tabList = (ws) => (fixture.tabs || []).filter((t) => !ws || t.workspace_id === ws);
  herdr.paneList = (ws) => (fixture.panes || []).filter((p) => !ws || p.workspace_id === ws);
  herdr.processInfo = (id) => (fixture.processInfo || {})[id] || null;
  herdr.splitPane = (id, opts) => log('splitPane', [id, opts], { pane_id: `new:${++seq}` });
  herdr.runInPane = (id, cmd) => log('runInPane', [id, cmd], { code: 0 });
  herdr.createWorkspace = (opts) => log('createWorkspace', [opts], {
    workspace: { workspace_id: `ws-new:${++seq}` },
    root_pane: { pane_id: `pane-new:${++seq}` },
  });
  herdr.createTab = (opts) => log('createTab', [opts], {
    tab: { tab_id: `tab-new:${++seq}` },
    root_pane: { pane_id: `pane-new:${++seq}` },
  });
  herdr.focusWorkspace = (id) => log('focusWorkspace', [id], {});
  herdr.focusTab = (id) => log('focusTab', [id], {});
  herdr.renameTab = (id, label) => log('renameTab', [id, label], {});
  herdr.showNotification = (opts) => log('showNotification', [opts], { shown: true, reason: 'shown' });
  herdr.sessionName = () => null;
  pstree.query = () => null; // never shell out to ps in tests
  return calls;
}

const named = (calls, name) => calls.filter((c) => c.name === name);
const actionsOf = (res, action) => res.actions.filter((a) => a.action === action);

// A process_info that makes isIdleShell() report "busy".
const BUSY = {
  shell_pid: 100,
  foreground_process_group_id: 200,
  foreground_processes: [{ pid: 100, name: 'zsh' }, { pid: 200, name: 'nvim' }],
};

// Throwaway plugin state/config, with test/fake-herdr.js standing in for the herdr
// CLI, for running bin/ scripts as real subprocesses. The fake logs every call it
// receives (see calls()). With no HERDR_SOCKET_PATH or HERDR_SESSION in the
// child's env, scripts act on the default session.
function fakeHerdrEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-fake-'));
  const state = path.join(dir, 'state');
  const config = path.join(dir, 'config');
  const sessionDir = path.join(state, 'sessions', 'default');
  const snapshots = path.join(sessionDir, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.mkdirSync(config, { recursive: true });

  // On Windows CreateProcess can't run a .js via shebang; go through a .cmd shim.
  const fake = path.join(__dirname, 'fake-herdr.js');
  let bin = fake;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'fake-herdr.cmd');
    fs.writeFileSync(bin, `@node "${fake}" %*\r\n`);
  }
  const fakeLog = path.join(dir, 'herdr-calls.log');
  const fixture = path.join(dir, 'live.json');

  return {
    config,
    sessionDir,
    snapshots,
    calls() { try { return fs.readFileSync(fakeLog, 'utf8'); } catch { return ''; } },
    // liveFixture: { snapshot, tabs, panes }, served by the fake herdr.
    run(script, liveFixture, spawnOpts = {}) {
      fs.writeFileSync(fixture, JSON.stringify(liveFixture));
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith('HERDR_')) delete env[k];
      Object.assign(env, {
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_BIN_PATH: bin,
        HERDR_FAKE_FIXTURE: fixture,
        HERDR_FAKE_LOG: fakeLog,
      });
      return spawnSync(process.execPath, [script], { encoding: 'utf8', env, ...spawnOpts });
    },
  };
}

module.exports = { assert, test, finish, stubHerdr, named, actionsOf, BUSY, fakeHerdrEnv };
