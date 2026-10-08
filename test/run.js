#!/usr/bin/env node
'use strict';
// Plain-Node test runner — no framework, no live herdr server. Points the plugin's
// state/config dirs at a throwaway temp dir BEFORE any lib module is loaded, so
// tests can never touch real snapshots or settings.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-resurrect-test-'));
process.env.HERDR_PLUGIN_STATE_DIR = path.join(tmp, 'state');
process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(tmp, 'config');

const { finish } = require('./helpers');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort())
  require(path.join(__dirname, f));

finish();
