'use strict';
// Process-tree fallback for pane command capture. herdr's `pane process-info` on
// Windows only reports a program once it becomes the console's foreground
// process-group leader — agents do, but a plain `ping`, `node server.js` or
// `npm run dev` shows up as just the shell and is lost. We recover it by walking
// the pane shell's process tree from one bulk query (CIM on Windows, `ps` on
// Linux/macOS — where process-info normally works, so the tree mostly hardens the
// idle check), run once per snapshot/restore.
const { spawnSync } = require('child_process');
const path = require('path');

const IGNORE_NAMES = new Set(['conhost.exe', 'openconsole.exe']);
// Never capture the plugin's own processes as "the pane's program" (the autosave
// pane, event handlers, or a manual `node bin/save.js` run inside a pane).
const SELF_RE = /herdr-resurrect|bin[\\/](save|restore|list|on-event|autosave)\.js/i;

function parseCimDate(v) {
  if (v == null) return 0;
  const m = /\/Date\((\d+)\)\//.exec(String(v)); // Windows PowerShell 5.1 JSON dates
  if (m) return Number(m[1]);
  const t = Date.parse(v); // pwsh 7 emits ISO strings
  return Number.isNaN(t) ? 0 : t;
}

function queryWindows() {
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (ps.status !== 0 || !ps.stdout) return null;
  let rows;
  try { rows = JSON.parse(ps.stdout); } catch { return null; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  return rows
    .filter((r) => r && r.ProcessId != null)
    .map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      name: r.Name || '',
      cmdline: r.CommandLine || null,
      created: parseCimDate(r.CreationDate),
    }));
}

// `lstart` is a fixed "Dow Mon DD HH:MM:SS YYYY" on both BSD and GNU ps; parse it
// by hand — Date.parse is not reliable for that field order everywhere.
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseLstart(dow, mon, day, hms, year) {
  const [h, m, s] = hms.split(':').map(Number);
  return new Date(Number(year), MONTHS[mon] ?? 0, Number(day), h, m, s).getTime();
}

function queryUnix() {
  // -A: all processes; keyword= suppresses headers on BSD and GNU ps alike.
  // args must be last — it contains spaces.
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,lstart=,args='],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (ps.status !== 0 || !ps.stdout) return null;
  const rows = [];
  const LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3})\s+(\w{3})\s+(\d+)\s+([\d:]+)\s+(\d{4})\s+(.*)$/;
  for (const line of ps.stdout.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const cmdline = m[8].trim();
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: path.basename(cmdline.split(/\s+/)[0] || ''),
      cmdline,
      created: parseLstart(m[3], m[4], m[5], m[6], m[7]),
    });
  }
  return rows.length ? rows : null;
}

// One bulk snapshot of every process: pid/ppid/name/cmdline/created.
// Returns { byPid, children } maps, or null on failure.
function query() {
  const rows = process.platform === 'win32' ? queryWindows() : queryUnix();
  if (!rows) return null;
  const byPid = new Map();
  const children = new Map();
  for (const p of rows) {
    byPid.set(p.pid, p);
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  return { byPid, children };
}

function interesting(p) {
  if (!p) return false;
  if (IGNORE_NAMES.has(String(p.name).toLowerCase())) return false;
  if (p.cmdline && SELF_RE.test(p.cmdline)) return false;
  return true;
}

function descendants(table, rootPid) {
  const out = [];
  const queue = [...(table.children.get(rootPid) || [])];
  const seen = new Set([rootPid]); // guard against pid-reuse cycles
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    queue.push(...(table.children.get(p.pid) || []));
  }
  return out;
}

// The primary user-launched program in a pane: the oldest direct child of the pane's
// shell that isn't console plumbing (its own children are helpers it respawns);
// fall back to the oldest interesting descendant.
function paneCommand(table, shellPid) {
  if (!table || !shellPid) return null;
  const direct = (table.children.get(shellPid) || []).filter(interesting);
  const pool = direct.length ? direct : descendants(table, shellPid).filter(interesting);
  if (pool.length === 0) return null;
  pool.sort((a, b) => a.created - b.created);
  const p = pool[0];
  return { pid: p.pid, name: p.name, argv0: p.name, argv: null, cmdline: p.cmdline, cwd: null };
}

// Whether anything real is running under the pane's shell (restore's idle check).
function busy(table, shellPid) {
  if (!table || !shellPid) return false;
  return descendants(table, shellPid).some(interesting);
}

module.exports = { query, paneCommand, busy };
