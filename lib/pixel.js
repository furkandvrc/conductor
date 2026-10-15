'use strict';
// Show workers as characters in Pixel Agents (github.com/pixel-agents-hq/pixel-agents).
// Each worker is one persistent hooks-only session "conductor-<Label>" whose cwd is
// ~/.claude/conductor/agents/<Label>, so the character is named after the worker.
// Every call is best-effort: the office is decoration and must never fail a delegate run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { P, safeLabel } = require('./settings');

function servers() {
  const dir = path.join(os.homedir(), '.pixel-agents');
  const files = [path.join(dir, 'server.json')];
  try { for (const f of fs.readdirSync(path.join(dir, 'servers'))) files.push(path.join(dir, 'servers', f)); } catch {}
  const seen = new Set(), out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const key = `${d.port}|${d.token}`;
      if (d.port && d.token && !seen.has(key)) { seen.add(key); out.push(d); }
    } catch {}
  }
  return out;
}

async function post(srv, body) {
  try {
    await fetch(`http://127.0.0.1:${srv.port}/api/hooks/claude`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + srv.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(1500),
    });
  } catch {}
}

async function send(label, events, write, detail) {
  if (process.env.CONDUCTOR_PIXEL === '0') return;
  const name = safeLabel(label);
  const cwd = path.join(P.agents, name);
  try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
  const tool = { tool_name: write ? 'Edit' : 'Read', tool_input: { file_path: path.join(cwd, String(detail || 'task').slice(0, 80).replace(/[/\\]/g, '_')) } };
  const srvs = servers();
  if (!srvs.length) return;
  for (const ev of events) {
    if (ev === 'pause') { await new Promise(r => setTimeout(r, 800)); continue; }
    const body = { session_id: 'conductor-' + name, cwd, hook_event_name: ev, ...(ev === 'SessionStart' ? { source: 'startup' } : {}), ...(ev === 'SessionEnd' ? { reason: 'exit' } : {}), ...(/ToolUse$/.test(ev) ? tool : {}) };
    await Promise.all(srvs.map(s => post(s, body)));
  }
}

// SessionStart is idempotent for a live session and recreates the character after a restart;
// the first PreToolUse adopts the session, the second one shows the activity.
const HELLO = ['SessionStart', 'PreToolUse', 'pause'];
const start = (label, write, detail) => send(label, [...HELLO, 'PreToolUse'], write, detail);
const beat = (label, write, detail) => send(label, ['PreToolUse'], write, detail);
const end = (label, write) => send(label, ['PostToolUse', 'Stop'], write);
const idle = label => send(label, [...HELLO, 'PostToolUse', 'Stop'], false);

module.exports = { start, beat, end, idle, servers };

// CLI for shell callers (gen-image): node lib/pixel.js <start|end|idle> <label> [write 0|1] [detail]
if (require.main === module) {
  const [cmd, label, write, detail] = process.argv.slice(2);
  const fn = { start, end, idle, beat }[cmd];
  if (fn && label) fn(label, write === '1', detail).finally(() => process.exit(0)); else process.exit(0);
}
