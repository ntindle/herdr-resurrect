'use strict';
// Thin wrapper around the herdr CLI. Every plugin process is handed HERDR_BIN_PATH
// (and HERDR_SOCKET_PATH) by the host; we drive herdr through its CLI, which speaks
// the same socket API and returns JSON on stdout.
const { spawnSync } = require('child_process');

const BIN = process.env.HERDR_BIN_PATH || 'herdr';
const RETRIES = Number(process.env.HERDR_RESURRECT_RETRIES || 4);

// The herdr socket occasionally drops a request under rapid successive calls
// ("BrokenPipe" / "pipe is being closed" / connection reset). These are transient,
// so retry a few times with a short backoff before giving up.
function isTransient(res) {
  if (res.status === 0) return false;
  const blob = `${res.stdout || ''}${res.stderr || ''}`;
  return /BrokenPipe|pipe is being closed|Connection reset|ConnectionReset|os error 232|WouldBlock|Broken pipe/i.test(blob);
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}

function raw(args, opts = {}) {
  let res;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    res = spawnSync(BIN, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      ...opts,
    });
    if (res.error) throw new Error(`herdr ${args.join(' ')}: ${res.error.message}`);
    if (attempt < RETRIES && isTransient(res)) { sleepSync(120 + attempt * 120); continue; }
    break;
  }
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// Some herdr responses print a human line before/after the JSON body; slice from the
// first bracket so we tolerate that without being brittle about exact formatting.
function extractJson(text) {
  const o = text.indexOf('{');
  const a = text.indexOf('[');
  const i = o === -1 ? a : a === -1 ? o : Math.min(o, a);
  return i === -1 ? text : text.slice(i);
}

function json(args) {
  const { code, stdout, stderr } = raw(args);
  const text = (stdout && stdout.trim()) || (stderr && stderr.trim()) || '';
  try {
    return JSON.parse(extractJson(text));
  } catch (e) {
    throw new Error(`herdr ${args.join(' ')} returned non-JSON (exit ${code}): ${text.slice(0, 300)}`);
  }
}

// CLI envelopes look like { id, result: {...} }; unwrap when present.
const result = (obj) => (obj && obj.result !== undefined ? obj.result : obj);

// ---- reads -----------------------------------------------------------------
function snapshot() {
  return result(json(['api', 'snapshot'])).snapshot;
}
function processInfo(paneId) {
  try {
    return result(json(['pane', 'process-info', '--pane', paneId])).process_info;
  } catch {
    return null; // pane may have just closed, or lacks a PTY we can introspect
  }
}
function agentList() {
  try { return result(json(['agent', 'list'])).agents || []; } catch { return []; }
}
function paneList(workspaceId) {
  const args = workspaceId ? ['pane', 'list', '--workspace', workspaceId] : ['pane', 'list'];
  return result(json(args)).panes || [];
}
function tabList(workspaceId) {
  const args = workspaceId ? ['tab', 'list', '--workspace', workspaceId] : ['tab', 'list'];
  return result(json(args)).tabs || [];
}

// The named session (`herdr --session <name>`) this process belongs to, or null for
// the default session and when it cannot be determined. The host sets HERDR_SESSION
// for named sessions; failing that, match the socket it handed us against
// `session list`, which is the authoritative name <-> socket mapping on every OS.
let _session;
function sessionName() {
  if (_session !== undefined) return _session;
  _session = null;
  const env = (process.env.HERDR_SESSION || '').trim();
  if (env) return (_session = env === 'default' ? null : env);
  const sock = (process.env.HERDR_SOCKET_PATH || '').trim();
  if (!sock) return null;
  const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
  try {
    const sessions = result(json(['session', 'list', '--json'])).sessions || [];
    const mine = sessions.find((s) => s.socket_path && norm(s.socket_path) === norm(sock));
    if (mine && !mine.default && mine.name) _session = mine.name;
  } catch { /* session.list unavailable (older herdr, restricted proxy): treat as default */ }
  return _session;
}

// ---- writes ----------------------------------------------------------------
function createWorkspace({ cwd, label } = {}) {
  const args = ['workspace', 'create', '--no-focus'];
  if (cwd) args.push('--cwd', cwd);
  if (label) args.push('--label', label);
  return result(json(args)); // { workspace, tab, root_pane }
}
function createTab({ workspace, cwd, label } = {}) {
  const args = ['tab', 'create', '--no-focus'];
  if (workspace) args.push('--workspace', workspace);
  if (cwd) args.push('--cwd', cwd);
  if (label) args.push('--label', label);
  return result(json(args));
}
function splitPane(paneId, { direction = 'right', ratio, cwd } = {}) {
  const args = ['pane', 'split', paneId, '--direction', direction, '--no-focus'];
  if (ratio) args.push('--ratio', String(ratio));
  if (cwd) args.push('--cwd', cwd);
  return result(json(args)).pane; // pane_info
}
function runInPane(paneId, command) {
  return raw(['pane', 'run', paneId, command]);
}
function renamePane(paneId, label) {
  return raw(['pane', 'rename', paneId, label]);
}
function renameTab(tabId, label) {
  return raw(['tab', 'rename', tabId, label]);
}
function focusWorkspace(id) { return raw(['workspace', 'focus', id]); }
function focusTab(id) { return raw(['tab', 'focus', id]); }

// Best-effort toast through herdr's `notification.show` (herdr >= 0.6.3, routed via
// the user's [ui.toast] delivery). Never throws: a blocked or unsupported toast must
// not fail the caller. Returns { shown, reason }; reason mirrors herdr's own
// ("shown", "disabled", "rate_limited", "no_foreground_client", "busy") or the error.
function showNotification({ title, body, position, sound } = {}) {
  const args = ['notification', 'show', title];
  if (body) args.push('--body', body);
  if (position) args.push('--position', position);
  if (sound) args.push('--sound', sound);
  try {
    const r = result(json(args));
    if (r && r.error) return { shown: false, reason: r.error.message || r.error.code || 'error' };
    return { shown: !!(r && r.shown), reason: (r && r.reason) || 'unknown' };
  } catch (e) {
    return { shown: false, reason: e.message };
  }
}

module.exports = {
  BIN, raw, json, result,
  snapshot, processInfo, agentList, paneList, tabList, sessionName,
  createWorkspace, createTab, splitPane, runInPane, renamePane, renameTab,
  focusWorkspace, focusTab, showNotification,
};
