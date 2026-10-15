#!/usr/bin/env node
// Conductor dashboard: localhost-only, no dependencies. Nothing it reads leaves this machine.
//  • Claude usage: incremental index over ~/.claude/projects/**/*.jsonl (lib/usage.js), priced at
//    Anthropic API list rates (lib/pricing.js) — an API-equivalent figure, not a subscription bill.
//  • Workers / tasks: ~/.claude/conductor/runs.jsonl, appended by `delegate` and `gen-image`.
//  • Settings: ~/.config/conductor/{conductor.env, local.env, pricing.json} (lib/config.js).
//  • Office: starts/stops Pixel Agents through `conductor-panel office …` and embeds it.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { PRICING_DEFAULT, loadPricing } = require('./lib/pricing');
const { UsageIndex } = require('./lib/usage');
const cfg = require('./lib/config');
const local = require('./lib/local');

const HOME = os.homedir();
const STATE = process.env.CONDUCTOR_HOME || path.join(HOME, '.claude', 'conductor');
const PROJECTS = process.env.CONDUCTOR_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const CONF = process.env.CONDUCTOR_CONFIG_DIR || path.join(HOME, '.config', 'conductor');
const CONF_ENV = path.join(CONF, 'conductor.env');
const LOCAL_ENV = process.env.CONDUCTOR_LOCAL_ENV || path.join(CONF, 'local.env');
const PRICING_FILE = path.join(CONF, 'pricing.json');
const RUNS = path.join(STATE, 'runs.jsonl');
const USAGE_TSV = path.join(STATE, 'usage.tsv');
const LOGS = path.join(STATE, 'logs');
const ROOT = path.resolve(__dirname, '..');
const PANEL_BIN = path.join(ROOT, 'bin', 'conductor-panel');
const PORT = Number(process.env.CONDUCTOR_PANEL_PORT || 4747);
const OFFICE_PORT = Number(process.env.CONDUCTOR_OFFICE_PORT || 4748);
const HOST = '127.0.0.1';
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return '?'; } })();
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/i18n.js': 'i18n.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(CONF, { recursive: true });

const usage = new UsageIndex({ projectsDir: PROJECTS, indexFile: path.join(STATE, 'usage-index.json'), home: HOME });

// ───────────── helpers ─────────────
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin')].join(path.delimiter);
function sh(cmd, args, timeout = 4000) {
  return new Promise(res => execFile(cmd, args, { timeout, env: { ...process.env, PATH: `${process.env.PATH || ''}${path.delimiter}${EXTRA_PATH}` } },
    (err, stdout, stderr) => res({ ok: !err, out: String(stdout || '') + String(stderr || '') })));
}
async function which(cmd) { const r = await sh('/bin/sh', ['-c', `command -v ${cmd}`]); return r.ok ? r.out.trim().split('\n')[0] : null; }

// ───────────── runs / workers ─────────────
function readRuns() {
  const runs = [];
  try {
    for (const line of fs.readFileSync(RUNS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.worker && r.t) runs.push(r); } catch {}
    }
  } catch {}
  // runs recorded before runs.jsonl existed (usage.tsv has no task text)
  const firstT = runs.length ? Math.min(...runs.map(r => r.t)) : Infinity;
  try {
    for (const line of fs.readFileSync(USAGE_TSV, 'utf8').split('\n')) {
      const [ts, worker, model, write, secs, rc] = line.split('\t');
      if (!ts || !worker) continue;
      const t = new Date(ts.replace('_', 'T')).getTime() / 1000;
      if (!(t < firstT - 1)) continue;
      runs.push({ id: `legacy-${ts}-${worker}`, t, worker, model, write: +write, secs: +secs, rc: +rc, legacy: true, task: '', report: '' });
    }
  } catch {}
  return runs.sort((a, b) => b.t - a.t);
}

