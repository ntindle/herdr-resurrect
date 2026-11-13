# herdr-resurrect

**tmux-resurrect for [herdr](https://herdr.dev).** Snapshot your whole herd —
workspaces, tabs, panes, working directories, the programs running in each pane,
and your AI agents — to durable, versioned files on disk, and bring it all back
after a crash, reboot, or `herdr server stop`.

Think [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) +
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum), adapted to
herdr's socket API.

---

## Does herdr not already do this? (read this first)

Partly — and this plugin is designed to fill the gap, not duplicate what's built in.

herdr **already** does, natively, after a server restart or crash:

| Built-in | What it restores |
| --- | --- |
| Session shape restore | workspaces, tabs, panes, **cwd**, layout, focus |
| `[session] resume_agents_on_restore` | resumes *supported* agents into their native conversation session — **only when the integration reports a session ref** |
| `[experimental] pane_history` (off by default) | recent on-screen **text** (visual only) |

What herdr does **not** do — the tmux-resurrect niche this plugin adds:

1. **Re-runs the programs that were live in each pane.** herdr brings panes back as
   *bare shells in their saved directory*. Your `npm run dev`, `nvim`, `tail -f`,
   `htop`, `psql` are **not** relaunched. This plugin relaunches them (allowlisted).
2. **Periodic, versioned, durable snapshots** (continuum-style) you can list and
   restore from — a belt-and-suspenders history that survives even if herdr's own
   internal state is lost, plus multiple restore points instead of one implicit shape.
3. **An explicit "resurrect everything" action + keybinding**, and a **dry-run** so
   you can see exactly what will happen before it touches your session.

It complements the built-ins: after a crash, herdr restores the *shape*, and this
plugin **rehydrates** those bare panes by re-running what was in them.

---

## Install

Requires **Node.js** (used by the plugin scripts; no npm dependencies) and
**herdr ≥ 0.7.5** (auto-restore rides on the plugin `[[startup]]` hooks added
in 0.7.5).

```sh
# from GitHub / the herdr plugin marketplace:
herdr plugin install ntindle/herdr-resurrect

# or from a local checkout (while iterating):
herdr plugin link /path/to/herdr-resurrect

herdr plugin list          # confirm it registered
```

## Usage

### Actions

Run from the herdr command palette (or bind keys, below):

| Action | Does |
| --- | --- |
| `Resurrect: save snapshot` | write a snapshot now |
| `Resurrect: restore last snapshot` | rebuild / rehydrate from the newest snapshot |
| `Resurrect: preview restore (dry run)` | show the plan, change nothing |
| `Resurrect: list snapshots` | list saved snapshots |
| `Resurrect: save this space as…` | save the **current workspace** as a named, reusable space |
| `Resurrect: open saved space…` | fuzzy-pick a saved space and open it as a **new workspace** |
| `Resurrect: delete saved space…` | fuzzy-pick a saved space and delete it (with confirm) |

Invoke without keybindings via the CLI too:

```sh
herdr plugin action invoke ntindle.herdr-resurrect.save
herdr plugin action invoke ntindle.herdr-resurrect.restore-preview
```

### Keybindings (optional)

Add to your `config.toml` (`herdr` → config file path shown by `herdr --help`):

```toml
[[keys.command]]
key = "prefix+ctrl+s"
type = "plugin_action"
command = "ntindle.herdr-resurrect.save"
description = "resurrect: save"

[[keys.command]]
key = "prefix+ctrl+r"
type = "plugin_action"
command = "ntindle.herdr-resurrect.restore"
description = "resurrect: restore"

# named spaces (below)
[[keys.command]]
key = "prefix+S"
type = "plugin_action"
command = "ntindle.herdr-resurrect.save-space"
description = "resurrect: save this space as…"

[[keys.command]]
key = "prefix+O"
type = "plugin_action"
command = "ntindle.herdr-resurrect.open-space"
description = "resurrect: open saved space…"
```

### Saved spaces (named workspaces)

Where snapshots are for crash recovery of the **whole herd**, *spaces* are a
library of **named, reusable single-workspace layouts** — "my debugging setup",
"client demo", "blog + notes" — that you save once and open whenever you want.

- **`Resurrect: save this space as…`** prompts for a name (in an overlay) and
  writes the **current** workspace — its tabs, panes, cwds, running commands, and
  agents (with resume ids where available) — to one file per name.
