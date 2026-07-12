'use strict';
const fs = require('fs');
const path = require('path');
const herdr = require('./herdr');
const allowlist = require('./allowlist');
const pstree = require('./pstree');
const agentSessions = require('./agent-sessions');
const { SNAP_DIR, LAST, ensureDirs } = require('./paths');

const SNAPSHOT_VERSION = 1;
const KEEP = Number(process.env.HERDR_RESURRECT_KEEP || 20); // snapshots to retain

// Pick the meaningful foreground program in a pane, ignoring the shell itself.
// process_info = { shell_pid, foreground_process_group_id, foreground_processes: [...] }
function foreground(pinfo) {
  if (!pinfo || !Array.isArray(pinfo.foreground_processes)) return null;
  const shellPid = pinfo.shell_pid;
  const real = pinfo.foreground_processes.filter((p) => p && p.pid !== shellPid);
  if (real.length === 0) return null; // idle shell — nothing running
  // Prefer the process group leader if we can find it, else the deepest child.
  const leader = real.find((p) => p.pid === pinfo.foreground_process_group_id);
  return leader || real[real.length - 1];
}

// A stable, human pane order for a tab: top-to-bottom, then left-to-right, using the
// layout rects when present (falls back to snapshot pane order).
function orderedPanes(snap, tabId, layout) {
  const panes = (snap.panes || []).filter((p) => p.tab_id === tabId);
  if (!layout || !Array.isArray(layout.panes)) return panes.map((p) => p.pane_id);
  const rectOf = {};
  for (const lp of layout.panes) rectOf[lp.pane_id] = lp.rect;
  return panes
    .map((p) => p.pane_id)
    .sort((a, b) => {
      const ra = rectOf[a] || { x: 0, y: 0 };
      const rb = rectOf[b] || { x: 0, y: 0 };
      return ra.y - rb.y || ra.x - rb.x;
    });
}

function buildPane(snap, paneId, index, layout, ctx) {
  const p = (snap.panes || []).find((x) => x.pane_id === paneId) || { pane_id: paneId };
  const rect = layout && (layout.panes || []).find((lp) => lp.pane_id === paneId)?.rect;
  const pinfo = herdr.processInfo(paneId);
  let fg = foreground(pinfo);
  let via = fg ? 'process-info' : null;

  // Windows: process-info misses anything that isn't the console's foreground
  // process-group leader; recover the pane's program from its shell's process tree.
  if (!fg && ctx.pstable && pinfo && pinfo.shell_pid) {
    fg = pstree.paneCommand(ctx.pstable, pinfo.shell_pid);
    if (fg) via = 'pstree';
  }

  const out = {
    pane_id: paneId,
    index,
    label: p.label || null,
    cwd: p.cwd || (fg && fg.cwd) || null,
    rect: rect || null,
  };

  if (p.agent) {
    // Agent pane — herdr will re-detect the agent once its CLI is running again.
    // When herdr didn't report a native session ref, recover one from the agent
    // CLI's own on-disk session store (keyed by the pane's cwd).
    out.agent = {
      name: p.agent,
      argv: fg ? fg.argv : null,
      cmdline: fg ? fg.cmdline : null,
      cwd: (fg && fg.cwd) || p.cwd || null,
      session: p.agent_session || ctx.resolveSession(p.agent, p.cwd || (fg && fg.cwd)) || null,
    };
  } else if (fg && !allowlist.isShell(fg)) {
    // Ordinary program. Record it either way, but flag whether we'll relaunch it.
    out.command = {
      name: fg.name || null,
      argv: fg.argv || null,
      cmdline: fg.cmdline || null,
      cwd: fg.cwd || p.cwd || null,
      restorable: allowlist.restorable(fg),
      captured_via: via,
    };
  }
  return out;
}

function build() {
  const snap = herdr.snapshot();
  const ctx = {
    pstable: pstree.query(), // null off-Windows
    resolveSession: agentSessions.makeResolver(),
  };
  const layoutByTab = {};
  for (const l of snap.layouts || []) layoutByTab[l.tab_id] = l;

  const workspaces = (snap.workspaces || [])
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map((ws) => {
      const tabs = (snap.tabs || [])
        .filter((t) => t.workspace_id === ws.workspace_id)
        .sort((a, b) => (a.number || 0) - (b.number || 0))
        .map((t) => {
          const layout = layoutByTab[t.tab_id];
          const order = orderedPanes(snap, t.tab_id, layout);
          const panes = order.map((pid, i) => buildPane(snap, pid, i, layout, ctx));
          return {
            tab_id: t.tab_id,
            number: t.number,
            label: t.label,
            zoomed: layout ? !!layout.zoomed : false,
            panes,
          };
        });
      // Workspace cwd: prefer the first pane's cwd so a recreated workspace opens there.
      const firstCwd = tabs[0] && tabs[0].panes[0] && tabs[0].panes[0].cwd;
      return {
        workspace_id: ws.workspace_id,
        number: ws.number,
        label: ws.label,
        active_tab_id: ws.active_tab_id,
        cwd: firstCwd || null,
        tabs,
      };
    });

  return {
    version: SNAPSHOT_VERSION,
    tool: 'herdr-resurrect',
    saved_at: new Date().toISOString(),
    protocol: snap.protocol || null,
    focused: {
      workspace_id: snap.focused_workspace_id || null,
      tab_id: snap.focused_tab_id || null,
      pane_id: snap.focused_pane_id || null,
    },
    workspaces,
  };
}

function fileStamp(iso) {
  // 2026-07-06T18:04:11.123Z -> 20260706-180411
  return iso.replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
}

function prune() {
  let files;
  try {
    files = fs.readdirSync(SNAP_DIR).filter((f) => /^snapshot-.*\.json$/.test(f)).sort();
  } catch { return; }
  const excess = files.length - KEEP;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(SNAP_DIR, files[i])); } catch { /* ignore */ }
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Build and persist a snapshot. Returns { file, model, panes, commands, agents }.
function save() {
  ensureDirs();
  const model = build();
  const text = JSON.stringify(model, null, 2);
  const file = path.join(SNAP_DIR, `snapshot-${fileStamp(model.saved_at)}.json`);
  writeAtomic(file, text);
  writeAtomic(LAST, text);
  prune();

  let panes = 0, commands = 0, agents = 0;
  for (const w of model.workspaces)
    for (const t of w.tabs)
      for (const p of t.panes) {
        panes++;
        if (p.agent) agents++;
        else if (p.command && p.command.restorable) commands++;
      }
  return { file, model, panes, commands, agents };
}

module.exports = { build, save, SNAPSHOT_VERSION };
