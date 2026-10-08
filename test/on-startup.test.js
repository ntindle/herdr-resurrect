'use strict';
// bin/on-startup.js paths, exercised as real subprocesses with state, config, and
// the herdr CLI itself (test/fake-herdr.js) pointed at throwaway fixtures — fully
// offline, no live server. The fake logs every invocation to HERDR_FAKE_LOG so
// tests can assert what was actually executed, not just what was printed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, test } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'bin', 'on-startup.js');
const FAKE = path.join(__dirname, 'fake-herdr.js');

const CWD = '/home/u/proj';

const livePane = (id, i, cwd = CWD) =>
  ({ pane_id: id, tab_id: 'live:t1', workspace_id: 'live:wG', cwd, i });

const liveSession = (paneCount, cwd) => ({
  snapshot: { workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }] },
  tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
  panes: Array.from({ length: paneCount }, (_, i) => livePane(`live:p${i + 1}`, i, cwd)),
});

const savedPane = (id, i) => ({
  pane_id: id, index: i, cwd: CWD, rect: { x: 0, y: 40 * i, width: 80, height: 40 },
  command: { name: 'nvim', argv: ['nvim', '.'], cmdline: 'nvim .', cwd: CWD, restorable: true },
});

const model = (paneCount, savedAt) => ({
  version: 1,
  tool: 'herdr-resurrect',
  ...(savedAt === undefined ? {} : { saved_at: savedAt }),
  focused: {},
  workspaces: [{
    workspace_id: 'wG', number: 7, label: 'proj', cwd: CWD,
    tabs: [{ tab_id: 'wG:t1', number: 1, label: null, zoomed: false,
      panes: Array.from({ length: paneCount }, (_, i) => savedPane(`wG:p${i}`, i)) }],
  }],
});

function hookEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-hook-'));
  const state = path.join(dir, 'state');
  const config = path.join(dir, 'config');
  // No HERDR_SOCKET_PATH / HERDR_SESSION in the hook's env -> the default session.
  const sessionDir = path.join(state, 'sessions', 'default');
  const snapshots = path.join(sessionDir, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.mkdirSync(config, { recursive: true });

  // On Windows CreateProcess can't run a .js via shebang; go through a .cmd shim.
  let bin = FAKE;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'fake-herdr.cmd');
    fs.writeFileSync(bin, `@node "${FAKE}" %*\r\n`);
  }
  const fakeLog = path.join(dir, 'herdr-calls.log');

  return {
    state,
    snapshots,
    fakeLog,
    calls() { try { return fs.readFileSync(fakeLog, 'utf8'); } catch { return ''; } },
    run(settings, lastModel, liveFixture) {
      fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(settings));
      if (lastModel) {
        fs.writeFileSync(path.join(sessionDir, 'last.json'), JSON.stringify(lastModel));
        // The timestamped twin save() would have written alongside last.json.
        const t = Date.parse(lastModel.saved_at);
        if (Number.isFinite(t)) {
          const stamp = new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
          fs.writeFileSync(path.join(snapshots, `snapshot-${stamp}.json`), JSON.stringify(lastModel));
        }
      }
      const fixture = path.join(dir, 'live.json');
      fs.writeFileSync(fixture, JSON.stringify(liveFixture || liveSession(1)));
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith('HERDR_')) delete env[k];
      Object.assign(env, {
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_BIN_PATH: bin,
        HERDR_FAKE_FIXTURE: fixture,
        HERDR_FAKE_LOG: fakeLog,
      });
      return spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env });
    },
  };
}

test('on-startup: autoRestore=false is a silent successful no-op', () => {
  const h = hookEnv();
  const r = h.run({ autoRestore: false }, null);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '');
});

test('on-startup: a diverged snapshot is refused with the breakdown and an absolute remedy', () => {
  const h = hookEnv();
  const r = h.run(
    { autoRestore: true, autoRestoreSettleMs: 10 },
    model(4, '2026-07-29T12:35:00.000Z'), // 4 saved vs 1 live -> 25% < 50%
    liveSession(1)
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('auto-restore SKIPPED'), r.stdout + r.stderr);
  assert.ok(r.stdout.includes('agreement 25% is below the 50% minimum'), r.stdout);
  assert.ok(r.stdout.includes('3 missing pane(s)'), r.stdout); // the breakdown names the right bucket
  assert.ok(r.stdout.includes('[plan]'), 'per-pane plan lines should be shown');
  const expected = path.join(h.snapshots, 'snapshot-20260729-123500.json');
  assert.ok(r.stdout.includes(`--file "${expected}"`), `remedy should name ${expected}, got: ${r.stdout}`);
  assert.ok(!h.calls().includes('pane run'), 'nothing must be typed into panes on refusal');
});

