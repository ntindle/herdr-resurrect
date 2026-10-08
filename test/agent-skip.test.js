'use strict';
// agentResume=false must leave agent panes entirely alone — no bare-binary launch
// (which would start a fresh, amnesiac session) and no double-handling of panes
// owned by herdr's native resume_agents_on_restore.
const { assert, test, stubHerdr, named, actionsOf } = require('./helpers');
const settings = require('../lib/settings');
const { restore } = require('../lib/restore');

const CWD = '/home/u/proj';

const agentModel = () => ({
  version: 1,
  tool: 'herdr-resurrect',
  saved_at: '2026-07-29T12:35:00.000Z',
  focused: {},
  workspaces: [{
    workspace_id: 'w1', number: 1, label: 'dev', cwd: CWD,
    tabs: [{
      tab_id: 'w1:t1', number: 1, label: null, zoomed: false,
      panes: [
        { pane_id: 'w1:p1', index: 0, cwd: CWD, rect: { x: 0, y: 0, width: 80, height: 40 },
          agent: { name: 'claude', argv: null, cmdline: null, cwd: CWD,
            session: { agent: 'claude', kind: 'id', value: 'cccc1111-2222-3333-4444-555566667777' } } },
        { pane_id: 'w1:p2', index: 1, cwd: CWD, rect: { x: 80, y: 0, width: 80, height: 40 },
          command: { name: 'htop', argv: ['htop'], cmdline: 'htop', cwd: CWD, restorable: true } },
      ],
    }],
  }],
});

const liveTwoIdlePanes = () => ({
  snapshot: { workspaces: [{ workspace_id: 'live:w1', number: 1, label: 'dev' }] },
  tabs: [{ tab_id: 'live:t1', workspace_id: 'live:w1', number: 1 }],
  panes: [
    { pane_id: 'live:p1', tab_id: 'live:t1', workspace_id: 'live:w1', cwd: CWD },
    { pane_id: 'live:p2', tab_id: 'live:t1', workspace_id: 'live:w1', cwd: CWD },
  ],
  processInfo: {},
});

function withAgentResume(value, fn) {
  const orig = settings.load;
  settings.load = () => ({ ...settings.DEFAULTS, agentResume: value });
  try { fn(); } finally { settings.load = orig; }
}

test('agentResume=false: agent panes are skipped entirely, command panes still fill', () => {
  withAgentResume(false, () => {
    const calls = stubHerdr(liveTwoIdlePanes());
    const res = restore(agentModel(), { mode: 'rehydrate' });
    const runs = named(calls, 'runInPane');
    assert.strictEqual(runs.length, 1); // only htop — never the agent binary
    assert.strictEqual(runs[0].args[1], 'htop');
    assert.strictEqual(
      actionsOf(res, 'skip').filter((s) => s.detail.includes('(agent pane, agentResume=false)')).length,
      1
    );
  });
});

test('agentResume=true: agent panes relaunch with resume flags (unchanged)', () => {
  withAgentResume(true, () => {
    const calls = stubHerdr(liveTwoIdlePanes());
    restore(agentModel(), { mode: 'rehydrate' });
    const runs = named(calls, 'runInPane');
    assert.strictEqual(runs.length, 2);
    assert.ok(/claude --resume cccc1111/.test(runs[0].args[1]), `expected resume command, got: ${runs[0].args[1]}`);
  });
});
