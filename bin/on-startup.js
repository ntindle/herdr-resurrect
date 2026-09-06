#!/usr/bin/env node
'use strict';
// herdr [[startup]] hook: runs once after the server has restored the session shape
// and its API socket is ready (HERDR_PLUGIN_EVENT=startup), and again after a live
// handoff. When autoRestore is enabled, rehydrates the bare panes herdr brought back
// from the newest snapshot, then refreshes the snapshot.
//
// The pre-crash snapshot is read before any event-driven autosave can overwrite it;
// while the restore runs, the boot lock tells event hooks to stand down. Restore is
// idempotent, so after a handoff (processes kept alive) it finds nothing to do.
const settings = require('../lib/settings').load();
const boot = require('../lib/boot');
const { save } = require('../lib/snapshot');
const { loadModel, restore } = require('../lib/restore');

async function main() {
  if (!settings.autoRestore) return;
  let model = null;
  try { model = loadModel(); } catch { return; } // nothing saved yet

  const token = boot.token() || 'startup';
  boot.markRestoring(token);
  try {
    await new Promise((r) => setTimeout(r, settings.autoRestoreSettleMs)); // let restored shells settle
    const res = restore(model, { mode: 'rehydrate', waitIdle: true, log: (l) => console.log('[auto-restore] ' + l) });
    console.log(`herdr-resurrect: auto-restore ran ${res.actions.length} action(s) on boot`);
  } catch (e) {
    console.error('herdr-resurrect auto-restore failed:', e.message);
  } finally {
    boot.markDone(token);
  }
  try { save(); } catch (e) { console.error('herdr-resurrect snapshot after auto-restore failed:', e.message); }
}

main();
