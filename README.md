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
**herdr ≥ 0.7.0**.

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
```

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

Restore is **idempotent**: it only fills panes that are currently idle shells, so
running it twice does nothing the second time.

### Auto-restore on startup (opt-in)

Set `autoRestore: true` in `settings.json` (see Configuration) to skip step 2 — the
plugin then rehydrates automatically the first time herdr fires an event after a
server (re)start, so a crash + relaunch brings your commands and agents back on its
own.

How it works: herdr has no "server ready" plugin event yet, so the plugin detects a
fresh boot from herdr's socket file (rewritten on every start) and lets the **first**
event handler claim that boot, rehydrate once, and stand the others down — reading the
good pre-crash snapshot *before* autosave can overwrite it. It's off by default so it
never surprises you (tmux-continuum's auto-restore is opt-in too). A first-class
`server.ready` event would be cleaner — see **Upstream** below.

### Agent resume

When relaunching an agent pane, the plugin uses the agent CLI's own resume/continue
flags where known — e.g. `claude --resume <id>` when herdr captured a native session
ref, else `claude --continue`; `codex resume`. Unknown agents relaunch fresh (and
herdr's own `resume_agents_on_restore` may still rejoin the session). Agents are
relaunched by short name (`claude`) so they run in both PowerShell and POSIX shells.
Override per agent via `agentResumeCommands` in `settings.json`.

## How restore decides (modes)

| Mode | Flag | Behavior |
| --- | --- | --- |
| auto *(default)* | — | rehydrate workspaces that already exist; recreate the rest |
| rehydrate | `--rehydrate` | only fill existing panes; never create workspaces |
| recreate | `--recreate` | always build everything from scratch |
| dry run | `--dry-run` | print the plan, touch nothing |
| pick file | `--file <path>` | restore a specific snapshot instead of the newest |

(CLI form, e.g. `node bin/restore.js --recreate --dry-run`, when running scripts directly.)

## Configuration

**Settings** — `$HERDR_PLUGIN_CONFIG_DIR/settings.json`, seeded on first run:

| Key | Default | Meaning |
| --- | --- | --- |
| `autoRestore` | `false` | rehydrate automatically on the first event after a server (re)start |
| `autoRestoreSettleMs` | `2500` | wait this long after the first boot event before rehydrating |
| `agentResume` | `true` | use agent CLI resume/continue flags when relaunching agents |
| `agentResumeCommands` | `{}` | per-agent overrides, e.g. `{ "claude": { "continue": "--continue" } }` |

`HERDR_RESURRECT_AUTO_RESTORE=1` overrides `autoRestore` without editing the file.

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

Snapshots live under `$HERDR_PLUGIN_STATE_DIR/snapshots/`, with the newest also at
`.../last.json`.

## Limitations (honest)

- **Windows command capture** no longer relies on herdr's `pane process-info` alone
  (which only surfaces the console's foreground process-group leader). When
  process-info reports just the shell, the plugin walks the pane shell's **process
  tree** (one bulk CIM query per snapshot) and captures the oldest real child — so
  `node server.js`, `npm run dev`, `ping -t` etc. are captured on Windows too. The
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
herdr-plugin.toml        manifest: actions, autosave pane, event hooks
bin/save.js              snapshot now (manual action + autosave pane)
bin/on-event.js          event handler: debounced autosave + opt-in boot auto-restore
bin/restore.js           rehydrate / recreate from a snapshot
bin/list.js              list saved snapshots
bin/autosave.js          continuum-style timer loop (runs in a pane)
lib/herdr.js             thin wrapper over the herdr CLI (JSON in/out, retry)
lib/snapshot.js          build + persist the enriched snapshot model
lib/restore.js           the planner + executor
lib/allowlist.js         which programs are safe to relaunch
lib/agents.js            agent resume/continue command construction
lib/agent-sessions.js    recover session ids from the agent CLIs' own stores
lib/pstree.js            Windows process-tree capture (CIM) for pane commands
lib/settings.js          settings.json (autoRestore, agentResume, …)
lib/boot.js              per-boot detection + claim-once coordination
lib/paths.js             state/config locations
config/allowlist.default.txt   seed allowlist
```

## Upstream: a `server.ready` event for herdr

Auto-restore currently piggybacks on the first `pane.created`/`workspace.created`
after a restart, guarded by a socket-derived boot token. A first-class **`server.ready`**
plugin event (fired once, after the server restores the session) would be a cleaner,
race-free trigger. That's a new-API change, and herdr's `CONTRIBUTING.md` asks for a
**GitHub Discussion first** (not a cold PR) for new features — so this is proposed
there rather than pushed as a surprise PR. The implementation is small and localized
(emit once at the top of `HeadlessServer::run`, add the kind to `PLUGIN_HOOK_EVENT_KINDS`).

## License

MIT — this plugin is a standalone process that talks to herdr over its CLI/socket, so
it is not a derivative of herdr's AGPL-licensed core.