const WORKERS = {
  gemini: { cli: 'agy', via: 'Antigravity CLI (agy)', install: 'https://antigravity.google' },
  cursor: { cli: 'cursor-agent', via: 'Cursor Agent CLI', install: 'curl https://cursor.com/install -fsS | bash' },
  copilot: { cli: 'copilot', via: 'GitHub Copilot CLI', install: 'npm install -g @github/copilot' },
  local: { cli: null, via: 'OpenAI-compatible HTTP endpoint', install: null },
};
let workerCache = { at: 0, data: null };
async function workerInfo(force) {
  if (!force && workerCache.data && Date.now() - workerCache.at < 5 * 60000) return workerCache.data;
  const out = {};
  await Promise.all(Object.entries(WORKERS).map(async ([id, w]) => {
    if (!w.cli) {
      const l = cfg.readEnv(LOCAL_ENV);
      out[id] = { ...w, available: !!l.LOCAL_URL, model: l.LOCAL_MODEL || '', url: l.LOCAL_URL || '' };
      return;
    }
    const p = await which(w.cli);
    let version = null;
    if (p) {
      const v = await sh(w.cli, ['--version'], 6000);
      const line = v.out.split('\n').map(s => s.trim()).find(s => /\d+\.\d+/.test(s));
      version = line ? line.slice(0, 60) : null;
    }
    out[id] = { ...w, available: !!p, path: p, version };
  }));
  workerCache = { at: Date.now(), data: out };
  return out;
}

let modelsCache = { at: 0, data: null };
async function modelLists() {
  if (modelsCache.data && Date.now() - modelsCache.at < 60 * 60000) return modelsCache.data;
  const parse = (txt, re) => [...new Set(txt.split('\n').map(l => (l.match(re) || [])[1]).filter(Boolean))];
  const [g, c] = await Promise.all([sh('agy', ['models'], 15000), sh('cursor-agent', ['--list-models'], 15000)]);
  const data = {
    gemini: g.ok ? parse(g.out, /^([a-z0-9][\w.-]+)\s/i) : [],
    cursor: c.ok ? parse(c.out, /^([a-z0-9][\w.-]+)\s+-\s/i) : [],
    copilot: ['auto'],
  };
  modelsCache = { at: Date.now(), data };
  return data;
}

