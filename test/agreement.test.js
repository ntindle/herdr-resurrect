'use strict';
// The structural agreement tally restore() reports in rehydrate mode: the
// auto-restore guard reads it off a dry run, so its math must match what the
// planner would actually do.
const { assert, test, stubHerdr, named, BUSY } = require('./helpers');
const { restore } = require('../lib/restore');
const { sanitizeMinAgreement } = require('../lib/settings');

const CWD = '/home/u/proj';

const pane = (id, i, cmd = 'nvim .', cwd = CWD) => ({
  pane_id: id, index: i, cwd, rect: { x: 0, y: 40 * i, width: 80, height: 40 },
  command: { name: cmd.split(' ')[0], argv: cmd.split(' '), cmdline: cmd, cwd, restorable: true },
});

const model = (workspaces) => ({
  version: 1, tool: 'herdr-resurrect', saved_at: '2026-07-29T12:35:00.000Z', focused: {}, workspaces,
});

const ws = (number, label, tabs) => ({
  workspace_id: `saved:w${number}`, number, label, cwd: CWD, tabs,
});
const tab = (number, panes, id = `saved:t${number}`) => ({ tab_id: id, number, label: null, zoomed: false, panes });

const liveOnePane = (extra = {}) => ({
  snapshot: { workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }] },
  tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
  panes: [{ pane_id: 'live:p1', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD }],
  processInfo: {},
  ...extra,
});

test('tally: the incident shape scores 1/4 (missing panes counted, live side sized)', () => {
  stubHerdr(liveOnePane({ processInfo: { 'live:p1': BUSY } }));
  const m = model([ws(7, 'proj', [tab(1, [pane('a', 0), pane('b', 1), pane('c', 2), pane('d', 3)])])]);
  const t = restore(m, { mode: 'rehydrate' }).tally;
  assert.deepStrictEqual(t, {
    savedPanes: 4, paired: 1, missingWorkspace: 0, missingTab: 0, missingPane: 3,
    cwdMismatch: 0, livePanes: 1, agreement: 0.25,
  });
});

test('tally: busy and gated panes still count as paired (structure agrees)', () => {
  stubHerdr(liveOnePane({ processInfo: { 'live:p1': BUSY } }));
  const t = restore(model([ws(7, 'proj', [tab(1, [pane('a', 0)])])]), { mode: 'rehydrate' }).tally;
  assert.strictEqual(t.paired, 1);
  assert.strictEqual(t.agreement, 1);
});

test('tally: a missing workspace contributes all of its panes', () => {
  stubHerdr({ snapshot: { workspaces: [] }, tabs: [], panes: [] });
  const m = model([ws(7, 'proj', [tab(1, [pane('a', 0), pane('b', 1)])])]);
  const t = restore(m, { mode: 'rehydrate' }).tally;
  assert.strictEqual(t.missingWorkspace, 2);
  assert.strictEqual(t.agreement, 0);
});

test('tally: a missing tab contributes all of its panes', () => {
  stubHerdr(liveOnePane());
  const m = model([ws(7, 'proj', [tab(1, [pane('a', 0)]), tab(2, [pane('b', 0), pane('c', 1)])])]);
  const t = restore(m, { mode: 'rehydrate' }).tally;
  assert.strictEqual(t.missingTab, 2);
  assert.strictEqual(t.paired, 1);
  assert.ok(Math.abs(t.agreement - 1 / 3) < 1e-9);
});

test('tally: cwd mismatches are counted, not paired', () => {
  stubHerdr(liveOnePane({ panes: [{ pane_id: 'live:p1', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: '/elsewhere' }] }));
  const t = restore(model([ws(7, 'proj', [tab(1, [pane('a', 0)])])]), { mode: 'rehydrate' }).tally;
  assert.strictEqual(t.cwdMismatch, 1);
  assert.strictEqual(t.paired, 0);
  assert.strictEqual(t.agreement, 1); // the pane is still there: a `cd` must not veto the restore
});

test('tally: dry run reports the same structure as a real run would', () => {
  stubHerdr(liveOnePane());
  const m = model([ws(7, 'proj', [tab(1, [pane('a', 0), pane('b', 1)])])]);
  const dry = restore(m, { mode: 'rehydrate', dryRun: true }).tally;
  const wet = restore(m, { mode: 'rehydrate' }).tally;
  assert.deepStrictEqual(dry, wet);
});

test('tally: an empty model has agreement 1 (nothing to disagree about)', () => {
  stubHerdr({ snapshot: { workspaces: [] }, tabs: [], panes: [] });
  const t = restore(model([]), { mode: 'rehydrate' }).tally;
  assert.strictEqual(t.savedPanes, 0);
  assert.strictEqual(t.agreement, 1);
});