test('on-startup: a diverged snapshot without saved_at is refused, not crashed on', () => {
  const h = hookEnv();
  const r = h.run({ autoRestore: true, autoRestoreSettleMs: 10 }, model(4, undefined), liveSession(1));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('auto-restore SKIPPED'), r.stdout + r.stderr);
  assert.ok(!r.stderr.includes('TypeError'), r.stderr);
  assert.ok(r.stdout.includes(`newest file in ${h.snapshots}`), 'remedy should fall back to the snapshots dir');
});

test('on-startup: an agreeing snapshot rehydrates — and actually runs the command', () => {
  const h = hookEnv();
  const r = h.run({ autoRestore: true, autoRestoreSettleMs: 10 }, model(1, '2026-07-29T12:35:00.000Z'), liveSession(1));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('auto-restore ran'), r.stdout + r.stderr);
  assert.ok(r.stdout.includes('live:p1 <- cmd:nvim'), r.stdout);
  assert.ok(/^pane run live:p1 nvim \./m.test(h.calls()), `fake herdr should have received the run:\n${h.calls()}`);
});

test('on-startup: full agreement passes even at minAgreement 1 (boundary is <, not <=)', () => {
  const h = hookEnv();
  const r = h.run(
    { autoRestore: true, autoRestoreSettleMs: 10, minAgreement: 1 },
    model(1, '2026-07-29T12:35:00.000Z'),
    liveSession(1)
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('auto-restore ran'), r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('SKIPPED'), r.stdout);
});

test('on-startup: a snapshot that is a mere subset of the live session is refused', () => {
  // The mirror image of the incident: autosave died at 1 pane, the session grew
  // to 4 before shutdown, native restore brought all 4 back.
  const h = hookEnv();
  const r = h.run({ autoRestore: true, autoRestoreSettleMs: 10 }, model(1, '2026-07-29T12:35:00.000Z'), liveSession(4));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('auto-restore SKIPPED'), r.stdout + r.stderr);
  assert.ok(r.stdout.includes('live session has 3 more pane(s) than the snapshot'), r.stdout);
});

test('on-startup: cwd drift skips panes but never vetoes the whole restore', () => {
  // A plain `cd` fires no autosave event, so it must not count against agreement.
  const h = hookEnv();
  const r = h.run({ autoRestore: true, autoRestoreSettleMs: 10 }, model(1, '2026-07-29T12:35:00.000Z'), liveSession(1, '/somewhere/else'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('SKIPPED'), r.stdout);
  assert.ok(r.stdout.includes('cwd differs'), r.stdout); // the pane-level guard still skips the fill
  assert.ok(r.stdout.includes('auto-restore ran'), r.stdout);
});

test('on-startup: an empty snapshot is a harmless no-op, not a refusal', () => {
  const h = hookEnv();
  const empty = { version: 1, tool: 'herdr-resurrect', saved_at: '2026-07-29T12:35:00.000Z', focused: {}, workspaces: [] };
  const r = h.run({ autoRestore: true, autoRestoreSettleMs: 10 }, empty, liveSession(1));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('SKIPPED'), r.stdout);
  assert.ok(r.stdout.includes('auto-restore ran 0 action(s)'), r.stdout);
});

test('on-startup: minAgreement 0 disables the guard', () => {
  const h = hookEnv();
  const r = h.run(
    { autoRestore: true, autoRestoreSettleMs: 10, minAgreement: 0 },
    model(4, '2026-07-29T12:35:00.000Z'),
    liveSession(1)
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('auto-restore ran'), r.stdout + r.stderr); // proceeds, fill-only guards remain
  assert.ok(!r.stdout.includes('SKIPPED'), r.stdout);
});

test('on-startup: with notify.onRestore a refusal and a completed restore both toast', () => {
  const h = hookEnv();
  const cfg = { autoRestore: true, autoRestoreSettleMs: 10, notify: { onRestore: true } };
  let r = h.run(cfg, model(4, '2026-07-29T12:35:00.000Z'), liveSession(1));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(h.calls().includes('notification show Resurrect: auto-restore skipped'), h.calls());

  r = h.run(cfg, model(1, '2026-07-29T12:35:00.000Z'), liveSession(1));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(h.calls().includes('notification show Resurrect: auto-restore completed'), h.calls());
});