- **`Resurrect: open saved space…`** fuzzy-picks a saved space and rebuilds it as
  a **brand-new** workspace, so opening the same space twice gives you two copies.

Spaces live in `$HERDR_PLUGIN_STATE_DIR/spaces/<name>.json`, one file per space, so
you can keep as many as you like (and back them up / sync them). List or drive
them from the CLI too:

```sh
node "$HERDR_PLUGIN_ROOT/bin/list-spaces.js"               # human list
node "$HERDR_PLUGIN_ROOT/bin/save-space.js"   --name foo   # save the focused workspace
node "$HERDR_PLUGIN_ROOT/bin/open-space.js"   --name foo   # open it as a new workspace
node "$HERDR_PLUGIN_ROOT/bin/delete-space.js" --name foo   # delete a saved space
```

Opening a space reproduces the workspace faithfully: **tab names and on-screen
order** are preserved, and **nested pane layouts** (e.g. a `1 / 2 / 1` stack) are
rebuilt from the saved split tree rather than flattened.

> The interactive overlays use a name prompt and `fzf`, so the two space actions
> are macOS/Linux only (the underlying CLI works everywhere).

Then `herdr server reload-config`. (Prefix defaults to `ctrl+b`, tmux-style.)

### Autosave — pick one (or both)

- **Event-driven (on by default):** the plugin snapshots whenever the session
  shape changes (workspace/pane created or closed, agent detected), debounced to at
  most one write per 20s. Nothing to enable.
- **Timer (continuum-style):** open the bundled **`resurrect autosave`** pane once
  and leave it running; it snapshots every `HERDR_RESURRECT_INTERVAL` seconds
  (default 900) and once more on exit.

### After a crash / reboot

1. Start herdr again. It restores your workspace/tab/pane **shape** (as bare shells).
2. Run **`Resurrect: restore last snapshot`** (or your keybinding).
   By default it **rehydrates** the panes herdr already brought back — re-running the
   commands and relaunching the agents — instead of creating duplicates. If a
   workspace is missing entirely, it's **recreated** from scratch.