// ───────────── setup checklist (what a new install is missing) ─────────────
async function setupStatus() {
  const w = await workerInfo();
  const [py, curl, pa] = await Promise.all([which('python3'), which('curl'), which('pixel-agents')]);
  let hooks = false;
  try { hooks = fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8').includes('pixel-agents'); } catch {}
  const items = [
    { id: 'python3', ok: !!py, required: true },
    { id: 'curl', ok: !!curl, required: true },
    { id: 'transcripts', ok: fs.existsSync(PROJECTS), required: true },
    { id: 'worker_any', ok: Object.values(w).some(x => x.available), required: true },
    { id: 'gemini', ok: w.gemini.available, hint: w.gemini.install },
    { id: 'cursor', ok: w.cursor.available, hint: w.cursor.install },
    { id: 'copilot', ok: w.copilot.available, hint: w.copilot.install },
    { id: 'local', ok: w.local.available },
    { id: 'pixel_agents', ok: !!pa, hint: 'npm install -g pixel-agents' },
    { id: 'pixel_hooks', ok: hooks },
  ];
  return { items, complete: items.filter(i => i.required).every(i => i.ok) };
}

// ───────────── settings ─────────────
function getSettings() {
  const c = cfg.readEnv(CONF_ENV);
  let over = {};
  try { over = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')) || {}; } catch {}
  return {
    conductor: Object.fromEntries(Object.keys(cfg.CONDUCTOR_KEYS).map(k => [k, c[k] ?? ''])),
    local: cfg.publicLocal(LOCAL_ENV),
    pricing: { defaults: PRICING_DEFAULT, overrides: over },
    paths: { state: STATE, config: CONF, projects: PROJECTS, plugin: ROOT },
    version: VERSION,
  };
}
function saveSettings(body) {
  let errors = [];
  if (body.conductor) errors = errors.concat(cfg.applyConductor(CONF_ENV, body.conductor));
  if (body.local && !errors.length) { errors = errors.concat(cfg.applyLocal(LOCAL_ENV, body.local)); workerCache.at = 0; }
  if (body.pricing && !errors.length) errors = errors.concat(cfg.applyPricing(PRICING_FILE, body.pricing));
  return errors;
}

// ───────────── office (Pixel Agents) ─────────────
async function officeStatus() {
  let running = false;
  try { running = (await fetch(`http://127.0.0.1:${OFFICE_PORT}/api/health`, { signal: AbortSignal.timeout(800) })).ok; } catch {}
  let token = null;
  try { const s = JSON.parse(fs.readFileSync(path.join(HOME, '.pixel-agents', 'server.json'), 'utf8')); if (s.port === OFFICE_PORT) token = s.token; } catch {}
  let hooks = false;
  try { hooks = fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8').includes('pixel-agents'); } catch {}
  return {
    running, installed: !!(await which('pixel-agents')), port: OFFICE_PORT, url: `http://127.0.0.1:${OFFICE_PORT}/`,
    approveUrl: token ? `http://127.0.0.1:${OFFICE_PORT}/?token=${token}` : null, hooksInstalled: hooks,
  };
}

// ───────────── http ─────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 256 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding guard: only requests addressed to this machine by name.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST') {
      // CSRF guard: same-origin fetch with a custom header (cross-site requests can't add it without CORS).
      const origin = req.headers.origin;
      if (req.headers['x-conductor'] !== '1' || (origin && origin !== `http://${host}`)) return json(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      if (p === '/api/settings') { const errors = saveSettings(body); return json(res, errors.length ? 400 : 200, { ok: !errors.length, errors, settings: getSettings() }); }
      if (p === '/api/local/test') return json(res, 200, await local.listModels(LOCAL_ENV));
      if (p === '/api/office/start' || p === '/api/office/stop') {
        const r = await sh(PANEL_BIN, ['office', p.endsWith('start') ? 'start' : 'stop'], 30000);
        return json(res, 200, { ...(await officeStatus()), output: r.out.trim() });
      }
      if (p === '/api/rescan') { usage.scan(); workerCache.at = 0; modelsCache.at = 0; return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (STATIC[p]) {
      const file = path.join(__dirname, STATIC[p]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/health') return json(res, 200, { ok: true, pid: process.pid, version: VERSION });
    if (p === '/api/usage') {
      if (Date.now() - usage.progress.lastScan > 30000) usage.scan();
      const days = Math.max(0, Math.min(3650, Number(url.searchParams.get('days') ?? 30) || 0));
      return json(res, 200, usage.report(days, url.searchParams.get('project') || '', loadPricing(PRICING_FILE)));
    }
    if (p === '/api/runs') {
      const runs = readRuns();
      return json(res, 200, { runs: runs.slice(0, Math.min(20000, Number(url.searchParams.get('limit') || 2000))), total: runs.length });
    }
    if (p === '/api/workers') return json(res, 200, { workers: await workerInfo() });
    if (p === '/api/models') return json(res, 200, await modelLists());
    if (p === '/api/local/models') return json(res, 200, await local.listModels(LOCAL_ENV));
    if (p === '/api/settings') return json(res, 200, getSettings());
    if (p === '/api/setup') return json(res, 200, await setupStatus());
    if (p === '/api/office') return json(res, 200, await officeStatus());
    if (p === '/api/log') {
      const name = url.searchParams.get('name') || '';
      if (!/^[\w.-]+\.log$/.test(name)) return json(res, 400, { error: 'bad name' });
      const file = path.join(LOGS, name);
      if (path.dirname(file) !== LOGS || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const st = fs.statSync(file), max = 400 * 1024, len = Math.min(st.size, max);
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end((st.size > max ? `[… first ${st.size - max} bytes omitted]\n` : '') + buf.toString('utf8'));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
});
server.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`conductor dashboard: port ${PORT} is in use`); process.exit(98); } throw e; });
server.listen(PORT, HOST, () => {
  console.log(`conductor dashboard ${VERSION}: http://${HOST}:${PORT}`);
  usage.scan();
  workerInfo().catch(() => {});
});
setInterval(() => usage.scan(), 60000).unref();
