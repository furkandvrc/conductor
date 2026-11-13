'use strict';
// delegate: hand a bounded task to a worker model and print only its report.
// The orchestrator (Claude Code, Codex, …) runs this through its shell tool. The worker's full
// transcript goes to a log file, so it never enters the orchestrator's context unless asked for.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const S = require('./settings');
const pixel = require('./pixel');

const USAGE = `usage: delegate <worker> [--write] [--model M] [--timeout SEC] [--max-lines N] [--dir D] [--] "<task>"
       some-command | delegate <worker> "<instruction>"     (piped stdin is added as context)
       delegate status            which workers are enabled and usable here
       delegate list [--for HOST] workers + what each is good at (used by the session-start hook)
       delegate models <worker>   models a worker offers
--write      let the worker edit files in --dir (default: read-only); workers never commit or push
--timeout    seconds before the worker is stopped (default 900, or CONDUCTOR_TIMEOUT)
--max-lines  cap on printed report lines (default 30 for brief reports, 60 for full); the full output is always in the log
--model      pick one model; without it a worker with a model pool (dashboard → Workers) spreads runs by its ratios`;

// brief: the engineer pays for every word of the report, so it gets a fixed, short shape
const REPORT_SPEC = {
  brief: `End your reply with a section titled '## REPORT'. It is the only part the engineer reads and every word costs them, so keep it under 120 words in exactly this shape:
STATUS: done | partial | failed
ANSWER: the result itself: findings with file:line, or what you changed; terse bullets are fine
CHANGED: paths you edited, or none
UNSURE: one line, or none
Do the work thoroughly; only the report is short. No preamble, no restating the task.`,
  full: `End your reply with a section titled '## REPORT' (at most 300 words). It is the only part the engineer is sure to see, so put the result itself first: the answer or findings (with file:line references), then files changed (paths), then open questions or anything you are unsure of.`,
};

const CONTRACT = (dir, write, report = 'brief') => `You are a worker agent. A supervising engineer delegated this task to you and will verify your work.
Rules: work only inside ${dir}. ${write ? `You MAY edit files inside ${dir}. Keep changes minimal and on-task.` : 'READ-ONLY: do not create, modify or delete any file.'} Never run git commit/push, never install packages, never read .env files or secrets/ directories.
Be efficient: read only what the task needs.
${REPORT_SPEC[report] || REPORT_SPEC.brief}`;

// ── helpers ──
function which(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
const available = w => (w.endpoint ? !!w.url : !!which(w.cli));

function parseArgs(argv, env = {}) {
  const o = { worker: argv[0], write: false, model: '', timeout: Number(env.CONDUCTOR_TIMEOUT) || 900, maxLines: Number(env.CONDUCTOR_MAX_LINES) || (env.CONDUCTOR_REPORT === 'full' ? 60 : 30), dir: process.cwd(), task: [], forHost: '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--') { o.task.push(...argv.slice(i + 1)); break; }
    else if (a === '--write') o.write = true;
    else if (a === '--model') o.model = val();
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--max-lines') o.maxLines = Number(val());
    else if (a === '--dir') o.dir = path.resolve(val());
    else if (a === '--for') o.forHost = val();
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.task.push(a);
  }
  if (!(o.timeout >= 10)) throw new Error('--timeout must be at least 10 seconds');
  if (!(o.maxLines >= 1)) throw new Error('--max-lines must be positive');
  o.task = o.task.join(' ');
  return o;
}

function readPipedStdin() {
  try {
    const st = fs.fstatSync(0);
    // only a real pipe or file is context; an inherited socket/tty would block forever
    if (st.isFIFO() || st.isFile()) return fs.readFileSync(0, 'utf8');
  } catch {}
  return '';
}

