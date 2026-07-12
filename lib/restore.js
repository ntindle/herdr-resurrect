'use strict';
const fs = require('fs');
const herdr = require('./herdr');
const allowlist = require('./allowlist');
const agents = require('./agents');
const pstree = require('./pstree');
const { LAST } = require('./paths');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadModel(file) {
  const f = file || LAST;
  if (!fs.existsSync(f)) throw new Error(`no snapshot found at ${f} — run "save" first`);
  const model = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!model || model.tool !== 'herdr-resurrect' || !Array.isArray(model.workspaces))
    throw new Error(`${f} is not a herdr-resurrect snapshot`);
  return model;
}

// The shell command we'd relaunch to bring a pane back. Prefer the OS-native cmdline
// (already correctly quoted for the pane's shell); fall back to a naive argv join.
function commandFor(pane) {
  if (pane.agent) {
    const resume = agents.resumeCommand(pane.agent); // e.g. `claude --resume <id>`
    if (resume) return resume;
    // Relaunch by short name (e.g. `claude`) — a quoted absolute path won't execute
    // in PowerShell, and herdr re-detects the agent from the running process anyway.
    return agents.shortName(pane.agent) || pane.agent.name;
  }
  if (pane.command && pane.command.restorable) {
    return shellify(pane.command.cmdline || quoteArgv(pane.command.argv || []));
  }
  return null; // idle shell or a program not on the allowlist -> leave a bare pane
}

