'use strict';
// Best-effort recovery of an agent's native conversation/session id from the agent
// CLI's OWN on-disk session store, keyed by the pane's cwd. Used when herdr didn't
// report an agent_session ref at snapshot time (detection lag, or the integration
// doesn't surface one on this platform). The newest store entry for the pane's cwd
// is almost always the conversation that was live in that pane.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function mtimeMs(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// First line of a file. Codex session_meta lines embed the agent's full base
// instructions and can run to hundreds of KB, so grow the read until we hit \n.
function readFirstLine(file, cap = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    let text = '';
    let pos = 0;
    while (pos < cap) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      text += chunk.slice(0, n).toString('utf8');
      pos += n;
      const nl = text.indexOf('\n');
      if (nl !== -1) return text.slice(0, nl);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

const normCwd = (c) => String(c || '').replace(/[\\/]+$/, '');
// Windows and (default) macOS filesystems are case-insensitive; Linux is not.
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const foldCase = (s) => (FOLD ? s.toLowerCase() : s);
const sameCwd = (a, b) => foldCase(normCwd(a)) === foldCase(normCwd(b));

// ---- per-agent store readers: (cwd) -> [{ value, at }] -----------------------

// claude: ~/.claude/projects/<munged cwd>/<session-uuid>.jsonl
// munge = every non-alphanumeric character becomes '-'.
function claude(cwd) {
  const munged = normCwd(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(HOME, '.claude', 'projects', munged);
  return listDir(dir)
    .filter((f) => f.endsWith('.jsonl') && UUID_RE.test(f.slice(0, -6)))
    .map((f) => ({ value: f.slice(0, -6), at: mtimeMs(path.join(dir, f)) }));
}

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl; the first line is a
// session_meta record carrying payload.{id,cwd}. Skip subagent threads — resuming
// one would rejoin a worker, not the conversation the pane showed.
function codex(cwd) {
  const root = path.join(HOME, '.codex', 'sessions');
  const files = [];
  for (const y of listDir(root))
    for (const m of listDir(path.join(root, y)))
      for (const d of listDir(path.join(root, y, m)))
        for (const f of listDir(path.join(root, y, m, d)))
          if (f.startsWith('rollout-') && f.endsWith('.jsonl'))
            files.push(path.join(root, y, m, d, f));
  files.sort((a, b) => mtimeMs(b) - mtimeMs(a));
  const out = [];
  for (const f of files.slice(0, 50)) { // only crack open the recent ones
    try {
      const meta = JSON.parse(readFirstLine(f));
      const p = meta && meta.payload;
      if (!p || !p.id || !sameCwd(p.cwd, cwd)) continue;
      if (p.thread_source === 'subagent' || (p.source && p.source.subagent)) continue;
      out.push({ value: p.id, at: mtimeMs(f) });
    } catch { /* not a session file we understand */ }
  }
  return out;
}

// copilot: ~/.copilot/session-state/<session-id>/workspace.yaml with cwd: and id:.
function copilot(cwd) {
  const root = path.join(HOME, '.copilot', 'session-state');
  const out = [];
  for (const d of listDir(root)) {
    const y = path.join(root, d, 'workspace.yaml');
    try {
      const text = fs.readFileSync(y, 'utf8');
      const cm = text.match(/^cwd:\s*(.+?)\s*$/m);
      if (!cm || !sameCwd(cm[1], cwd)) continue;
      const im = text.match(/^id:\s*(\S+)/m);
      out.push({ value: im ? im[1] : d, at: mtimeMs(y) });
    } catch { /* no workspace.yaml — not a session dir */ }
  }
  return out;
}

// cursor: ~/.cursor/chats/<md5 of exact cwd string>/<chat-uuid>/
function cursor(cwd) {
  const exact = crypto.createHash('md5').update(normCwd(cwd)).digest('hex');
  const dir = path.join(HOME, '.cursor', 'chats', exact);
  return listDir(dir)
    .filter((d) => UUID_RE.test(d) && isDir(path.join(dir, d)))
    .map((d) => ({ value: d, at: mtimeMs(path.join(dir, d)) }));
}

const RESOLVERS = { claude, codex, copilot, cursor };

// One resolver per snapshot run. When several panes run the same agent in the same
// cwd, hand each successive pane the next-newest session so two restored panes
// don't resume the same conversation.
function makeResolver() {
  const handed = new Map();
  return function resolve(agentName, cwd) {
    const name = String(agentName || '').toLowerCase();
    const reader = RESOLVERS[name];
    if (!reader || !cwd) return null;
    let sessions;
    try { sessions = reader(cwd); } catch { return null; }
    if (!sessions || sessions.length === 0) return null;
    sessions.sort((a, b) => b.at - a.at);
    const key = `${name}\n${foldCase(normCwd(cwd))}`;
    const n = handed.get(key) || 0;
    handed.set(key, n + 1);
    const pick = sessions[Math.min(n, sessions.length - 1)];
    return { agent: name, kind: 'id', value: pick.value, source: `store:${name}` };
  };
}

module.exports = { makeResolver, RESOLVERS };
