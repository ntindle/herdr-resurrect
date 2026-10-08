'use strict';
// Rehydrate must fill existing idle panes only — never create panes, tabs, or
// workspaces, never fill a busy pane, never fill across a cwd mismatch.
const { assert, test, stubHerdr, named, actionsOf, BUSY } = require('./helpers');
const { restore, plan } = require('../lib/restore');

const CWD = '/home/u/proj';

const model = (workspaces) => ({
  version: 1,
  tool: 'herdr-resurrect',
  saved_at: '2026-07-29T12:35:00.000Z',
  focused: {},
  workspaces,
});

// The 2026-07-30 incident shape: a saved 4-pane tab (editor, two claude agents,
// one idle shell) whose layout the user had long since dismantled.
const incidentModel = () => model([{
  workspace_id: 'wG', number: 7, label: 'proj', cwd: CWD,
  tabs: [{
    tab_id: 'wG:t1', number: 1, label: null, zoomed: false,
    panes: [
      { pane_id: 'wG:pR', index: 0, cwd: CWD, rect: { x: 0, y: 0, width: 80, height: 40 },
        command: { name: 'nvim', argv: ['nvim', '.'], cmdline: 'nvim .', cwd: CWD, restorable: true } },
      { pane_id: 'wG:pS', index: 1, cwd: CWD, rect: { x: 80, y: 0, width: 80, height: 40 },
        agent: { name: 'claude', argv: null, cmdline: null, cwd: CWD,
          session: { agent: 'claude', kind: 'id', value: 'aaaa1111-2222-3333-4444-555566667777' } } },
      { pane_id: 'wG:pT', index: 2, cwd: CWD, rect: { x: 0, y: 40, width: 80, height: 40 },
        agent: { name: 'claude', argv: null, cmdline: null, cwd: CWD,
          session: { agent: 'claude', kind: 'id', value: 'bbbb1111-2222-3333-4444-555566667777' } } },
      { pane_id: 'wG:pU', index: 3, cwd: CWD, rect: { x: 80, y: 40, width: 80, height: 40 } },
    ],
  }],
}]);

// A live session whose matching workspace has a single pane in the tab.
const liveOnePane = ({ busy = false, cwd = CWD } = {}) => ({
  snapshot: { workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }] },
  tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
  panes: [{ pane_id: 'live:p1', tab_id: 'live:t1', workspace_id: 'live:wG', cwd }],
  processInfo: busy ? { 'live:p1': BUSY } : {},
});

test('incident acceptance: 4-pane snapshot vs 1 busy live pane -> zero splits, zero launches', () => {
  const calls = stubHerdr(liveOnePane({ busy: true }));
  const m = incidentModel();
  m.focused = { workspace_id: 'wG' };
  const res = restore(m, { mode: 'rehydrate' });
  assert.strictEqual(named(calls, 'splitPane').length, 0);
  assert.strictEqual(named(calls, 'createWorkspace').length, 0);
  assert.strictEqual(named(calls, 'createTab').length, 0);
  assert.strictEqual(named(calls, 'runInPane').length, 0);
  assert.strictEqual(named(calls, 'focusWorkspace').length, 0); // nothing ran -> focus stays put
  const skips = actionsOf(res, 'skip');
  assert.strictEqual(skips.filter((s) => s.detail.includes('missing pane, not creating in rehydrate mode')).length, 3);
  assert.strictEqual(skips.filter((s) => s.detail.includes('already running something')).length, 1);
});

test('rehydrate fills idle live panes in place, pairing saved pane i with live pane i', () => {
  const live = {
    snapshot: { workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }] },
    tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
    panes: [
      { pane_id: 'live:p1', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
      { pane_id: 'live:p2', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
    ],
    // A realistic *idle* process_info (only the shell in the foreground group) —
    // exercises isIdleShell's shell-pid filter instead of its null short-circuit.
    processInfo: {
      'live:p1': { shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: 'zsh' }] },
    },
  };
  const m = incidentModel();
  m.workspaces[0].tabs[0].panes = m.workspaces[0].tabs[0].panes.slice(0, 2); // nvim + one agent
  m.focused = { workspace_id: 'wG' };
  const calls = stubHerdr(live);
  restore(m, { mode: 'rehydrate' });
  const runs = named(calls, 'runInPane');
  assert.strictEqual(runs.length, 2);
  assert.deepStrictEqual(runs.map((r) => r.args[0]), ['live:p1', 'live:p2']); // pairing, not just order
  assert.strictEqual(runs[0].args[1], 'nvim .');
  assert.ok(/claude --resume/.test(runs[1].args[1]), `expected resume command, got: ${runs[1].args[1]}`);
  assert.strictEqual(named(calls, 'splitPane').length, 0);
  assert.strictEqual(named(calls, 'focusWorkspace').length, 1); // something ran -> focus restored
});

