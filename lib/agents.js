'use strict';
// Build an agent's own resume/continue command so a relaunched agent pane rejoins its
// previous conversation instead of starting fresh. Best-effort and per-agent: when we
// don't know how (or there's no session ref), the caller falls back to a plain launch,
// and herdr's native resume_agents_on_restore may still take over.
const settings = require('./settings');

// name -> { resume: template using {value}, continue: flags }.
// `resume` is used when a native session ref value is present; `continue` otherwise.
const KNOWN = {
  claude: { resume: '--resume {value}', continue: '--continue' },
  codex: { resume: 'resume {value}', continue: 'resume --last' },
  gemini: { resume: '--resume {value}', continue: '' },
};

function quote(s) {
  return /[\s"']/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s;
}

// The command word to relaunch an agent by: its short name (e.g. `claude`), not the
// captured absolute path. Short names are on PATH and run in both PowerShell and
// POSIX shells; a quoted absolute path like "C:\...\claude.exe" is treated as a mere
// string by PowerShell and never executes. herdr re-detects the agent either way.
function shortName(agent) {
  if (!agent) return null;
  const raw = agent.name || (agent.argv && agent.argv[0]);
  if (!raw) return null;
  let b = String(raw).split(/[\\/]/).pop().toLowerCase();
  if (b.endsWith('.exe')) b = b.slice(0, -4);
  return b || null;
}

// agent = { name, argv, cmdline, session: {source,agent,kind,value}|null }
function resumeCommand(agent) {
  const cfg = settings.load();
  if (!cfg.agentResume || !agent) return null;

  const name = String(agent.name || '').toLowerCase();
  const spec = { ...(KNOWN[name] || {}), ...(cfg.agentResumeCommands[name] || {}) };
  const bin = shortName(agent);
  if (!bin) return null;

  const value = agent.session && agent.session.value;
  let tail = null;
  if (value != null && spec.resume) tail = spec.resume.replace('{value}', quote(String(value)));
  else if (spec.continue != null) tail = spec.continue; // '' is valid (bare relaunch continues)
  if (tail == null) return null;

  return `${quote(bin)}${tail ? ' ' + tail : ''}`.trim();
}

module.exports = { resumeCommand, shortName, KNOWN };