test('tally: only rehydrate mode reports one — recreate would count panes it just made', () => {
  stubHerdr({ snapshot: { workspaces: [] }, tabs: [], panes: [] });
  const m = model([ws(7, 'proj', [tab(1, [pane('a', 0), pane('b', 1)])])]);
  assert.strictEqual(restore(m, { mode: 'auto' }).tally, undefined);
  assert.strictEqual(restore(m, { mode: 'recreate' }).tally, undefined);
});

test('pairing: two saved tabs never alias one live tab (no duplicate injection)', () => {
  // Saved tabs #1 and #2 vs live tabs #2 and #5: saved #2 pairs with live #2 by
  // number; saved #1 has no counterpart left and must go missing — the old
  // positional fallback typed both tabs' commands into live #2's pane.
  const live = {
    snapshot: { workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }] },
    tabs: [
      { tab_id: 'live:t2', workspace_id: 'live:wG', number: 2 },
      { tab_id: 'live:t5', workspace_id: 'live:wG', number: 5 },
    ],
    panes: [
      { pane_id: 'live:pA', tab_id: 'live:t2', workspace_id: 'live:wG', cwd: CWD },
      { pane_id: 'live:pB', tab_id: 'live:t5', workspace_id: 'live:wG', cwd: CWD },
    ],
    processInfo: {},
  };
  const calls = stubHerdr(live);
  const m = model([ws(7, 'proj', [tab(1, [pane('a', 0, 'nvim .')]), tab(2, [pane('b', 0, 'htop')])])]);
  const res = restore(m, { mode: 'rehydrate' });
  const runs = named(calls, 'runInPane');
  const targets = runs.map((r) => r.args[0]);
  assert.strictEqual(new Set(targets).size, targets.length, `duplicate targets: ${targets}`);
  assert.deepStrictEqual(runs.map((r) => [r.args[0], r.args[1]]), [['live:pA', 'htop']]); // saved #2 -> live #2
  assert.strictEqual(res.tally.paired, 1);
  assert.strictEqual(res.tally.missingTab, 1);
});

test('pairing: exact pane ids beat position (native restore preserves ids)', () => {
  // Live panes carry the SAME ids as the saved ones but sit in swapped positions;
  // id pairing must follow the ids, not the geometry.
  const live = {
    snapshot: {
      workspaces: [{ workspace_id: 'live:wG', number: 7, label: 'proj' }],
      layouts: [{ tab_id: 'live:t1', panes: [
        { pane_id: 'P:s', rect: { x: 0, y: 0, width: 80, height: 40 } },
        { pane_id: 'P:r', rect: { x: 0, y: 40, width: 80, height: 40 } },
      ] }],
    },
    tabs: [{ tab_id: 'live:t1', workspace_id: 'live:wG', number: 1 }],
    panes: [
      { pane_id: 'P:r', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
      { pane_id: 'P:s', tab_id: 'live:t1', workspace_id: 'live:wG', cwd: CWD },
    ],
    processInfo: {},
  };
  const calls = stubHerdr(live);
  const m = model([ws(7, 'proj', [tab(1, [pane('P:r', 0, 'nvim .'), pane('P:s', 1, 'htop')])])]);
  restore(m, { mode: 'rehydrate' });
  const runs = named(calls, 'runInPane').map((r) => [r.args[0], r.args[1]]);
  assert.deepStrictEqual(runs, [['P:r', 'nvim .'], ['P:s', 'htop']]);
});

test('sanitizeMinAgreement: accepts only finite numbers in [0,1]; junk falls back to the default', () => {
  assert.strictEqual(sanitizeMinAgreement(0), 0); // the documented off switch
  assert.strictEqual(sanitizeMinAgreement(0.5), 0.5);
  assert.strictEqual(sanitizeMinAgreement(1), 1);
  assert.strictEqual(sanitizeMinAgreement('0.75'), 0.75);
  assert.strictEqual(sanitizeMinAgreement(7), 0.5); // a percentage typo must not demand 100%
  assert.strictEqual(sanitizeMinAgreement(-1), 0.5); // and a negative must not disable
  assert.strictEqual(sanitizeMinAgreement(null), 0.5); // Number(null) is 0 — must not disable
  assert.strictEqual(sanitizeMinAgreement(''), 0.5);
  assert.strictEqual(sanitizeMinAgreement(' '), 0.5);
  assert.strictEqual(sanitizeMinAgreement('half'), 0.5);
  assert.strictEqual(sanitizeMinAgreement(true), 0.5);
  assert.strictEqual(sanitizeMinAgreement(undefined), 0.5);
});
