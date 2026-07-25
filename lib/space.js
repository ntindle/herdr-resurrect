'use strict';
// Named "spaces": save a single workspace as a reusable, named snapshot and open
// it later as a brand-new workspace. Built on the same model as full-session
// snapshots (lib/snapshot.build) and the same rebuild logic (lib/restore.restore),
// just scoped to one workspace and stored one-file-per-name under SPACES_DIR.
const fs = require('fs');
const path = require('path');
const snapshot = require('./snapshot');
const restore = require('./restore');
const herdr = require('./herdr');
const { SPACES_DIR, ensureSpacesDir } = require('./paths');

const SPACE_VERSION = 1;

// Turn a human name into a safe, stable filename stem. The original name is kept
// inside the file for display, so this only needs to be filesystem-safe + unique.
function slugify(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return s || 'space';
}

function fileForSlug(slug) {
  return path.join(SPACES_DIR, `${slug}.json`);
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function summarize(ws) {
  let t = 0, p = 0, c = 0, a = 0;
  for (const tab of ws.tabs || []) {
    t++;
    for (const pane of tab.panes || []) {
      p++;
      if (pane.agent) a++;
      else if (pane.command && pane.command.restorable) c++;
    }
  }
  return { tabs: t, panes: p, commands: c, agents: a };
}

// Save the given workspace (defaults to the focused one) as a named space.
// Returns { file, slug, name, workspace, summary }.
function saveSpace({ workspaceId, name } = {}) {
  const model = snapshot.build();
  const wsId = workspaceId || (model.focused && model.focused.workspace_id);
  const ws =
    model.workspaces.find((w) => w.workspace_id === wsId) ||
    (model.workspaces.length === 1 ? model.workspaces[0] : null);
  if (!ws) {
    throw new Error(
      `could not find workspace ${wsId || '(focused)'} in the current session`
    );
  }
  const displayName = String(name || ws.label || 'space').trim();
  const slug = slugify(displayName);

  const spaceModel = {
    version: snapshot.SNAPSHOT_VERSION,
    space_version: SPACE_VERSION,
    tool: 'herdr-resurrect',
    kind: 'space',
    name: displayName,
    saved_at: new Date().toISOString(),
    source_workspace: { id: ws.workspace_id, number: ws.number, label: ws.label },
    // restore() focuses model.focused.workspace_id after rebuild; point it at the
    // (only) saved workspace so opening a space lands you in it.
    focused: { workspace_id: ws.workspace_id, tab_id: ws.active_tab_id, pane_id: null },
    workspaces: [ws],
  };

  ensureSpacesDir();
  const file = fileForSlug(slug);
  writeAtomic(file, JSON.stringify(spaceModel, null, 2));
  return { file, slug, name: displayName, workspace: ws, summary: summarize(ws) };
}

// List saved spaces, newest first. Returns [{ name, slug, file, saved_at, summary }].
function listSpaces() {
  let files;
  try {
    files = fs.readdirSync(SPACES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const file = path.join(SPACES_DIR, f);
    const slug = f.replace(/\.json$/, '');
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        name: m.name || slug,
        slug,
        file,
        saved_at: m.saved_at || null,
        summary: summarize((m.workspaces && m.workspaces[0]) || { tabs: [] }),
      });
    } catch {
      out.push({ name: slug, slug, file, saved_at: null, summary: null });
    }
  }
  out.sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
  return out;
}

// Resolve a user-supplied name/slug to a saved space file.
function resolve(nameOrSlug) {
  const slug = slugify(nameOrSlug);
  const direct = fileForSlug(slug);
  if (fs.existsSync(direct)) return direct;
  // Fall back to matching the stored display name.
  const hit = listSpaces().find(
    (s) => s.slug === slug || s.name.toLowerCase() === String(nameOrSlug).trim().toLowerCase()
  );
  if (hit) return hit.file;
  throw new Error(`no saved space named "${nameOrSlug}"`);
}

// Open a saved space as a brand-new workspace. Always recreates (never rehydrates
// into an existing workspace), so opening the same space twice gives two copies.
function openSpace(nameOrSlug, { dryRun = false, log = () => {} } = {}) {
  const file = resolve(nameOrSlug);
  const model = restore.loadModel(file);
  const result = restore.restore(model, { mode: 'recreate', dryRun, log });
  return { file, result };
}

module.exports = { saveSpace, listSpaces, openSpace, resolve, slugify, SPACE_VERSION };
