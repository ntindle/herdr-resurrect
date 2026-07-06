'use strict';
// User-editable plugin settings, seeded once into $HERDR_PLUGIN_CONFIG_DIR/settings.json.
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./paths');

const FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULTS = {
  // Auto-restore the session once, on the first event after a server (re)start.
  // Off by default (tmux-continuum is also opt-in): flip to true to enable.
  autoRestore: false,
  // How long to wait after the first boot event before rehydrating, so herdr has
  // finished recreating the pane shape. Milliseconds.
  autoRestoreSettleMs: 2500,
  // When relaunching an agent pane, try the agent CLI's own resume/continue flags.
  agentResume: true,
  // Optional overrides: { "<agentName>": { "resume": "--resume {value}", "continue": "--continue" } }
  agentResumeCommands: {},
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
  _cache = { ...DEFAULTS, ...user, agentResumeCommands: { ...DEFAULTS.agentResumeCommands, ...(user.agentResumeCommands || {}) } };
  // Env override for quick toggling without editing the file.
  if (process.env.HERDR_RESURRECT_AUTO_RESTORE != null)
    _cache.autoRestore = /^(1|true|on|yes)$/i.test(process.env.HERDR_RESURRECT_AUTO_RESTORE);
  return _cache;
}

module.exports = { load, FILE, DEFAULTS };
