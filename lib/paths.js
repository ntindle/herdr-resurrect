'use strict';
// Where the plugin keeps its durable state and user config. The host injects
// HERDR_PLUGIN_STATE_DIR / HERDR_PLUGIN_CONFIG_DIR; we fall back to sane per-user
// locations so the scripts also work when run by hand (e.g. `node bin/save.js`).
const os = require('os');
const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..');

const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  path.join(os.homedir(), '.local', 'state', 'herdr-resurrect');

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ||
  path.join(os.homedir(), '.config', 'herdr-resurrect');

const SNAP_DIR = path.join(STATE_DIR, 'snapshots');
const LAST = path.join(STATE_DIR, 'last.json');

function ensureDirs() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

module.exports = { PLUGIN_ROOT, STATE_DIR, CONFIG_DIR, SNAP_DIR, LAST, ensureDirs };
