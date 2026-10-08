'use strict';
const fs = require('fs');
const path = require('path');
const herdr = require('./herdr');
const allowlist = require('./allowlist');
const agents = require('./agents');
const settings = require('./settings');
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
  const liveById = {};
  const liveByNumber = {};
  for (const w of live.workspaces || []) { liveById[w.workspace_id] = w; liveByNumber[w.number] = w; }

  // herdr's native restore preserves workspace ids, so an id hit is authoritative
  // (survives renames and number shifts). The number fallback additionally
  // requires the label to agree: workspace numbers are positional and shift when
  // one closes, and filling another workspace's panes is worse than skipping.
  // Each live workspace pairs at most once.
  const used = new Set();
  return model.workspaces.map((ws) => {
    let match = liveById[ws.workspace_id] || null;
    if (!match) {
      const cand = liveByNumber[ws.number];
      if (cand && sameLabel(cand, ws)) match = cand;
    }
    if (match && used.has(match.workspace_id)) match = null;
    if (match) used.add(match.workspace_id);

    let mode = opts.mode;
    if (mode === 'auto') {
      mode = match ? 'rehydrate' : 'recreate';
    } else if (mode === 'rehydrate' && !match) {
      mode = 'skip'; // rehydrate never creates; a missing workspace stays missing
    }
    return { ws, match: mode === 'rehydrate' ? match : null, mode };
  });
}
const sameLabel = (a, b) => (a.label || '') === (b.label || '');

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function restore(model, opts = {}) {
  const o = { mode: 'auto', dryRun: false, waitIdleMs: 0, log: () => {}, ...opts };
  o.pstable = o.dryRun ? null : pstree.query(); // one bulk query for all idle checks
  // opts.waitIdleMs: how long pre-existing panes may take to finish their shell's
  // rc and reach the prompt. One budget for the whole run, not per pane, so a
  // live handoff (every pane genuinely busy) pays it at most once.
  o.idleDeadline = Date.now() + o.waitIdleMs;
  const live = herdr.snapshot();
  const steps = plan(model, live, o);
  const actions = []; // {action, detail}
  const act = (action, detail) => { actions.push({ action, detail }); o.log(`${action}  ${detail}`); };

  // Structural agreement tally: how much of the snapshot still maps onto the live
  // session. `paired` counts saved panes with a live counterpart at the same
  // position and cwd (busy/allowlist/agent gates don't affect it — the structure
  // agrees even when the fill is skipped); the rest name why a pane didn't pair,
  // and `livePanes` sizes the live side so a snapshot that is a mere subset of
  // the session can be recognized too. Only meaningful — and only returned — in
  // rehydrate mode: recreate manufactures its own counterparts, which would count
  // as agreement with a session that wasn't there. The auto-restore guard in
  // bin/on-startup.js reads this off a dry run.
  const tally = {
    savedPanes: 0, paired: 0, missingWorkspace: 0, missingTab: 0, missingPane: 0, cwdMismatch: 0,
    livePanes: ((live && live.panes) || []).length,
  };
  for (const w of model.workspaces) for (const t of w.tabs || []) tally.savedPanes += t.panes.length;
  o.tally = tally;

  // Saved workspace_id -> the live workspace it was restored into (the planner's
  // id-first match, or the one recreate just made), so focus follows the same
  // pairing instead of re-guessing by position.
  const liveIdOf = {};
  for (const step of steps) {
    if (step.mode === 'rehydrate') {
      rehydrateWorkspace(step.ws, step.match, o, act, live);
      liveIdOf[step.ws.workspace_id] = step.match.workspace_id;
    } else if (step.mode === 'skip') {
      for (const t of step.ws.tabs || []) tally.missingWorkspace += t.panes.length;
      act('skip', `#${step.ws.number} "${step.ws.label}" (missing workspace, not creating in rehydrate mode)`);
    } else {
      const id = recreateWorkspace(step.ws, o, act);
      if (id) liveIdOf[step.ws.workspace_id] = id;
    }
  }

  // Restore focus (best effort, only when not a dry run and something actually
  // changed — an all-skip rehydrate, e.g. after a live handoff, must not yank
  // the user's focus to a workspace from an old snapshot).
  const mutated = actions.some((a) => a.action !== 'skip' && a.action !== 'warn' && a.action !== 'rehydrate');
  if (!o.dryRun && mutated && model.focused && model.focused.workspace_id) {
    const target = liveIdOf[model.focused.workspace_id];
    if (target) { try { herdr.focusWorkspace(target); } catch {} }
  }
  const res = {
    actions,
    mode: o.mode,
    steps: steps.map((s) => ({ number: s.ws.number, label: s.ws.label, mode: s.mode })),
  };
  if (o.mode === 'rehydrate')
    res.tally = { ...tally, agreement: agreementOf(tally) };
  return res;
}