test('live panes pair by layout geometry, not pane-id order', () => {
  // Live tab: pane "live:pA" sorts FIRST by id but sits on the RIGHT; "live:pB"
  // sits on the LEFT. Saved order is geometric (left first), so nvim must land in
  // live:pB — an id-ordered pairing would type it into the wrong pane.
  const live = {
    snapshot: {
      workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }],
      layouts: [{ tab_id: 'live:t1', panes: [
        { pane_id: 'live:pA', rect: { x: 80, y: 0, width: 80, height: 40 } },
        { pane_id: 'live:pB', rect: { x: 0, y: 0, width: 80, height: 40 } },
      ] }],
    },
    tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
    panes: [
      { pane_id: 'live:pA', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
      { pane_id: 'live:pB', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
    ],
    processInfo: {},
  };
  const m = incidentModel();
  m.workspaces[0].tabs[0].panes = m.workspaces[0].tabs[0].panes.slice(0, 2);
  const calls = stubHerdr(live);
  restore(m, { mode: 'rehydrate' });
  const runs = named(calls, 'runInPane');
  assert.deepStrictEqual(runs.map((r) => r.args[0]), ['live:pB', 'live:pA']);
  assert.strictEqual(runs[0].args[1], 'nvim .');
});

test('without layout rects, live panes order by pane id with numeric collation', () => {
  const live = {
    snapshot: { workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }] },
    tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
    panes: [ // listed out of order; numeric collation must yield p2 before p10
      { pane_id: 'live:p10', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
      { pane_id: 'live:p2', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
    ],
    processInfo: {},
  };
  const m = incidentModel();
  m.workspaces[0].tabs[0].panes = m.workspaces[0].tabs[0].panes.slice(0, 2);
  const calls = stubHerdr(live);
  restore(m, { mode: 'rehydrate' });
  assert.deepStrictEqual(named(calls, 'runInPane').map((r) => r.args[0]), ['live:p2', 'live:p10']);
});

test('rehydrate skips a pane whose live cwd differs from the saved cwd', () => {
  const calls = stubHerdr(liveOnePane({ cwd: '/somewhere/else' }));
  const m = incidentModel();
  m.workspaces[0].tabs[0].panes = m.workspaces[0].tabs[0].panes.slice(0, 1);
  const res = restore(m, { mode: 'rehydrate' });
  assert.strictEqual(named(calls, 'runInPane').length, 0);
  assert.strictEqual(actionsOf(res, 'skip').filter((s) => s.detail.includes('cwd differs')).length, 1);
});

test('rehydrate mode skips a missing workspace instead of recreating it', () => {
  const steps = plan(incidentModel(), { workspaces: [] }, { mode: 'rehydrate' });
  assert.strictEqual(steps[0].mode, 'skip');

  const calls = stubHerdr({ snapshot: { workspaces: [] }, tabs: [], panes: [] });
  const res = restore(incidentModel(), { mode: 'rehydrate' });
  assert.strictEqual(named(calls, 'createWorkspace').length, 0);
  assert.strictEqual(named(calls, 'splitPane').length, 0);
  assert.strictEqual(
    actionsOf(res, 'skip').filter((s) => s.detail.includes('missing workspace, not creating in rehydrate mode')).length,
    1
  );
});

test('auto mode still recreates a missing workspace (manual crash recovery)', () => {
  const calls = stubHerdr({ snapshot: { workspaces: [] }, tabs: [], panes: [] });
  restore(incidentModel(), { mode: 'auto' });
  assert.strictEqual(named(calls, 'createWorkspace').length, 1);
  assert.strictEqual(named(calls, 'splitPane').length, 3); // 4 panes = root + 3 splits
  assert.strictEqual(named(calls, 'runInPane').length, 3); // nvim + 2 agents; idle pane stays bare
});
