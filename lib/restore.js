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
  // ratio is the KEPT (prev: left/top) pane's fraction of the pair.
  if (sameRow && cur.x > prev.x) {
    const total = prev.width + cur.width || 1;
    return { direction: 'right', ratio: clamp(prev.width / total) };
  }
  if (sameCol && cur.y > prev.y) {
    const total = prev.height + cur.height || 1;
    return { direction: 'down', ratio: clamp(prev.height / total) };
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

  return orderParentsFirst(model.workspaces).map((ws) => {
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

// --- Git worktree groups -----------------------------------------------------
// herdr nests a linked worktree under the workspace holding the repo's main
// checkout: both carry `worktree` provenance with the same repo_key, and the
// parent is the one with is_linked_worktree false. Only `worktree open/create`
// set that provenance, so a child must be recreated through `worktree open`
// against a live parent, and the parent has to exist first.
const isLinkedWorktree = (ws) => !!(ws.worktree && ws.worktree.is_linked_worktree);
const isWorktreeParent = (ws) => !!(ws.worktree && !ws.worktree.is_linked_worktree);
const parentOf = (ws, all) =>
  all.find((w) => isWorktreeParent(w) && w.worktree.repo_key === ws.worktree.repo_key);

// Snapshot order, except a parent listed after one of its children is pulled
// forward to just before that child.
function orderParentsFirst(workspaces) {
  const out = [];
  const push = (ws) => { if (!out.includes(ws)) out.push(ws); };
  for (const ws of workspaces) {
    if (isLinkedWorktree(ws)) {
      const parent = parentOf(ws, workspaces);
      if (parent) push(parent);
    }
    push(ws);
  }
  return out;
}

// repo_key -> live workspace id of the repo's parent workspace, seeded from what
// is already open and extended as parents are recreated.
function liveWorktreeParents(live) {
  const parents = {};
  for (const w of live.workspaces || [])
    if (isWorktreeParent(w)) parents[w.worktree.repo_key] = w.workspace_id;
  return parents;
}

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
  const parents = liveWorktreeParents(live);

  for (const step of steps) {
    if (step.mode === 'rehydrate') {
      if (isWorktreeParent(step.ws)) parents[step.ws.worktree.repo_key] = step.match.workspace_id;
      rehydrateWorkspace(step.ws, step.match, o, act);
    } else {
      recreateWorkspace(step.ws, o, act, parents);
    }
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

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}

// A pane we just created starts a shell that isn't ready instantly: while it
// sources its rc (p10k, plugins, ...) it briefly shows a non-shell foreground
// process, which naively reads as "busy". Wait until the shell is actually idle
// (prompt ready) before typing a command into it. Returns true once idle.
function waitForShellReady(paneId, o, tries = 30, delayMs = 150) {
  for (let i = 0; i < tries; i++) {
    // re-query the process tree each poll so idle detection isn't stale
    const pstable = process.platform === 'win32' ? pstree.query() : null;
    if (isIdleShell(paneId, pstable)) return true;
    sleepSync(delayMs);
  }
  return false;
}

// Run a pane's saved command. `fresh` means we just created this pane, so it's an
// empty shell we own: wait for it to settle, then run unconditionally. When not
// fresh (rehydrating into a pre-existing pane) keep the guard that avoids
// clobbering something the user already has running there.
function fillPane(paneId, pane, o, act, opts = {}) {
  const fresh = !!opts.fresh;
  const cmd = commandFor(pane);
  const kind = pane.agent ? `agent:${pane.agent.name}` : `cmd:${pane.command && pane.command.name}`;
  if (!cmd) {
    if (pane.command && !pane.command.restorable)
      act('skip', `${paneId} (${pane.command.name} not on allowlist)`);
    return;
  }
  if (!o.dryRun) {
    if (fresh) {
      waitForShellReady(paneId, o); // best effort; run even if it never reports idle
    } else if (!isIdleShell(paneId, o.pstable)) {
      act('skip', `${paneId} already running something`);
      return;
    }
  }
  act('run', `${paneId} <- ${kind}: ${cmd}`);
  if (!o.dryRun) herdr.runInPane(paneId, cmd);
}

// Ensure a tab has `panes.length` live panes; create the missing ones via splits.
// Returns the live pane ids in snapshot order. Linear fallback used when we don't
// have per-pane rects to reconstruct the real split tree.
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

// --- Faithful split reconstruction ------------------------------------------
// herdr tab layouts are guillotine trees (every split is a single horizontal or
// vertical cut), so a tab's pane rects fully determine the tree. We recursively
// find the outermost cut, split the live pane there, and recurse — reproducing
// nested layouts (e.g. a "1 / 2 / 1" stack) that a linear split chain flattens.
const LEPS = 2; // cell tolerance for edges/borders

function bboxOf(rects) {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Top-left-most pane in a group — the one that stays put through every split, so
// its cwd is the one to seed onto the region it anchors.
function anchorPane(ps) {
  return ps.slice().sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x))[0];
}

// Find the first clean guillotine cut of `region` that separates `ps` in two.
function findCut(region, ps) {
  const candidates = [];
  for (const p of ps) {
    const bx = p.rect.x + p.rect.width;
    if (bx > region.x + LEPS && bx < region.x + region.width - LEPS &&
        ps.every((q) => q.rect.x + q.rect.width <= bx + LEPS || q.rect.x >= bx - LEPS)) {
      candidates.push({ dir: 'right', at: bx });
    }
    const by = p.rect.y + p.rect.height;
    if (by > region.y + LEPS && by < region.y + region.height - LEPS &&
        ps.every((q) => q.rect.y + q.rect.height <= by + LEPS || q.rect.y >= by - LEPS)) {
      candidates.push({ dir: 'down', at: by });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.at - b.at);
  const c = candidates[0];
  if (c.dir === 'right') {
    const a = ps.filter((q) => q.rect.x + q.rect.width <= c.at + LEPS);
    return {
      dir: 'right',
      a,
      b: ps.filter((q) => !a.includes(q)),
      regA: { x: region.x, y: region.y, width: c.at - region.x, height: region.height },
      regB: { x: c.at, y: region.y, width: region.x + region.width - c.at, height: region.height },
    };
  }
  const a = ps.filter((q) => q.rect.y + q.rect.height <= c.at + LEPS);
  return {
    dir: 'down',
    a,
    b: ps.filter((q) => !a.includes(q)),
    regA: { x: region.x, y: region.y, width: region.width, height: c.at - region.y },
    regB: { x: region.x, y: c.at, width: region.width, height: region.y + region.height - c.at },
  };
}

// Rebuild a tab's panes from their rects. Returns live pane ids aligned to `panes`.
function rebuildByRect(firstPaneId, panes, o, act) {
  const liveOf = {};
  let counter = 0;
  const rec = (region, ps, liveId) => {
    if (ps.length === 1) { liveOf[ps[0].pane_id] = liveId; return; }
    const cut = findCut(region, ps);
    if (!cut) { // non-guillotine (shouldn't happen) — degrade to a linear chain
      liveOf[ps[0].pane_id] = liveId;
      let cur = liveId;
      for (let i = 1; i < ps.length; i++) {
        const g = splitGeom(ps[i - 1].rect, ps[i].rect);
        if (o.dryRun) { liveOf[ps[i].pane_id] = `<new:${++counter}>`; continue; }
        cur = herdr.splitPane(cur, { ...g, cwd: ps[i].cwd }).pane_id;
        liveOf[ps[i].pane_id] = cur;
      }
      return;
    }
    // herdr's --ratio is the KEPT (a-side: left/top) pane's fraction of the region.
    const ratio = cut.dir === 'right'
      ? cut.regA.width / region.width
      : cut.regA.height / region.height;
    act('split', `${liveId} ${cut.dir} @${ratio.toFixed(2)}`);
    let newId;
    if (o.dryRun) newId = `<new:${++counter}>`;
    else newId = herdr.splitPane(liveId, { direction: cut.dir, ratio, cwd: anchorPane(cut.b).cwd }).pane_id;
    rec(cut.regA, cut.a, liveId); // a-side keeps the original pane (left / top)
    rec(cut.regB, cut.b, newId);  // b-side is the new pane (right / bottom)
  };
  rec(bboxOf(panes.map((p) => p.rect)), panes, firstPaneId);
  return panes.map((p) => liveOf[p.pane_id] || firstPaneId);
}

// Reconstruct panes for a freshly-created tab: use the faithful rect-based tree
// when every pane has a rect, else fall back to the linear chain.
function layoutPanes(firstPaneId, panes, tabCwd, o, act) {
  if (panes.length > 1 && panes.every((p) => p.rect)) {
    return rebuildByRect(firstPaneId, panes, o, act);
  }
  return ensurePanes(firstPaneId, panes, tabCwd, o, act);
}

// Open a linked worktree checkout as a workspace nested under its repo's parent.
// Returns herdr's result, a placeholder on dry run, or null when the open failed
// and the caller should fall back to a plain workspace.
function openLinkedWorktree(ws, o, act, parents) {
  const wt = ws.worktree;
  const parentId = parents[wt.repo_key] || null;
  act('worktree.open', `#${ws.number} "${ws.label}" ${wt.checkout_path} under ${parentId ? `parent ${parentId}` : `repo ${wt.repo_root}`}`);
  if (o.dryRun) return { dryRun: true };
  try {
    // With no parent open, herdr resolves the repo from its root and finds or
    // creates the parent workspace itself.
    return herdr.openWorktree({
      workspace: parentId,
      cwd: parentId ? null : wt.repo_root,
      path: wt.checkout_path,
      label: ws.label,
    });
  } catch (e) {
    act('warn', `worktree open failed for #${ws.number} (${e.message}); creating a plain workspace`);
    return null;
  }
}

const normPath = (p) => {
  const s = String(p || '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase().replace(/\\/g, '/') : s;
};
const samePath = (a, b) => normPath(a) === normPath(b);
const cdCommand = (dir) => `cd "${String(dir).replace(/"/g, '\\"')}"`;

function recreateWorkspace(ws, o, act, parents = {}) {
  let created = isLinkedWorktree(ws) ? openLinkedWorktree(ws, o, act, parents) : null;
  const asWorktree = !!created;
  if (created && created.already_open) {
    // herdr keeps one workspace per checkout, so fill that one instead of
    // splitting extra panes into it.
    act('warn', `#${ws.number} "${ws.label}" is already open at ${ws.worktree.checkout_path}; rehydrating it`);
    return rehydrateWorkspace(ws, created.workspace, o, act);
  }
  if (!created) {
    act('workspace.create', `#${ws.number} "${ws.label}" (${ws.cwd || 'default cwd'})`);
    if (!o.dryRun) created = herdr.createWorkspace({ cwd: ws.cwd, label: ws.label });
  }
  if (isWorktreeParent(ws)) parents[ws.worktree.repo_key] = o.dryRun ? `<ws#${ws.number}>` : created.workspace.workspace_id;

  ws.tabs.forEach((tab, ti) => {
    let firstPaneId, tabCwd = tab.panes[0] ? tab.panes[0].cwd : ws.cwd;
    if (ti === 0) {
      // The new workspace already has a root tab; give it this tab's name (herdr
      // names it "1" by default) instead of creating an extra tab.
      firstPaneId = o.dryRun ? '<root-pane>' : created.root_pane.pane_id;
      if (!o.dryRun && tab.label) {
        act('tab.rename', `root -> "${tab.label}"`);
        try { herdr.renameTab(created.tab.tab_id, tab.label); } catch {}
      }
      // worktree open has no --cwd: its root pane starts at the checkout root.
      if (asWorktree && tabCwd && !samePath(tabCwd, ws.worktree.checkout_path)) {
        act('cd', `${firstPaneId} -> ${tabCwd}`);
        if (!o.dryRun) { waitForShellReady(firstPaneId, o); herdr.runInPane(firstPaneId, cdCommand(tabCwd)); }
      }
    } else {
      act('tab.create', `#${ws.number} "${tab.label}"`);
      if (o.dryRun) { firstPaneId = `<tab${ti}-pane>`; }
      else {
        const t = herdr.createTab({ workspace: created.workspace.workspace_id, cwd: tabCwd, label: tab.label });
        firstPaneId = firstPaneOfNewTab(created.workspace.workspace_id, t);
      }
    }
    const paneIds = layoutPanes(firstPaneId, tab.panes, tabCwd, o, act);
    // Every pane here was just created, so it's a fresh shell we own.
    tab.panes.forEach((p, i) => fillPane(paneIds[i], p, o, act, { fresh: true }));
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

    // Panes at these indices already existed in the live tab; anything beyond was
    // just created by the split below and is a fresh shell we own.
    const preexisting = ids.length;

    // If the live tab has fewer panes than the snapshot, split to create the rest.
    if (ids.length < tab.panes.length) {
      const tabCwd = tab.panes[0] ? tab.panes[0].cwd : ws.cwd;
      ids = ensurePanes(ids[0], tab.panes.map((p, i) => (livePanes[i] ? { ...p, rect: layoutRect(livePanes[i]) || p.rect } : p)), tabCwd, o, act);
    }
    tab.panes.forEach((p, i) => { if (ids[i]) fillPane(ids[i], p, o, act, { fresh: i >= preexisting }); });
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