// Share (0..1) of panes present on both sides, over whichever side is larger. A
// cwd mismatch still counts as present: a plain `cd` fires no autosave, so it
// must not veto the restore (that pane's fill is skipped on its own). Dividing by
// the larger side lets a snapshot that is a mere subset of the session score low
// too, the mirror image of a snapshot whose panes were since closed.
function agreementOf(t) {
  const denom = Math.max(t.savedPanes, t.livePanes);
  return denom ? (t.paired + t.cwdMismatch) / denom : 1;
}

// A pane is only filled when its live cwd agrees with the saved one — typing the
// saved command into a pane that now lives elsewhere would run it in the wrong
// directory. Unknown on either side is not a mismatch (recreate passes no live
// cwd: it just made the pane with the saved cwd).
function sameCwd(liveCwd, savedCwd) {
  if (!liveCwd || !savedCwd) return true;
  let a = path.resolve(String(liveCwd));
  let b = path.resolve(String(savedCwd));
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b;
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}

// Process tree for idle checks; only Windows needs one (see isIdleShell).
const queryTree = () => (process.platform === 'win32' ? pstree.query() : null);

// Poll until the pane is an idle shell or `deadline` (epoch ms) passes; a past
// deadline means a single check. A shell that is still sourcing its rc (p10k,
// plugins, ...) briefly shows a non-shell foreground process and reads as busy,
// so typing into it must wait for the prompt. `pstable` serves the first check
// (pass the run's bulk query when the pane predates it); later polls re-query.
function waitForShellReady(paneId, deadline, pstable = queryTree()) {
  for (;;) {
    if (isIdleShell(paneId, pstable)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(150);
    pstable = queryTree();
  }
}

// Run a pane's saved command. `fresh` means we just created this pane (recreate
// mode), so it's an empty shell we own: wait for it to settle, then run
// unconditionally. Otherwise (rehydrate, filling a pre-existing pane) keep the
// guard that avoids clobbering something the user already has running there.
// `liveCwd` is the paired live pane's cwd; recreate passes none.
function fillPane(paneId, pane, o, act, { liveCwd, fresh = false } = {}) {
  if (!sameCwd(liveCwd, pane.cwd)) {
    o.tally.cwdMismatch++;
    act('skip', `${paneId} (cwd differs: live ${liveCwd} vs saved ${pane.cwd})`);
    return;
  }
  o.tally.paired++; // structurally paired — the gates below skip fills, not pairing

  // agentResume=false means agent panes are not ours to touch at all: launching a
  // bare agent binary would start a fresh, amnesiac session and double-handle panes
  // that herdr's native resume_agents_on_restore owns.
  if (pane.agent && !settings.load().agentResume) {
    act('skip', `${paneId} (agent pane, agentResume=false)`);
    return;
  }
  const cmd = commandFor(pane);
  const kind = pane.agent ? `agent:${pane.agent.name}` : `cmd:${pane.command && pane.command.name}`;
  if (!cmd) {
    if (pane.command && !pane.command.restorable)
      act('skip', `${paneId} (${pane.command.name} not on allowlist)`);
    return;
  }
  if (!o.dryRun) {
    if (fresh) {
      waitForShellReady(paneId, Date.now() + 4500); // best effort; run even if it never reports idle
    } else if (!waitForShellReady(paneId, o.idleDeadline, o.pstable)) {
      act('skip', `${paneId} already running something`);
      return;
    }
  }
  act('run', `${paneId} <- ${kind}: ${cmd}`);
  if (!o.dryRun) herdr.runInPane(paneId, cmd);
}

// Ensure a tab has `panes.length` live panes; create the missing ones via splits.
// Recreate mode only — rehydrate never creates panes. Linear fallback used when
// we don't have per-pane rects to reconstruct the real split tree. Returns the
// live pane ids in snapshot order.
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

// Returns the new live workspace id (null on a dry run).
function recreateWorkspace(ws, o, act) {
  act('workspace.create', `#${ws.number} "${ws.label}" (${ws.cwd || 'default cwd'})`);
  let created;
  if (!o.dryRun) created = herdr.createWorkspace({ cwd: ws.cwd, label: ws.label });

  (ws.tabs || []).forEach((tab, ti) => {
    let firstPaneId, tabCwd = tab.panes[0] ? tab.panes[0].cwd : ws.cwd;
    if (ti === 0) {
      // The new workspace already has a root tab; give it this tab's name (herdr
      // names it "1" by default) instead of creating an extra tab.
      firstPaneId = o.dryRun ? '<root-pane>' : created.root_pane.pane_id;
      if (!o.dryRun && tab.label) {
        act('tab.rename', `root -> "${tab.label}"`);
        try { herdr.renameTab(created.tab.tab_id, tab.label); } catch {}
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
  return o.dryRun ? null : created.workspace.workspace_id;
}

// Pair saved tabs with live tabs, best evidence first, each live tab at most
// once (aliasing two saved tabs onto one live tab would inflate agreement and
// type two tabs' commands into the same panes): (1) exact tab_id — herdr's
// native restore preserves ids; (2) same tab number, when the saved tab has
// one; (3) same position. Unpaired saved tabs stay unpaired.
function pairTabs(savedTabs, liveTabs) {
  const chosen = new Array(savedTabs.length).fill(null);
  const used = new Set();
  const claim = (ti, t) => { chosen[ti] = t; used.add(t.tab_id); };
  savedTabs.forEach((tab, ti) => {
    const hit = liveTabs.find((t) => t.tab_id === tab.tab_id && !used.has(t.tab_id));
    if (hit) claim(ti, hit);
  });
  savedTabs.forEach((tab, ti) => {
    if (chosen[ti]) return;
    const hit = tab.number != null && liveTabs.find((t) => t.number === tab.number && !used.has(t.tab_id));
    if (hit) claim(ti, hit);
  });
  savedTabs.forEach((tab, ti) => {
    if (chosen[ti] || !liveTabs[ti] || used.has(liveTabs[ti].tab_id)) return;
    claim(ti, liveTabs[ti]);
  });
  return chosen;
}

// Pair saved panes with live panes inside one tab: exact pane_id first (ids
// survive native restore), then by position among what's left, each live pane
// at most once.
function pairPanes(savedPanes, livePanes) {
  const chosen = new Array(savedPanes.length).fill(null);
  const used = new Set();
  savedPanes.forEach((p, i) => {
    const hit = p.pane_id != null && livePanes.find((lp) => lp.pane_id === p.pane_id && !used.has(lp.pane_id));
    if (hit) { chosen[i] = hit; used.add(hit.pane_id); }
  });
  const rest = livePanes.filter((lp) => !used.has(lp.pane_id));
  let ri = 0;
  savedPanes.forEach((p, i) => { if (!chosen[i]) chosen[i] = rest[ri++] || null; });
  return chosen;
}

function rehydrateWorkspace(ws, liveWs, o, act, live) {
  act('rehydrate', `#${ws.number} "${ws.label}" into ${liveWs.workspace_id}`);
  const liveTabs = herdr.tabList(liveWs.workspace_id).sort((a, b) => (a.number || 0) - (b.number || 0));
  const layoutByTab = {};
  for (const l of (live && live.layouts) || []) layoutByTab[l.tab_id] = l;

  const savedTabs = ws.tabs || [];
  const pairedTabs = pairTabs(savedTabs, liveTabs);
  const allPanes = herdr.paneList(liveWs.workspace_id);

  savedTabs.forEach((tab, ti) => {
    const liveTab = pairedTabs[ti];
    if (!liveTab) {
      o.tally.missingTab += tab.panes.length;
      act('warn', `no live tab #${tab.number} in ${liveWs.workspace_id}; skipping`);
      return;
    }
    // Live panes in this tab, ordered top-to-bottom/left-to-right like the snapshot.
    const livePanes = orderLiveGeometric(
      allPanes.filter((p) => p.tab_id === liveTab.tab_id),
      layoutByTab[liveTab.tab_id]
    );

    // Fill-only: never split to make up for missing panes. herdr's native restore
    // owns the layout; if a saved pane has no live counterpart the user (or a
    // fresher shutdown) removed it, and recreating it here would resurrect a
    // layout that no longer exists — splitting live panes in the process.
    const paired = pairPanes(tab.panes, livePanes);
    tab.panes.forEach((p, i) => {
      const livePane = paired[i];
      if (!livePane) {
        o.tally.missingPane++;
        act('skip', `${p.pane_id || `pane[${i}]`} (missing pane, not creating in rehydrate mode)`);
        return;
      }
      fillPane(livePane.pane_id, p, o, act, { liveCwd: livePane.cwd });
    });
  });
}

// Order live panes the way the snapshot ordered the saved ones — top-to-bottom,
// then left-to-right by layout rect — so saved pane i pairs with the live pane in
// the same screen position, not with whatever a pane_id string sort yields (herdr
// pane ids are base-36 counters, so id order is neither creation nor geometry).
function orderLiveGeometric(panes, layout) {
  const rectOf = {};
  for (const lp of (layout && layout.panes) || []) if (lp.rect) rectOf[lp.pane_id] = lp.rect;
  if (!panes.every((p) => rectOf[p.pane_id])) return orderLive(panes);
  return panes.slice().sort((a, b) => {
    const ra = rectOf[a.pane_id], rb = rectOf[b.pane_id];
    return ra.y - rb.y || ra.x - rb.x;
  });
}

// live pane list entries don't carry rects; order by pane_id as a stable fallback.
function orderLive(panes) {
  return panes.slice().sort((a, b) => String(a.pane_id).localeCompare(String(b.pane_id), undefined, { numeric: true }));
}

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
