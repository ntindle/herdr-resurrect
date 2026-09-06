'use strict';
// Plugin toasts. Every entry point (actions, the autosave pane, event hooks) funnels
// through here so the per-trigger settings and the "not shown" logging live in one
// place. Actions and hooks run headless on the server (stdout only reaches the
// plugin log), so a toast is the only feedback the user gets.
const herdr = require('./herdr');
const settings = require('./settings').load();

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// kind: a key of settings.notify (onSave | onAutoSave | onRestore). Toasts from a
// named session carry its name so several sessions' toasts can be told apart.
function show(kind, title, body) {
  if (!settings.notify[kind]) return;
  const session = herdr.sessionName();
  const n = herdr.showNotification({ title: session ? `${title} (session: ${session})` : title, body });
  if (!n.shown) console.log(`  (toast not shown: ${n.reason})`);
}

// r: the save() result { panes, commands, agents }. auto: an autosave rather than
// the user-invoked save action.
function saved(r, { auto = false } = {}) {
  show(
    auto ? 'onAutoSave' : 'onSave',
    auto ? 'Resurrect: autosaved' : 'Resurrect: snapshot saved',
    `${plural(r.panes, 'pane')}, ${plural(r.commands, 'command')}, ${plural(r.agents, 'agent')}`
  );
}
function saveFailed(e, { auto = false } = {}) {
  show(
    auto ? 'onAutoSave' : 'onSave',
    auto ? 'Resurrect: autosave failed' : 'Resurrect: snapshot failed',
    e.message
  );
}

// res: the restore() result { actions, steps }. auto: the boot-time auto-restore.
function restored(res, { auto = false } = {}) {
  const count = (a) => res.actions.filter((x) => x.action === a).length;
  const parts = [];
  if (count('run')) parts.push(`${plural(count('run'), 'pane')} relaunched`);
  if (count('workspace.create')) parts.push(`${plural(count('workspace.create'), 'workspace')} recreated`);
  if (count('skip')) parts.push(`${count('skip')} skipped`);
  const body = parts.length ? parts.join(', ') : 'nothing to relaunch';
  show('onRestore', auto ? 'Resurrect: auto-restore completed' : 'Resurrect: restore completed', body);
}
function restoreFailed(e, { auto = false } = {}) {
  show('onRestore', auto ? 'Resurrect: auto-restore failed' : 'Resurrect: restore failed', e.message);
}

module.exports = { saved, saveFailed, restored, restoreFailed };