function quoteArgv(argv) {
  return argv
    .map((a) => (/[\s"']/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

// OS-captured cmdlines usually lead with a quoted absolute path
// ("C:\...\node.exe" server.js), which PowerShell parses as a string expression and
// never executes. Rewrite the program token to its short name, which is on PATH.
function shellify(cmdline) {
  if (process.platform !== 'win32' || !cmdline) return cmdline;
  const m = /^"([^"]+)"\s*(.*)$/.exec(cmdline);
  if (!m) return cmdline;
  let prog = m[1].split(/[\\/]/).pop();
  if (/\.exe$/i.test(prog)) prog = prog.slice(0, -4);
  return prog + (m[2] ? ' ' + m[2] : '');
}

// Infer how to split `cur` off `prev` from their saved rects.
function splitGeom(prev, cur) {
  if (!prev || !cur) return { direction: 'right', ratio: 0.5 };
  const sameRow = Math.abs(cur.y - prev.y) <= 1;
  const sameCol = Math.abs(cur.x - prev.x) <= 1;
  if (sameRow && cur.x > prev.x) {
    const total = prev.width + cur.width || 1;
    return { direction: 'right', ratio: clamp(cur.width / total) };
  }
  if (sameCol && cur.y > prev.y) {
    const total = prev.height + cur.height || 1;
    return { direction: 'down', ratio: clamp(cur.height / total) };
  }
  // Ambiguous / nested: pick the axis with the larger offset.
  return Math.abs(cur.x - prev.x) >= Math.abs(cur.y - prev.y)
    ? { direction: 'right', ratio: 0.5 }
    : { direction: 'down', ratio: 0.5 };
}
const clamp = (r) => Math.max(0.1, Math.min(0.9, r || 0.5));

function isIdleShell(paneId, pstable) {
  const pinfo = herdr.processInfo(paneId);
  if (!pinfo || !Array.isArray(pinfo.foreground_processes)) return true;
  const real = pinfo.foreground_processes.filter((p) => p && p.pid !== pinfo.shell_pid);
  if (real.length > 0) return false;
  // Windows: process-info can't see non-foreground children (a running `ping`,
  // `node server.js`); check the shell's process tree before typing into the pane.
  if (pstable && pinfo.shell_pid && pstree.busy(pstable, pinfo.shell_pid)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Planner — decide per workspace whether to rehydrate an existing one or recreate.
// ---------------------------------------------------------------------------
function plan(model, live, opts) {
  const liveByNumber = {};
  for (const w of live.workspaces || []) liveByNumber[w.number] = w;

  return model.workspaces.map((ws) => {
    const match = liveByNumber[ws.number];
    let mode = opts.mode;
    if (mode === 'auto') {
      mode = match && sameLabel(match, ws) ? 'rehydrate' : 'recreate';
    } else if (mode === 'rehydrate' && !match) {
      mode = 'recreate'; // asked to rehydrate but nothing to rehydrate into
    }
    return { ws, match: mode === 'rehydrate' ? match : null, mode };
  });
}
const sameLabel = (a, b) => (a.label || '') === (b.label || '');

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function restore(model, opts = {}) {
  const o = { mode: 'auto', dryRun: false, log: () => {}, ...opts };
  o.pstable = o.dryRun ? null : pstree.query(); // one bulk query for all idle checks
  const live = herdr.snapshot();
  const steps = plan(model, live, o);
  const actions = []; // {action, detail}
  const act = (action, detail) => { actions.push({ action, detail }); o.log(`${action}  ${detail}`); };

  for (const step of steps) {
    if (step.mode === 'rehydrate') rehydrateWorkspace(step.ws, step.match, o, act);
    else recreateWorkspace(step.ws, o, act);
  }

  // Restore focus (best effort, only when not a dry run).
  if (!o.dryRun && model.focused && model.focused.workspace_id) {
    const focusWs = model.workspaces.find((w) => w.workspace_id === model.focused.workspace_id);
    if (focusWs) {
      const liveWs = (herdr.snapshot().workspaces || []).find((w) => w.number === focusWs.number);
      if (liveWs) { try { herdr.focusWorkspace(liveWs.workspace_id); } catch {} }
    }
  }
  return { actions, mode: o.mode, steps: steps.map((s) => ({ number: s.ws.number, label: s.ws.label, mode: s.mode })) };
}

// Fill an existing, presumably-idle pane by running its saved command.
function fillPane(paneId, pane, o, act) {
  const cmd = commandFor(pane);
  const kind = pane.agent ? `agent:${pane.agent.name}` : `cmd:${pane.command && pane.command.name}`;
  if (!cmd) {
    if (pane.command && !pane.command.restorable)
      act('skip', `${paneId} (${pane.command.name} not on allowlist)`);
    return;
  }
  if (!o.dryRun && !isIdleShell(paneId, o.pstable)) {
    act('skip', `${paneId} already running something`);
    return;
  }
  act('run', `${paneId} <- ${kind}: ${cmd}`);
  if (!o.dryRun) herdr.runInPane(paneId, cmd);
}

// Ensure a tab has `panes.length` live panes; create the missing ones via splits.
// Returns the live pane ids in snapshot order.
function ensurePanes(firstPaneId, panes, tabCwd, o, act) {
  const ids = [firstPaneId];
  for (let i = 1; i < panes.length; i++) {
    const geom = splitGeom(panes[i - 1].rect, panes[i].rect);
    act('split', `${ids[i - 1]} ${geom.direction} @${geom.ratio.toFixed(2)}`);
    if (o.dryRun) { ids.push(`<new:${i}>`); continue; }
    const p = herdr.splitPane(ids[i - 1], { ...geom, cwd: panes[i].cwd || tabCwd });
    ids.push(p.pane_id);
  }
  return ids;
}

function recreateWorkspace(ws, o, act) {
  act('workspace.create', `#${ws.number} "${ws.label}" (${ws.cwd || 'default cwd'})`);
  let created;
  if (!o.dryRun) created = herdr.createWorkspace({ cwd: ws.cwd, label: ws.label });

  ws.tabs.forEach((tab, ti) => {
    let firstPaneId, tabCwd = tab.panes[0] ? tab.panes[0].cwd : ws.cwd;
    if (ti === 0) {
      firstPaneId = o.dryRun ? '<root-pane>' : created.root_pane.pane_id;
    } else {
      act('tab.create', `#${ws.number} "${tab.label}"`);
      if (o.dryRun) { firstPaneId = `<tab${ti}-pane>`; }
      else {
        const t = herdr.createTab({ workspace: created.workspace.workspace_id, cwd: tabCwd, label: tab.label });
        firstPaneId = firstPaneOfNewTab(created.workspace.workspace_id, t);
      }
    }
    const paneIds = ensurePanes(firstPaneId, tab.panes, tabCwd, o, act);
    tab.panes.forEach((p, i) => fillPane(paneIds[i], p, o, act));
  });
}

function rehydrateWorkspace(ws, liveWs, o, act) {
  act('rehydrate', `#${ws.number} "${ws.label}" into ${liveWs.workspace_id}`);
  const liveTabs = herdr.tabList(liveWs.workspace_id).sort((a, b) => (a.number || 0) - (b.number || 0));

  ws.tabs.forEach((tab, ti) => {
    const liveTab = liveTabs.find((t) => t.number === tab.number) || liveTabs[ti];
    if (!liveTab) { act('warn', `no live tab #${tab.number} in ${liveWs.workspace_id}; skipping`); return; }
    // Live panes in this tab, ordered top-to-bottom/left-to-right like the snapshot.
    let livePanes = herdr.paneList(liveWs.workspace_id).filter((p) => p.tab_id === liveTab.tab_id);
    livePanes = orderLive(livePanes);
    let ids = livePanes.map((p) => p.pane_id);

    // If the live tab has fewer panes than the snapshot, split to create the rest.
    if (ids.length < tab.panes.length) {
      const tabCwd = tab.panes[0] ? tab.panes[0].cwd : ws.cwd;
      ids = ensurePanes(ids[0], tab.panes.map((p, i) => (livePanes[i] ? { ...p, rect: layoutRect(livePanes[i]) || p.rect } : p)), tabCwd, o, act);
    }
    tab.panes.forEach((p, i) => { if (ids[i]) fillPane(ids[i], p, o, act); });
  });
}

// live pane list entries don't carry rects; order by pane_id as a stable fallback.
function orderLive(panes) {
  return panes.slice().sort((a, b) => String(a.pane_id).localeCompare(String(b.pane_id), undefined, { numeric: true }));
}
function layoutRect() { return null; }

// After tab.create we may or may not get the root pane in the response; discover it.
function firstPaneOfNewTab(workspaceId, createResult) {
  if (createResult && createResult.root_pane && createResult.root_pane.pane_id)
    return createResult.root_pane.pane_id;
  const tabId = createResult && (createResult.tab ? createResult.tab.tab_id : createResult.tab_id);
  const panes = herdr.paneList(workspaceId).filter((p) => !tabId || p.tab_id === tabId);
  const ordered = orderLive(panes);
  return ordered.length ? ordered[ordered.length - 1].pane_id : orderLive(herdr.paneList(workspaceId)).pop().pane_id;
}

module.exports = { loadModel, restore, plan, commandFor };
