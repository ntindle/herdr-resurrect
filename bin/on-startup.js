#!/usr/bin/env node
'use strict';
// One-shot [[startup]] hook (herdr >= 0.7.5): runs once per enabled plugin after
// herdr has restored the session and its API socket is ready. Owns the opt-in
// auto-restore; bin/on-event.js is autosave-only.
//
// Guard: before executing, the plan is dry-run against the natively restored
// session and refused when too few saved panes still map onto it (see
// minAgreement in settings). Structure, not clocks: a snapshot from a dead
// autosave diverges from the layout herdr just rebuilt regardless of how long
// the machine was off, while a quiet-but-healthy save agrees 100% even after a
// week of downtime.
//
// Startup hooks also fire on live handoff (in-place server upgrade), where the
// session was never lost. That case must be — and is — a no-op: the save agrees
// fully, fill-only rehydrate finds every pane still running its program, nothing
// is created, and focus is only moved when at least one action actually ran.
const fs = require('fs');
const path = require('path');
const settings = require('../lib/settings');
const gate = require('../lib/gate');
const notify = require('../lib/notify');
const { save, fileStamp } = require('../lib/snapshot');
const { loadModel, restore } = require('../lib/restore');
const { SNAP_DIR, PLUGIN_ROOT } = require('../lib/paths');

// Absolute path of the timestamped snapshot that mirrors this model, or null when
// saved_at is unusable or the file is already gone (pruned).
function refusedSnapshotPath(model) {
  const t = Date.parse(model && model.saved_at);
  if (!Number.isFinite(t)) return null;
  const file = path.join(SNAP_DIR, `snapshot-${fileStamp(new Date(t).toISOString())}.json`);
  try { return fs.existsSync(file) ? file : null; } catch { return null; }
}

async function main() {
  const cfg = settings.load();
  if (!cfg.autoRestore) return;

  // Capture the pre-boot snapshot before any event-driven autosave can overwrite
  // last.json with the freshly-restored bare-shell state.
  let model;
  try { model = loadModel(); } catch { return; } // nothing saved yet

  gate.start(); // stand autosave down while we rehydrate
  try {
    // Give herdr a moment to finish materializing the restored panes.
    await new Promise((r) => setTimeout(r, cfg.autoRestoreSettleMs));
    gate.start(); // refresh the marker — the settle sleep may consume much of its max age

    const min = settings.sanitizeMinAgreement(cfg.minAgreement);
    // An empty snapshot has nothing to mis-restore — the guard only judges
    // snapshots that would actually fill something.
    if (min > 0) {
      const planLines = [];
      const t = restore(model, { mode: 'rehydrate', dryRun: true, log: (l) => planLines.push(l) }).tally;
      // Presence, both ways: a cwd mismatch still means the pane exists (its fill
      // is skipped per-pane anyway — a plain `cd` never triggers an autosave, so
      // it must not veto the whole restore), while a live session much larger
      // than the snapshot means the save predates real growth (the mirror image
      // of the dismantled-layout incident).
      const present = t.paired + t.cwdMismatch;
      const denom = Math.max(t.savedPanes, t.livePanes);
      const agreement = denom ? present / denom : 1;
      if (t.savedPanes > 0 && agreement < min) {
        const why = [];
        if (t.missingWorkspace) why.push(`${t.missingWorkspace} pane(s) in missing workspaces`);
        if (t.missingTab) why.push(`${t.missingTab} pane(s) in missing tabs`);
        if (t.missingPane) why.push(`${t.missingPane} missing pane(s)`);
        if (t.livePanes > t.savedPanes) why.push(`live session has ${t.livePanes - t.savedPanes} more pane(s) than the snapshot`);
        const file = refusedSnapshotPath(model);
        const restoreJs = path.join(PLUGIN_ROOT, 'bin', 'restore.js');
        console.log(
          `herdr-resurrect: auto-restore SKIPPED — snapshot no longer matches the session: ` +
          `agreement ${Math.round(agreement * 100)}% is below the ${Math.round(min * 100)}% minimum` +
          (why.length ? ` (${why.join(', ')})` : '') + '.'
        );
        for (const l of planLines) console.log('  [plan] ' + l);
        if (file) {
          console.log(`  The refused snapshot: ${file}`);
          console.log(`  Apply it manually:    node "${restoreJs}" --file "${file}"   (add --dry-run to preview)`);
        } else {
          console.log(`  The refused snapshot is the newest file in ${SNAP_DIR}.`);
        }
        console.log('  (last.json will be re-baselined to the current session — use the path above, not the default.)');
        notify.restoreSkipped(agreement, min);
        return;
      }
    }

    const res = restore(model, { mode: 'rehydrate', log: (l) => console.log('[auto-restore] ' + l) });
    console.log(`herdr-resurrect: auto-restore ran ${res.actions.length} action(s) on startup`);
    notify.restored(res, { auto: true });
  } catch (e) {
    console.error('herdr-resurrect auto-restore failed:', e.message);
    notify.restoreFailed(e, { auto: true });
  } finally {
    try { save(); } catch { /* refresh the snapshot now that panes are filled */ }
    gate.clear();
  }
}

main().catch((e) => { console.error('herdr-resurrect on-startup failed:', e.message); gate.clear(); });