Restore is **idempotent**: it only fills panes that are currently idle shells (and
whose cwd still matches the saved pane's), so running it twice does nothing the
second time.

### Auto-restore on startup (opt-in)

Set `autoRestore: true` in `settings.json` (see Configuration) to skip step 2 — the
plugin then rehydrates automatically after every server start, so a crash +
relaunch brings your commands and agents back on its own.

How it works: herdr ≥ 0.7.5 runs each plugin's `[[startup]]` hook once, after its
native session restore finishes. The hook (`bin/on-startup.js`):

- **Reads the pre-boot snapshot first.** Event autosave and the autosave pane stand
  down until the restore is done, so neither can overwrite it mid-restore.
- **Checks that the snapshot still fits.** A dry run measures **agreement**: the share
  of panes present in both the snapshot and the restored session (matched by id where
  herdr preserved them, else by position), over whichever side has more. Below
  `minAgreement` (default `0.5`) the snapshot predates your current layout, typically
  because autosave died before shutdown. The hook then refuses it and prints the plan
  and the snapshot file to apply by hand. This compares structure, not timestamps, so
  downtime length and quiet sessions don't matter.
- **Fills idle panes only.** It never creates panes, tabs, or workspaces, and skips a
  pane whose directory changed. A shell still loading its rc file gets up to 2 s
  (shared by the whole run) to reach its prompt.

Startup hooks also fire on live handoff (in-place server upgrade). That's a no-op:
every pane is still running its program, so nothing runs and focus stays put. It's
off by default so it never surprises you (tmux-continuum's auto-restore is opt-in
too).

### Agent resume

`agentResume` in `settings.json` decides who owns agent panes:

- **`true` (default):** the plugin relaunches agent panes using the agent CLI's own
  resume/continue flags where known — e.g. `claude --resume <id>` when herdr captured
  a native session ref, else `claude --continue`; `codex resume`. Unknown agents
  relaunch fresh. Agents are relaunched by short name (`claude`) so they run in both
  PowerShell and POSIX shells. Override per agent via `agentResumeCommands`.
- **`false`:** the plugin never launches or fills agent panes (logged as
  `skip (agent pane, agentResume=false)`). Use this when herdr's native
  `resume_agents_on_restore` should own agent panes exclusively; launching a bare
  agent binary would only start a fresh, amnesiac session next to it. Note that a
  manual `--recreate` still rebuilds the pane *structure* — the agent pane comes
  back as a bare shell for you (or herdr) to resume into.

## How restore decides (modes)

| Mode | Flag | Behavior |
| --- | --- | --- |
| auto *(default)* | — | rehydrate workspaces that already exist; recreate the rest |
| rehydrate | `--rehydrate` | fill existing **idle** panes only; never creates panes, tabs, or workspaces (missing ones are logged as skips). Auto-restore always uses this mode. |
| recreate | `--recreate` | always build everything from scratch |
| dry run | `--dry-run` | print the plan, touch nothing |
| pick file | `--file <path>` | restore a specific snapshot instead of the newest |

(CLI form, e.g. `node bin/restore.js --recreate --dry-run`, when running scripts directly.)

## Configuration

**Settings** — `$HERDR_PLUGIN_CONFIG_DIR/settings.json`, seeded on first run:

| Key | Default | Meaning |
| --- | --- | --- |
| `autoRestore` | `false` | rehydrate automatically from the `[[startup]]` hook after each server start |
| `autoRestoreSettleMs` | `2500` | how long the startup hook waits before checking and rehydrating; too short on a slow machine and a half-restored session reads as divergence |
| `minAgreement` | `0.5` | share (0–1) of panes present in both the snapshot and the restored session for auto-restore to proceed; below it the snapshot is refused. `0` disables; values outside 0–1 fall back to the default (`50` is not 50%). Manual restores are unaffected. |
| `agentResume` | `true` | `true`: relaunch agent panes with the agent CLI's resume/continue flags; `false`: never touch agent panes (native `resume_agents_on_restore` owns them) |
| `agentResumeCommands` | `{}` | per-agent overrides, e.g. `{ "claude": { "continue": "--continue" } }` |
| `notify` | all `false` | herdr toasts per trigger: `{ "onSave": …, "onAutoSave": …, "onRestore": … }` (see Toasts) |

`HERDR_RESURRECT_AUTO_RESTORE=1` overrides `autoRestore` without editing the file.

**Toasts** - actions and hooks run headless on the server, so a herdr toast is the
only on-screen feedback they can give. All three are off by default; turn on the ones
you want in `settings.json`:

```json
"notify": { "onSave": true, "onAutoSave": false, "onRestore": true }
```

| Key | Fires for | Toasts |
| --- | --- | --- |
| `onSave` | the `save snapshot` action | `Resurrect: snapshot saved` / `snapshot failed` |
| `onAutoSave` | event-driven and timer autosaves | `Resurrect: autosaved` / `autosave failed` |
| `onRestore` | the `restore` action and the startup auto-restore | `Resurrect: restore completed` / `restore failed` / `auto-restore skipped` (snapshot refused by `minAgreement`) |

Dry runs never toast. Inside a named session (`herdr --session <name>`) every title
ends with `(session: <name>)`, so toasts from several sessions can be told apart.
Toasts go through herdr's own `notification.show`, so they
follow your `[ui.toast]` settings (position, terminal or system delivery). A toast
that cannot be shown never fails the save or restore - the reason is logged next to
the result line instead.

**Allowlist** — which non-agent programs get relaunched. Editable copy is created
on first run at `$HERDR_PLUGIN_CONFIG_DIR/allowlist.txt` (seeded from
`config/allowlist.default.txt`). One program name per line; a lone `*` restores
everything. Agents are handled automatically and are **not** listed here.

**Environment variables**

| Var | Default | Meaning |
| --- | --- | --- |
| `HERDR_RESURRECT_INTERVAL` | `900` | autosave-pane interval, seconds |
| `HERDR_RESURRECT_DEBOUNCE` | `20000` | min ms between event-driven saves |
| `HERDR_RESURRECT_KEEP` | `20` | snapshots to retain before pruning |

Snapshots live under `$HERDR_PLUGIN_STATE_DIR/sessions/<session>/snapshots/`, with the
newest also at `.../last.json`.

### Named sessions

Each herdr session (`herdr --session <name>`; the plain `herdr` is `default`) is its
own server with its own workspaces, so each keeps its own snapshots, autosave debounce,
and restore-in-progress marker under `sessions/<name>/`. Save, restore, list, and
auto-restore always act on the session the plugin was invoked from, so a work session
and a personal one never overwrite or rehydrate each other's herd. The plugin tells
sessions apart by the `HERDR_SOCKET_PATH` herdr hands every plugin process
(`HERDR_SESSION` is used when run by hand outside herdr). Saved spaces are a shared
library across all sessions.

Snapshots written before this scoping existed are moved to `sessions/default/` on
first run.

## Limitations (honest)

- **Auto-restore trusts the snapshot only so far.** If autosave stopped before
  shutdown (event handlers can die, e.g. under herdr's concurrent plugin-command
  limit), the last save no longer matches the restored session. The agreement guard
  refuses such a snapshot; it stays in `sessions/<session>/snapshots/` until pruning
  rotates it out after `HERDR_RESURRECT_KEEP` newer saves, and the refusal names its
  path. No guard can detect a program you deliberately quit in a pane that still
  exists: it looks the same as one lost to the shutdown, so it gets relaunched (the
  tmux-resurrect contract; bounded by the allowlist).
- **Rehydrate never rebuilds missing structure.** Missing panes, tabs, and
  workspaces are skipped and logged; herdr's native restore owns the layout. Use the
  manual restore's `auto`/`--recreate` modes for from-scratch crash recovery.
- **Command capture** no longer relies on herdr's `pane process-info` alone (which
  on Windows only surfaces the console's foreground process-group leader). When
  process-info reports just the shell, the plugin walks the pane shell's **process
  tree** — one bulk query per snapshot (CIM on Windows, `ps` on Linux/macOS) — and
  captures the oldest real child — so `node server.js`, `npm run dev`, `ping -t`
  etc. are captured on Windows too, and the idle check is hardened everywhere. The
  program's own cwd isn't knowable this way (the pane's cwd is used), and the
  cmdline is the OS-recorded one (a leading quoted absolute path is rewritten to
  the program's short name at restore time so PowerShell executes it).
- **Agent conversation resume** is best-effort but has two layers: the native
  `agent_session` ref when herdr reported one, else the session id is recovered
  from the **agent CLI's own session store** keyed by the pane's cwd (claude:
  `~/.claude/projects/`, codex: `~/.codex/sessions/`, copilot:
  `~/.copilot/session-state/`, cursor: `~/.cursor/chats/`). Resume/continue flags
  are known for claude, codex, gemini, copilot, cursor; unknown agents relaunch
  fresh (herdr's own `resume_agents_on_restore` may still rejoin the conversation).
- **Layout geometry** is reconstructed from saved rects via sequential splits; simple
  rows/columns come back faithfully, deeply nested grids are approximated.
- **Complex shell one-liners:** commands with unbalanced-looking brackets/quotes can
  be mangled by PowerShell's PSReadLine when relaunched. Typical agent and dev-server
  commands are unaffected.

## Layout

```
herdr-plugin.toml        manifest: actions, autosave pane, startup hook, event hooks
bin/save.js              snapshot now (manual action + autosave pane)
bin/on-startup.js        [[startup]] hook: opt-in auto-restore after native restore
bin/on-event.js          event handler: debounced autosave
bin/restore.js           rehydrate / recreate from a snapshot
bin/list.js              list saved snapshots
bin/autosave.js          continuum-style timer loop (runs in a pane)
lib/herdr.js             thin wrapper over the herdr CLI (JSON in/out, retry)
lib/snapshot.js          build + persist the enriched snapshot model
lib/restore.js           the planner + executor
lib/gate.js              self-healing autosave suppression during startup restore
lib/allowlist.js         which programs are safe to relaunch
lib/agents.js            agent resume/continue command construction
lib/agent-sessions.js    recover session ids from the agent CLIs' own stores
lib/pstree.js            process-tree capture (CIM on Windows, ps on Unix)
lib/settings.js          settings.json (autoRestore, minAgreement, agentResume, notify, …)
lib/notify.js            herdr toasts for save / autosave / restore results
lib/paths.js             state/config locations (snapshots scoped per herdr session)
config/allowlist.default.txt   seed allowlist
test/                    plain-Node tests (npm test; no live server needed)
```

## License

MIT — this plugin is a standalone process that talks to herdr over its CLI/socket, so
it is not a derivative of herdr's AGPL-licensed core.
