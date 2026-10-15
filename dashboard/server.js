#!/usr/bin/env node
// Conductor dashboard: localhost-only, no dependencies. Nothing it reads leaves this machine.
//  • Claude usage: incremental index over ~/.claude/projects/**/*.jsonl (lib/usage.js), priced at
//    Anthropic API list rates (lib/pricing.js) — an API-equivalent figure, not a subscription bill.
//  • Workers: the registry in ../lib (built-in CLIs, custom CLIs, OpenAI-compatible endpoints).
//  • Tasks: ~/.claude/conductor/runs.jsonl, appended by `delegate` and `gen-image`.
//  • Settings: ~/.config/conductor/{conductor.env, workers.json, endpoints.json, pricing.json}.
//  • Hosts: install Conductor into Claude Code / Codex. Office: Pixel Agents via `conductor-panel office`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { PRICING_DEFAULT, loadPricing } = require('./lib/pricing');
const { UsageIndex } = require('./lib/usage');
const cfg = require('./lib/config');
const { listModels } = require('./lib/local');
const S = require('../lib/settings');

const HOME = os.homedir();
const STATE = S.P.state;
const PROJECTS = process.env.CONDUCTOR_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const CONF = S.P.conf;
const PRICING_FILE = path.join(CONF, 'pricing.json');
const USAGE_TSV = path.join(STATE, 'usage.tsv');
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
const ENV = { ...process.env, PATH: `${process.env.PATH || ''}${path.delimiter}${EXTRA_PATH}` };
function sh(cmd, args, timeout = 4000) {
  return new Promise(res => execFile(cmd, args, { timeout, env: ENV, maxBuffer: 4e6 }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout || '') + String(stderr || '') })));
}
function which(cmd) {
  if (!cmd) return null;
  for (const d of ENV.PATH.split(path.delimiter)) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// ───────────── runs ─────────────
function readRuns() {
  const runs = [];
  try {
    for (const line of fs.readFileSync(S.P.runs, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.worker && r.t) runs.push(r); } catch {}
    }
  } catch {}
  const firstT = runs.length ? Math.min(...runs.map(r => r.t)) : Infinity;
  try { // runs recorded before runs.jsonl existed (no task text)
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

// ───────────── workers ─────────────
const versionCache = new Map();
async function cliVersion(cli) {
  const c = versionCache.get(cli);
  if (c && Date.now() - c.at < 10 * 60000) return c.v;
  const r = await sh(cli, ['--version'], 6000);
  const line = r.out.split('\n').map(s => s.trim()).find(s => /\d+\.\d+/.test(s));
  const v = line ? line.slice(0, 60) : null;
  versionCache.set(cli, { at: Date.now(), v });
  return v;
}
async function workerInfo() {
  const eps = S.endpoints();
  const out = [];
  for (const w of S.allWorkers()) {
    const kind = w.endpoint ? 'endpoint' : w.custom ? 'custom' : 'builtin';
    const p = w.endpoint ? null : which(w.cli);
    const info = {
      id: w.id, label: w.label, kind, enabled: w.enabled, model: w.model, defaultModel: w.defaultModel || '', goodAt: w.goodAt,
      via: w.via, install: w.install || '', host: w.host || null, notes: w.notes || '', listsModels: !!(w.listModels || w.endpoint),
      available: w.endpoint ? !!w.url : !!p, path: p, version: p ? await cliVersion(w.cli) : null,
    };
    if (w.endpoint) {
      const e = eps.find(x => x.id === w.id) || {};
      Object.assign(info, { url: e.url, has_apiKey: !!e.apiKey, has_cfId: !!e.cfId, has_cfSecret: !!e.cfSecret });
    }
    out.push(info);
  }
  return out;
}
const modelsCache = new Map();
async function workerModels(id) {
  const w = S.findWorker(id);
  if (!w) return { ok: false, code: 'unknown', models: [] };
  if (w.endpoint) return listModels(S.endpoints().find(e => e.id === w.id));
  const c = modelsCache.get(id);
  if (c && Date.now() - c.at < 30 * 60000) return c.data;
  let data = { ok: true, models: w.model ? [w.model] : [] };
  if (w.listModels && which(w.cli)) {
    const r = await sh(w.cli, w.listModels.args, 20000);
    const ids = [...new Set(r.out.split('\n').map(l => (l.match(w.listModels.re) || [])[1]).filter(Boolean))];
    data = { ok: r.ok, models: ids, code: r.ok ? 'ok' : 'http_error', message: r.ok ? '' : r.out.slice(0, 160) };
  }
  modelsCache.set(id, { at: Date.now(), data });
  return data;
}

// ───────────── hosts (orchestrators) ─────────────
async function hostStatus() {
  const claudeCli = which('claude'), codexCli = which('codex');
  let claudePlugin = false, codexPlugin = false;
  try { claudePlugin = /conductor@/.test(fs.readFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')); } catch {}
  if (!claudePlugin) { try { claudePlugin = /"conductor@[^"]+":\s*true/.test(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')); } catch {} }
  try { codexPlugin = /plugins\."conductor@/.test(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'), 'utf8')); } catch {}
  const env = S.general();
  return {
    orchestrator: env.CONDUCTOR_ORCHESTRATOR || 'auto',
    hosts: [
      { id: 'claude', name: 'Claude Code', cli: !!claudeCli, installed: claudePlugin, worker: 'claude' },
      { id: 'codex', name: 'Codex', cli: !!codexCli, installed: codexPlugin, worker: 'codex' },
    ],
    root: ROOT,
  };
}
async function installHost(host) {
  if (host === 'claude') {
    const a = await sh('claude', ['plugin', 'marketplace', 'add', ROOT], 60000);
    const b = await sh('claude', ['plugin', 'install', 'conductor@conductor'], 60000);
    return { ok: b.ok, output: (a.out + b.out).trim().slice(-800) };
  }
  if (host === 'codex') {
    const a = await sh('codex', ['plugin', 'marketplace', 'add', ROOT], 60000);
    const b = await sh('codex', ['plugin', 'add', 'conductor@conductor'], 60000);
    return { ok: b.ok, output: (a.out + b.out).trim().slice(-800) };
  }
  return { ok: false, output: 'unknown host' };
}

// ───────────── setup checklist ─────────────
async function setupStatus() {
  const ws = await workerInfo();
  let hooks = false;
  try { hooks = fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8').includes('pixel-agents'); } catch {}
  const items = [
    { id: 'python3', ok: !!which('python3'), required: true },
    { id: 'curl', ok: !!which('curl'), required: true },
    { id: 'transcripts', ok: fs.existsSync(PROJECTS), required: true },
    { id: 'worker_any', ok: ws.some(w => w.enabled && w.available), required: true },
    { id: 'endpoint_any', ok: ws.some(w => w.kind === 'endpoint') },
    { id: 'pixel_agents', ok: !!which('pixel-agents'), hint: 'npm install -g pixel-agents' },
    { id: 'pixel_hooks', ok: hooks },
  ];
  return { items, complete: items.filter(i => i.required).every(i => i.ok) };
}

// ───────────── settings ─────────────
function getSettings() {
  const c = cfg.readEnv(S.P.env);
  let over = {};
  try { over = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')) || {}; } catch {}
  return {
    conductor: Object.fromEntries(Object.keys(cfg.CONDUCTOR_KEYS).map(k => [k, c[k] ?? ''])),
    pricing: { defaults: PRICING_DEFAULT, overrides: over },
    paths: { state: STATE, config: CONF, projects: PROJECTS, plugin: ROOT },
    version: VERSION,
  };
}
function saveSettings(body) {
  let errors = [];
  if (body.conductor) errors = errors.concat(cfg.applyConductor(S.P.env, body.conductor));
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
    running, installed: !!which('pixel-agents'), port: OFFICE_PORT, url: `http://127.0.0.1:${OFFICE_PORT}/`,
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

const POST = {
  '/api/settings': async b => { const errors = saveSettings(b); return [errors.length ? 400 : 200, { ok: !errors.length, errors, settings: getSettings() }]; },
  '/api/workers/save': async b => {
    if (!S.findWorker(b.id)) return [400, { ok: false, errors: [{ field: 'id', code: 'unknown_field' }] }];
    const errors = S.saveWorker(S.findWorker(b.id).id, { enabled: b.enabled, model: b.model, goodAt: b.goodAt });
    return [errors.length ? 400 : 200, { ok: !errors.length, errors }];
  },
  '/api/endpoints/save': async b => { const errors = S.saveEndpoint(b); return [errors.length ? 400 : 200, { ok: !errors.length, errors }]; },
  '/api/endpoints/delete': async b => { S.deleteEndpoint(String(b.id || '')); return [200, { ok: true }]; },
  '/api/endpoints/test': async b => [200, await listModels(S.endpoints().find(e => e.id === b.id))],
  '/api/hosts/install': async b => [200, await installHost(String(b.host || ''))],
  '/api/office/start': async () => { const r = await sh(PANEL_BIN, ['office', 'start'], 30000); return [200, { ...(await officeStatus()), output: r.out.trim() }]; },
  '/api/office/stop': async () => { const r = await sh(PANEL_BIN, ['office', 'stop'], 30000); return [200, { ...(await officeStatus()), output: r.out.trim() }]; },
  '/api/rescan': async () => { usage.scan(); versionCache.clear(); modelsCache.clear(); return [200, { ok: true }]; },
};

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
      if (!POST[p]) return json(res, 404, { error: 'not found' });
      const [code, body] = await POST[p](await readBody(req));
      return json(res, code, body);
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
    if (p === '/api/workers/models') return json(res, 200, await workerModels(url.searchParams.get('id') || ''));
    if (p === '/api/hosts') return json(res, 200, await hostStatus());
    if (p === '/api/settings') return json(res, 200, getSettings());
    if (p === '/api/setup') return json(res, 200, await setupStatus());
    if (p === '/api/office') return json(res, 200, await officeStatus());
    if (p === '/api/log') {
      const name = url.searchParams.get('name') || '';
      if (!/^[\w.-]+\.log$/.test(name)) return json(res, 400, { error: 'bad name' });
      const file = path.join(S.P.logs, name);
      if (path.dirname(file) !== S.P.logs || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
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
