'use strict';
// User-editable plugin settings, seeded once into $HERDR_PLUGIN_CONFIG_DIR/settings.json.
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./paths');

const FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULTS = {
  // Auto-restore the session once per server start, from the [[startup]] hook that
  // herdr runs after its native restore. Off by default (tmux-continuum is also
  // opt-in): flip to true to enable.
  autoRestore: false,
  // How long the startup hook waits before rehydrating, so herdr has finished
  // materializing the restored panes. Milliseconds.
  autoRestoreSettleMs: 2500,
  // Auto-restore sanity check: the share (0..1) of saved panes that must map onto
  // the natively restored session — same workspace/tab position, same cwd — before
  // the startup hook rehydrates. Below it the snapshot predates the current layout
  // (e.g. autosave died before shutdown) and is refused with a pointer to the
  // snapshot file. Structural, so it is immune to downtime length and quiet
  // sessions. 0 disables; non-numeric values fall back to the default.
  minAgreement: 0.5,
  // Agent panes: true = relaunch the agent CLI with its own resume/continue flags
  // where known; false = don't touch agent panes at all (no launch, no fill) —
  // herdr's native resume_agents_on_restore owns them then.
  agentResume: true,
  // Optional overrides: { "<agentName>": { "resume": "--resume {value}", "continue": "--continue" } }
  agentResumeCommands: {},
  // herdr toasts, per trigger (success and failure alike). onSave: the save action;
  // onAutoSave: event-driven and timer autosaves; onRestore: the restore action and
  // the boot-time auto-restore. Dry runs never toast.
  notify: { onSave: false, onAutoSave: false, onRestore: false },
};

let _cache = null;
function load() {
  if (_cache) return _cache;
  let user = {};
  try {
    if (fs.existsSync(FILE)) user = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    else {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
    }
  } catch { /* fall back to defaults */ }
  _cache = {
    ...DEFAULTS,
    ...user,
    agentResumeCommands: { ...DEFAULTS.agentResumeCommands, ...(user.agentResumeCommands || {}) },
    notify: { ...DEFAULTS.notify, ...(user.notify && typeof user.notify === 'object' ? user.notify : {}) },
  };
  // Env override for quick toggling without editing the file.
  if (process.env.HERDR_RESURRECT_AUTO_RESTORE != null)
    _cache.autoRestore = /^(1|true|on|yes)$/i.test(process.env.HERDR_RESURRECT_AUTO_RESTORE);
  return _cache;
}

// A mis-typed minAgreement must not silently disable (null, "", -1) or silently
// maximize (a percentage like 50) the guard: only a finite number — or numeric
// string — already inside [0, 1] is accepted; everything else falls back to the
// shipped default. A literal 0 is the documented off switch.
function sanitizeMinAgreement(v) {
  const n =
    typeof v === 'number' ? v :
    typeof v === 'string' && v.trim() !== '' ? Number(v) :
    NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULTS.minAgreement;
}

module.exports = { load, FILE, DEFAULTS, sanitizeMinAgreement };