function report(out, maxLines) {
  const lines = out.replace(/\s+$/, '').split('\n');
  if (lines.length <= maxLines) return { text: lines.join('\n'), note: '' };
  let at = -1;
  lines.forEach((l, i) => { if (/^## REPORT/.test(l)) at = i; });
  if (at >= 0 && lines.length - at <= maxLines) return { text: lines.slice(at).join('\n'), note: `output truncated (${lines.length} lines) — showing REPORT; full text in log` };
  // the REPORT leads with the answer, so a REPORT over the cap keeps its head, not the output's tail
  if (at >= 0) return { text: lines.slice(at, at + maxLines).join('\n'), note: `output truncated (${lines.length} lines) — first ${maxLines} lines of REPORT; full text in log` };
  return { text: lines.slice(-maxLines).join('\n'), note: `output truncated (${lines.length} lines) — last ${maxLines} lines; full text in log` };
}
const reportSection = out => { const i = out.lastIndexOf('## REPORT'); return (i >= 0 ? out.slice(i + 9) : out.split('\n').slice(-12).join('\n')).trim(); };

// ── workers ──
async function runEndpoint(w, prompt, model, timeout) {
  const ep = S.endpoints().find(e => e.id === w.id) || {};
  const base = String(ep.url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (ep.apiKey) headers.Authorization = 'Bearer ' + ep.apiKey;
  if (ep.cfId) { headers['CF-Access-Client-Id'] = ep.cfId; headers['CF-Access-Client-Secret'] = ep.cfSecret || ''; }
  let m = model;
  if (!m || m === 'auto') {
    const r = await fetch(base + '/v1/models', { headers, signal: AbortSignal.timeout(10000) });
    const ids = ((await r.json().catch(() => ({}))).data || []).map(x => x.id).filter(Boolean).sort();
    if (!ids.length) throw new Error(`${w.id}: the endpoint lists no models — set a model in the dashboard`);
    m = ids[0];
  }
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers, signal: AbortSignal.timeout(timeout * 1000),
    body: JSON.stringify({ model: m, stream: false, messages: [{ role: 'user', content: prompt }] }),
  });
  const raw = await r.text();
  let d;
  try { d = JSON.parse(raw); } catch {
    throw new Error(`endpoint did not return JSON (HTTP ${r.status}; blocked by a proxy/WAF or wrong URL?): ${raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  }
  if (!r.ok || !d.choices) throw new Error(`HTTP ${r.status}: ${JSON.stringify(d).slice(0, 400)}`);
  return { model: m, out: d.choices[0].message.content || '', err: '' };
}

function runCli(w, spec, timeout) {
  return new Promise(resolve => {
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}), CONDUCTOR_ROLE: 'worker' },
      stdio: [spec.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', killed = false;
    const cap = s => (s.length > 8e6 ? s.slice(-8e6) : s);
    child.stdout.on('data', d => { out = cap(out + d); });
    child.stderr.on('data', d => { err = cap(err + d); });
    if (spec.stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(spec.stdin); }
    const t = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeout * 1000);
    const onSig = () => { child.kill('SIGTERM'); };
    process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
    child.on('error', e => { err += String(e.message); });
    child.on('close', code => {
      clearTimeout(t);
      process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
      if (spec.outFile) { try { out = fs.readFileSync(spec.outFile, 'utf8'); } catch {} }
      resolve({ rc: killed ? 124 : (code ?? 1), out, err: err + (killed ? `\n[delegate] stopped after ${timeout}s` : '') });
    });
  });
}

// ── commands ──
function status() {
  for (const w of S.allWorkers()) {
    const ok = available(w);
    const state = !w.enabled ? 'disabled' : ok ? 'ok' : w.endpoint ? 'endpoint missing url' : `missing — ${w.install || w.cli}`;
    console.log(`${w.id.padEnd(12)} ${state}${ok && w.model ? `  (model ${w.model})` : ''}`);
  }
}

// workers usable by an orchestrator host, excluding the host itself
function usableFor(host) {
  return S.allWorkers().filter(w => w.enabled && available(w) && !(host && w.host === host));
}
function readRuns() {
  const runs = [];
  try { for (const l of fs.readFileSync(S.P.runs, 'utf8').split('\n')) { try { const r = JSON.parse(l); if (r.worker) runs.push(r); } catch {} } } catch {}
  return runs;
}
function lastRuns(runs = readRuns()) {
  const last = {};
  for (const r of runs) last[r.worker] = r;
  return last;
}

// The pool models that are switched on, with their share of the total weight.
const activePool = w => {
  const on = (w.pool || []).filter(p => p.weight > 0), sum = on.reduce((a, p) => a + p.weight, 0);
  return on.map(p => ({ ...p, share: p.weight / sum }));
};
// Deficit pick: the model furthest below its target share over the last 14 days of this worker's
// runs. Deterministic, so a ratio like 60/30/10 holds even over a handful of runs.
function pickModel(w, runs = readRuns(), now = Date.now() / 1000) {
  const pool = activePool(w);
  if (!pool.length) return w.model;
  const count = {};
  let total = 0;
  for (const r of runs) {
    if (r.worker !== w.id || r.t < now - 14 * 86400 || !pool.some(p => p.model === r.model)) continue;
    count[r.model] = (count[r.model] || 0) + 1; total++;
  }
  let best = pool[0], gap = -Infinity;
  for (const p of pool) {
    const g = p.share * (total + 1) - (count[p.model] || 0);
    if (g > gap + 1e-9) { best = p; gap = g; }
  }
  return best.model;
}

function list(host, asJson) {
  const ws = usableFor(host), last = lastRuns();
  if (asJson) { console.log(JSON.stringify(ws.map(w => ({ id: w.id, label: w.label, goodAt: w.goodAt, model: w.model, pool: activePool(w) })))); return; }
  for (const w of ws) {
    const l = last[w.id], pool = activePool(w);
    const warn = l && l.rc !== 0 ? `; WARNING: its last run failed (exit ${l.rc}) — check the log before relying on it` : '';
    const models = pool.length > 1 ? ` (models ${pool.map(p => `${p.model} ${Math.round(p.share * 100)}%`).join(', ')}; spread automatically, or pick one with --model)`
      : pool.length ? ` (model ${pool[0].model})` : w.model ? ` (default model ${w.model})` : '';
    console.log(`- ${w.id}: ${w.goodAt}${models}${w.notes ? `; ${w.notes}` : ''}${warn}`);
  }
}

function models(name) {
  const w = S.findWorker(name);
  if (!w) throw new Error(`unknown worker '${name}'`);
  if (w.listModels && which(w.cli)) {
    const r = spawnSync(w.cli, w.listModels.args, { encoding: 'utf8', timeout: 20000 });
    const out = String(r.stdout || '');
    const ids = w.listModels.parse ? w.listModels.parse(out) : [...new Set(out.split('\n').map(l => (l.match(w.listModels.re) || [])[1]).filter(Boolean))];
    if (ids.length) console.log(ids.join('\n'));
    else { console.error(`${w.cli} listed no models (not signed in, or its service is unreachable?). Its output:\n${(out + String(r.stderr || '')).trim().slice(-600) || '(none)'}`); process.exitCode = 1; }
  } else console.log(w.model || '(this worker does not list models; pass any id with --model)');
}

// Claude Code's usage-limit messages ("You've hit your limit", "... usage limit reached")
const LIMIT_RE = /hit your (?:\w+ )?limit|usage limit reached|rate_limit_error/i;
// After a worker hit its limit: is the Claude account in use now one with room (switching if needed)?
async function claudeAccountFreed() {
  try {
    const ACC = require('./accounts');
    const m = ACC.createManager({ env: { ...S.general(), ...process.env } });
    if ((await m.status()).accounts.length < 2) return false;
    const r = await m.auto({ reason: 'rate_limit' });
    if (r.switched) ACC.notify(`${r.message} A delegated task is running again on it.`);
    const cur = (await m.status()).accounts.find(a => a.active);
    return !!(cur && !cur.blockedUntil);
  } catch { return false; }
}

async function run(argv) {
  const env = S.general();
  const o = parseArgs(argv, { ...env, ...process.env });
  if (process.env.CONDUCTOR_ROLE === 'worker') throw Object.assign(new Error('nested delegation is disabled: you are running as a Conductor worker'), { code: 4 });
  const w = S.findWorker(o.worker);
  if (!w) throw Object.assign(new Error(`unknown worker '${o.worker}' — see: delegate status`), { code: 2 });
  if (!w.enabled) throw Object.assign(new Error(`worker '${w.id}' is disabled (dashboard → Workers)`), { code: 3 });
  if (!available(w)) throw Object.assign(new Error(`worker '${w.id}' is not ${w.endpoint ? 'configured' : `installed — ${w.install || w.cli}`}`), { code: 3 });
  const piped = readPipedStdin();
  if (!o.task && !piped) throw Object.assign(new Error('empty task'), { code: 2 });
  if (!fs.existsSync(o.dir)) throw Object.assign(new Error(`no such directory ${o.dir}`), { code: 2 });

  fs.mkdirSync(S.P.logs, { recursive: true });
  const n = new Date(), p2 = x => String(x).padStart(2, '0');
  const ts = `${n.getFullYear()}${p2(n.getMonth() + 1)}${p2(n.getDate())}-${p2(n.getHours())}${p2(n.getMinutes())}${p2(n.getSeconds())}`; // local time
  const id = `${ts}-${w.id}-${process.pid}`;
  const log = path.join(S.P.logs, `${id}.log`);
  const model = o.model || pickModel(w);
  const prompt = `${CONTRACT(o.dir, o.write && !w.endpoint, S.delegation().report)}\n\n## TASK\n${o.task}${piped ? `\n\n## CONTEXT (from stdin)\n${piped}` : ''}`;
  const t0 = Date.now();

  // in-flight marker for the dashboard: gone on any exit; a SIGKILLed run is swept by its dead pid
  const marker = path.join(S.P.running, `${id}.json`);
  try {
    fs.mkdirSync(S.P.running, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ id, t: t0 / 1000, pid: process.pid, worker: w.id, model: model || '', write: o.write ? 1 : 0, dir: o.dir, project: path.basename(o.dir), task: o.task.slice(0, 1500) }));
    process.on('exit', () => { try { fs.unlinkSync(marker); } catch {} });
  } catch {}

  pixel.start(w.label, o.write, o.task).catch(() => {});
  const hb = setInterval(() => pixel.beat(w.label, o.write, o.task).catch(() => {}), 15000);
  let res, usedModel = model;
  try {
    if (w.endpoint) {
      if (o.write) process.stderr.write(`delegate: ${w.id} is text-only; --write ignored\n`);
      try { const r = await runEndpoint(w, prompt, model, o.timeout); res = { rc: 0, out: r.out, err: '' }; usedModel = r.model; }
      catch (e) { res = { rc: 1, out: '', err: String(e.message || e) }; }
    } else {
      const outFile = path.join(S.P.logs, `${id}.last`);
      const spec = w.build({ prompt, model, write: o.write, dir: o.dir, timeout: o.timeout, outFile });
      res = await runCli(w, { ...spec, cwd: o.dir }, o.timeout);
      try { fs.unlinkSync(outFile); } catch {}
      // A Claude worker stopped by a usage limit: let account rotation switch, then run it once more
      // on the account that has room (a new process reads the new sign-in).
      if (res.rc && w.cli === 'claude' && LIMIT_RE.test(res.out + res.err) && await claudeAccountFreed()) {
        process.stderr.write('delegate: the Claude worker hit a usage limit; the account was switched, running it again\n');
        const note = '## NOTE\nA previous run of this task stopped on a usage limit. Files may already hold part of its work: check the current state first and carry on from there instead of redoing it.\n\n';
        const again = w.build({ prompt: note + prompt, model, write: o.write, dir: o.dir, timeout: o.timeout, outFile });
        const r2 = await runCli(w, { ...again, cwd: o.dir }, o.timeout);
        try { fs.unlinkSync(outFile); } catch {}
        res = { ...r2, err: `[delegate] first run stopped on a usage limit; retried after an account switch\n${res.err}\n${r2.err}` };
      }
    }
  } finally { clearInterval(hb); }

  const secs = Math.round((Date.now() - t0) / 1000);
  // a worker that exits 0 but says nothing failed (e.g. a tool was auto-denied in headless mode)
  if (res.rc === 0 && !res.out.trim()) res.rc = 5;
  fs.writeFileSync(log, `${res.out}\n----- stderr -----\n${res.err}`);
  const rep = reportSection(res.out) + (res.rc ? `\n${res.err.trim().split('\n').slice(-4).join('\n')}` : '');
  await pixel.end(w.label, o.write).catch(() => {});
  fs.appendFileSync(S.P.runs, JSON.stringify({
    id, t: Date.now() / 1000, worker: w.id, model: usedModel || '', write: o.write ? 1 : 0, secs, rc: res.rc, dir: o.dir,
    project: path.basename(o.dir), log, out_bytes: Buffer.byteLength(res.out), task: o.task.slice(0, 1500), report: rep.slice(0, 1500),
  }) + '\n');

  console.log(`[delegate] worker=${w.id} model=${usedModel || '-'} write=${o.write ? 1 : 0} exit=${res.rc} ${secs}s log=${log}`);
  const r = report(res.out, o.maxLines);
  if (r.note) console.log(`[delegate] ${r.note}`);
  if (r.text) console.log(r.text);
  if (res.rc) { console.log('[delegate] worker failed — stderr tail:'); console.log(res.err.trim().split('\n').slice(-15).join('\n')); }
  if (o.write && !w.endpoint) {
    const g = spawnSync('git', ['-C', o.dir, 'status', '--short'], { encoding: 'utf8' });
    if (g.status === 0) { console.log('[delegate] git status after worker:'); console.log(g.stdout.split('\n').slice(0, 40).join('\n')); }
  }
  return res.rc;
}

async function main(argv) {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(USAGE); return 0; }
    if (cmd === 'status' || cmd === 'workers') { status(); return 0; }
    if (cmd === 'list') { const o = parseArgs(argv, {}); list(o.forHost, argv.includes('--json')); return 0; }
    if (cmd === 'labels') { console.log(S.allWorkers().map(w => S.safeLabel(w.label)).join(',')); return 0; }
    if (cmd === 'roster') { await Promise.all(usableFor('').map(w => pixel.idle(w.label))); return 0; }
    if (cmd === 'models') { models(argv[1]); return 0; }
    return await run(argv);
  } catch (e) {
    process.stderr.write(`delegate: ${e.message || e}\n`);
    return e.code && Number.isInteger(e.code) ? e.code : 2;
  }
}

module.exports = { main, parseArgs, report, reportSection, usableFor, available, activePool, pickModel, CONTRACT };
if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code));
