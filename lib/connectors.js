'use strict';
// Account bridge: an MCP server (stdio) that keeps the claude.ai connectors and the Claude in
// Chrome browser of every saved Claude account usable, whichever account Claude Code is signed
// in with at the moment.
//
// Why: claude.ai connectors (Figma, Notion, Meetings, ...) are installed per claude.ai account,
// and the Chrome extension pairs with the account it is signed in to. When conductor rotates
// Claude Code to another account, or the connector was only ever added on the other account,
// those tools disappear from the session. They do not need that account's model quota, though:
//   - a connector is reached through Anthropic's MCP proxy (mcp-proxy.anthropic.com/v1/mcp/<id>)
//     with the owning account's OAuth token, exactly as Claude Code does it itself;
//   - the browser is reached by running Claude Code's own Chrome MCP server
//     (`claude --claude-in-chrome-mcp`) with the owning account's token.
// Neither sends a model request, so an account that is at its usage limit still serves its
// connectors and its browser.
//
// What is exposed: for every saved account other than the active one, its connectors that the
// active account does not have itself (same name and URL), and, when that account has a browser
// connected, its browser tools. The active account's own connectors and browser are left to
// Claude Code. Tool names: <account>_<connector>__<tool> and <account>_chrome__<tool>. When the
// active account changes, the list changes and Claude Code is told (tools/list_changed).
//
// Off switches (~/.config/conductor/conductor.env): CONDUCTOR_ACCOUNT_CONNECTORS=0 (the whole
// bridge), CONDUCTOR_ACCOUNT_CHROME=0 (only the browser part). It needs two or more accounts
// saved with claude-account; with fewer it exposes nothing. Tokens never leave this process
// except as Authorization headers to api.anthropic.com / mcp-proxy.anthropic.com and as the
// CLAUDE_CODE_OAUTH_TOKEN environment variable of the `claude --claude-in-chrome-mcp` child.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const API = 'https://api.anthropic.com';
const PROXY = 'https://mcp-proxy.anthropic.com/v1/mcp/';
const LIST_BETA = 'mcp-servers-2025-12-04';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CHROME_TTL = 30 * 60e3;
const MAX_NAME = 96; // Claude Code adds "mcp__plugin_conductor_accounts__" (32); the API allows 128
const VERSION = (() => { try { return require('../package.json').version; } catch { return '0'; } })();

// ---------- pure helpers (tested) ----------
function slug(s, max = 24) {
  const x = String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (x || 'x').slice(0, max).replace(/_+$/, '');
}
// A tool name within MAX_NAME characters of [A-Za-z0-9_-]; long ones keep a hash so they stay unique.
function toolName(account, group, tool) {
  const t = String(tool).replace(/[^A-Za-z0-9_-]/g, '_');
  const n = `${slug(account, 16)}_${slug(group)}__${t}`;
  if (n.length <= MAX_NAME) return n;
  const h = crypto.createHash('sha256').update(n).digest('hex').slice(0, 8);
  return `${n.slice(0, MAX_NAME - 9)}_${h}`;
}
const connectorKey = c => `${String(c.display_name || '').trim().toLowerCase()}|${String(c.url || '').trim().toLowerCase()}`;

// Which connectors to bridge: per non-active account, those the active account lacks (by id, or
// by the same name and URL), first account in list order wins a duplicate.
function selectConnectors(byAccount, activeName, activeList) {
  const have = new Set();
  const ids = new Set();
  for (const c of activeList || []) { have.add(connectorKey(c)); ids.add(c.id); }
  const out = [];
  for (const { account, connectors } of byAccount) {
    if (account === activeName) continue;
    for (const c of connectors || []) {
      if (!c || !c.id || c.eligible === false || ids.has(c.id) || have.has(connectorKey(c))) continue;
      have.add(connectorKey(c)); ids.add(c.id);
      out.push({ account, id: c.id, name: c.display_name || c.id, url: c.url || '' });
    }
  }
  return out;
}

// A streamable-HTTP response body (JSON or SSE) -> the JSON-RPC message with this id.
function parseRpcBody(text, id) {
  const t = String(text || '').trim();
  if (!t) return null;
  const msgs = [];
  if (t[0] === '{' || t[0] === '[') {
    try { const j = JSON.parse(t); (Array.isArray(j) ? j : [j]).forEach(m => msgs.push(m)); } catch {}
  } else {
    let data = [];
    for (const line of t.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line === '' && data.length) { try { msgs.push(JSON.parse(data.join('\n'))); } catch {} data = []; }
    }
    if (data.length) { try { msgs.push(JSON.parse(data.join('\n'))); } catch {} }
  }
  return msgs.find(m => m && m.id === id && ('result' in m || 'error' in m)) || null;
}

function describe(prefix, tool) {
  return { ...tool, description: `${prefix} ${tool.description || ''}`.trim() };
}

// ---------- remote connector (claude.ai MCP proxy) ----------
function createConnectorClient({ id, getToken, fetchImpl = fetch, timeoutMs = 120000 }) {
  const clientSession = crypto.randomUUID();
  let session = null;
  let inited = false;
  let nextId = 1;
  async function post(body, token) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Mcp-Client-Session-Id': clientSession, 'MCP-Protocol-Version': '2025-06-18', 'User-Agent': `conductor-accounts/${VERSION}` };
    if (session) headers['Mcp-Session-Id'] = session;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(PROXY + encodeURIComponent(id), { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      const sid = r.headers && r.headers.get && r.headers.get('mcp-session-id');
      if (sid) session = sid;
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(t); }
  }
  async function init(token) {
    const rid = nextId++;
    const r = await post({ jsonrpc: '2.0', id: rid, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conductor-accounts', version: VERSION } } }, token);
    if (r.status >= 400) throw httpError(r);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token);
    inited = true;
  }
  async function request(method, params, retry = true) {
    const token = await getToken(!retry);
    if (!token) throw new Error('this account has no usable sign-in; run: claude-account status');
    if (!inited) await init(token);
    const rid = nextId++;
    const r = await post({ jsonrpc: '2.0', id: rid, method, params }, token);
    if ((r.status === 401 || r.status === 404) && retry) { inited = false; session = null; return request(method, params, false); }
    if (r.status >= 400) throw httpError(r);
    const m = parseRpcBody(r.text, rid);
    if (!m) throw new Error('the connector sent no answer');
    if (m.error) throw new Error(m.error.message || JSON.stringify(m.error));
    return m.result;
  }
  return { request };
}
function httpError(r) {
  let msg = '';
  try { const j = JSON.parse(r.text); msg = (j.error && (j.error.message || j.error.type)) || ''; } catch {}
  return new Error(`connector proxy HTTP ${r.status}${msg ? ': ' + msg : ''}`);
}

async function listConnectors(token, fetchImpl = fetch) {
  const out = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const url = `${API}/v1/mcp_servers?limit=1000${page ? '&page=' + encodeURIComponent(page) : ''}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': LIST_BETA, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'User-Agent': `conductor-accounts/${VERSION}` }, signal: ctl.signal });
      if (!r.ok) throw new Error(`connector list HTTP ${r.status}`);
      const j = await r.json();
      out.push(...(Array.isArray(j.data) ? j.data : []));
      page = j.next_page || null;
      if (!page) break;
    } finally { clearTimeout(t); }
  }
  return out;
}

// ---------- Chrome (claude --claude-in-chrome-mcp under another account) ----------
function claudeBin(env) {
  if (env.CONDUCTOR_CLAUDE_BIN) return env.CONDUCTOR_CLAUDE_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}
function createChromeClient({ getToken, env = process.env, spawnImpl = spawn, timeoutMs = 300000 }) {
  let child = null, childToken = null, buf = '', nextId = 1;
  const pending = new Map();
  function stop() {
    if (child) { try { child.kill(); } catch {} }
    child = null; childToken = null; buf = '';
    for (const [, p] of pending) p.reject(new Error('the browser bridge restarted'));
    pending.clear();
  }
  function send(msg) {
    if (!child) throw new Error('the browser bridge is not running');
    child.stdin.write(JSON.stringify(msg) + '\n');
  }
  function call(method, params, ms = timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`browser call timed out after ${Math.round(ms / 1000)} s`)); }, ms);
      pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      try { send({ jsonrpc: '2.0', id, method, params }); } catch (e) { pending.delete(id); clearTimeout(t); reject(e); }
    });
  }
  async function start(token) {
    stop();
    const cenv = { ...env, CLAUDE_CODE_OAUTH_TOKEN: token };
    delete cenv.CLAUDE_CODE_ENTRYPOINT;
    const c = spawnImpl(claudeBin(env), ['--claude-in-chrome-mcp'], { env: cenv, stdio: ['pipe', 'pipe', 'ignore'] });
    child = c; childToken = token;
    c.on('exit', () => { if (child === c) stop(); });
    c.on('error', () => { if (child === c) stop(); });
    c.stdin.on('error', () => { if (child === c) stop(); }); // EPIPE after the child died must not crash the bridge
    c.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const p = m && m.id != null && pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || 'browser error')) : p.resolve(m.result); }
      }
    });
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conductor-accounts', version: VERSION } }, 30000);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  // (Re)start when the account's token changed (refreshed), so the child never runs on an expired one.
  async function ensure() {
    const token = await getToken();
    if (!token) throw new Error('this account has no usable sign-in; run: claude-account status');
    if (!child || token !== childToken) await start(token);
  }
  async function request(method, params, ms) { await ensure(); return call(method, params, ms); }
  return { request, stop };
}

// ---------- the bridge ----------
function createBridge(opts = {}) {
  const env = opts.env || process.env;
  const manager = opts.manager;
  const fetchImpl = opts.fetch || fetch;
  const makeChrome = opts.chromeClient || (o => createChromeClient({ ...o, env }));
  const log = opts.log || (() => {});
  const chromeOn = () => env.CONDUCTOR_ACCOUNT_CHROME !== '0';
  const cacheFile = opts.cacheFile || null;
  function readCache() {
    let c = null;
    if (cacheFile) { try { c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {} }
    c = c && typeof c === 'object' ? c : {};
    c.chrome = c.chrome && typeof c.chrome === 'object' ? c.chrome : {};
    return c;
  }
  function writeCache(fn) {
    if (!cacheFile) return;
    const c = readCache(); fn(c);
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); const tmp = `${cacheFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 }); fs.renameSync(tmp, cacheFile); } catch {}
  }
  let tokens = { active: '', current: null, accounts: [] };
  let tools = new Map();          // exposed name -> { account, kind, target, tool }
  let connectorClients = new Map(); // `${account}|${id}` -> client
  let chromeClients = new Map();    // account -> client
  const used = new Set();           // accounts whose browser this session has driven (kept running)
  let summary = { connectors: [], browsers: [], errors: [] };

  async function refreshTokens() { tokens = await manager.tokens(); return tokens; }
  // The account's token, re-read when missing, about to expire, or rejected (force).
  async function tokenOf(account, force = false) {
    let a = tokens.accounts.find(x => x.name === account);
    if (force || !a || !a.token || (a.expiresAt && a.expiresAt < Date.now() + 120e3)) { await refreshTokens(); a = tokens.accounts.find(x => x.name === account); }
    return a && a.token;
  }
  function connectorClient(account, id) {
    const k = `${account}|${id}`;
    if (!connectorClients.has(k)) connectorClients.set(k, createConnectorClient({ id, fetchImpl, getToken: force => tokenOf(account, force) }));
    return connectorClients.get(k);
  }
  function chromeClient(account) {
    if (!chromeClients.has(account)) chromeClients.set(account, makeChrome({ getToken: () => tokenOf(account) }));
    return chromeClients.get(account);
  }

  // Rebuild the exposed tool list from the accounts' current state.
  let seq = 0;
  function unique(map, name) {
    if (!map.has(name)) return name;
    for (let i = 2; ; i++) { const n = `${name.slice(0, MAX_NAME - 3)}_${i}`; if (!map.has(n)) return n; }
  }
  async function discover() {
    const mine = ++seq;
    await refreshTokens();
    const next = new Map();
    const errors = [];
    const others = tokens.accounts.filter(a => !a.active);
    if (tokens.accounts.length < 2 || !others.length) { if (mine !== seq) return tools; tools = next; summary = { connectors: [], browsers: [], errors }; return next; }
    let activeList = [];
    if (tokens.current) { try { activeList = await listConnectors(tokens.current, fetchImpl); } catch (e) { errors.push(`active account: ${e.message}`); } }
    const byAccount = [];
    for (const a of others) {
      if (!a.token) { errors.push(`${a.name}: ${a.error}`); continue; }
      if (!a.scopes.includes('user:mcp_servers')) { errors.push(`${a.name}: its sign-in has no connector access; run: claude-account login ${a.name}`); continue; }
      try { byAccount.push({ account: a.name, connectors: await listConnectors(a.token, fetchImpl) }); } catch (e) { errors.push(`${a.name}: ${e.message}`); }
    }
    const picked = selectConnectors(byAccount, tokens.active, activeList);
    const found = [];
    await Promise.all(picked.map(async c => {
      try {
        const r = await connectorClient(c.account, c.id).request('tools/list', {});
        const list = (r && r.tools) || [];
        found.push({ ...c, tools: list.length });
        for (const t of list) {
          const name = unique(next, toolName(c.account, c.name, t.name));
          next.set(name, { account: c.account, kind: 'connector', target: c.id, tool: t.name, def: describe(`[${c.name}, via Claude account "${c.account}"]`, { ...t, name }) });
        }
      } catch (e) {
        errors.push(/requires authentication/i.test(e.message) ? `${c.account}/${c.name}: not signed in to this connector on claude.ai; skipped` : `${c.account}/${c.name}: ${e.message}`);
      }
    }));
    const browsers = [];
    if (chromeOn()) {
      for (const a of others) {
        if (!a.token) continue;
        const cc = chromeClient(a.name);
        try {
          // Probed at most every CHROME_TTL across all sessions (shared cache file): starting a
          // browser bridge in every new session is slow and makes the extension reconnect.
          let hit = readCache().chrome[a.name];
          if (!hit || Date.now() - hit.checkedAt > CHROME_TTL || !Array.isArray(hit.tools)) {
            const r = await cc.request('tools/call', { name: 'list_connected_browsers', arguments: {} }, 30000);
            const text = (r && r.content || []).map(x => x.text || '').join('');
            let list = []; try { list = JSON.parse(text); } catch {}
            const n = Array.isArray(list) ? list.length : 0;
            const tl = n ? await cc.request('tools/list', {}, 30000) : null;
            hit = { checkedAt: Date.now(), browsers: n, tools: (tl && tl.tools) || [] };
            writeCache(c => { c.chrome[a.name] = hit; });
          }
          if (!hit.browsers) { if (!used.has(a.name)) cc.stop(); continue; }
          for (const t of hit.tools) {
            const name = unique(next, toolName(a.name, 'chrome', t.name));
            next.set(name, { account: a.name, kind: 'chrome', tool: t.name, def: describe(`[Chrome browser signed in to Claude account "${a.name}"]`, { ...t, name }) });
          }
          browsers.push({ account: a.name, browsers: hit.browsers });
          // Not kept running for a session that may never use it: the first browser call starts it again.
          if (!used.has(a.name)) cc.stop();
        } catch (e) { cc.stop(); errors.push(`${a.name}/chrome: ${e.message}`); }
      }
    }
    if (mine !== seq) return tools; // a newer discovery (account switch) started meanwhile: it decides
    // The active account's browser belongs to Claude Code's own claude-in-chrome now.
    for (const [acc, cc] of chromeClients) if (!others.some(a => a.name === acc) || !browsers.some(b => b.account === acc)) { cc.stop(); used.delete(acc); }
    tools = next;
    summary = { active: tokens.active, connectors: found.sort((x, y) => (x.account + x.name).localeCompare(y.account + y.name)), browsers, errors };
    log(`discover: active=${tokens.active || '?'} tools=${next.size}${errors.length ? ' errors: ' + errors.join('; ') : ''}`);
    return next;
  }

  async function callTool(name, args) {
    const t = tools.get(name);
    if (!t) return { content: [{ type: 'text', text: `Unknown tool ${name}: the account bridge's tool list changed. List the tools again.` }], isError: true };
    try {
      if (t.kind === 'chrome') { used.add(t.account); return await chromeClient(t.account).request('tools/call', { name: t.tool, arguments: args || {} }); }
      return await connectorClient(t.account, t.target).request('tools/call', { name: t.tool, arguments: args || {} });
    } catch (e) {
      return { content: [{ type: 'text', text: `Claude account "${t.account}": ${e.message}` }], isError: true };
    }
  }

  function close() { for (const [, c] of chromeClients) c.stop(); }
  return { discover, callTool, list: () => [...tools.values()].map(t => t.def), summary: () => summary, close };
}

// ---------- stdio MCP server ----------
const INSTRUCTIONS = 'Conductor account bridge. The user has several Claude accounts. Tools named <account>_<connector>__<tool> are claude.ai connectors (Figma, Notion, Meetings, Google Drive...) that belong to another of the user\'s Claude accounts; tools named <account>_chrome__<tool> drive the Chrome browser whose Claude extension is signed in to that account. Use them like the connector or claude-in-chrome tools of this session when the session itself lacks that connector or browser. They run on the owning account without using its model quota.';

function serve({ bridge, input = process.stdin, output = process.stdout, fingerprint = () => '', pollMs = 60000 }) {
  let ready = null;
  let lastFp = fingerprint();
  const write = m => output.write(JSON.stringify(m) + '\n');
  const sig = () => bridge.list().map(t => t.name).sort().join(',');
  function rediscover() {
    const before = sig();
    ready = ready.then(() => bridge.discover()).catch(() => {}).then(() => { if (sig() !== before) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); });
    return ready;
  }
  ready = bridge.discover().catch(() => {});
  const timer = setInterval(() => {
    const fp = fingerprint();
    if (fp !== lastFp) { lastFp = fp; rediscover(); }
  }, pollMs);
  const slow = setInterval(rediscover, 30 * 60e3); // connectors added or a browser connected later
  timer.unref(); slow.unref();

  async function handle(m) {
    const { id, method, params } = m;
    const reply = result => id !== undefined && write({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const v = params && PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[1];
        return reply({ protocolVersion: v, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'conductor-accounts', version: VERSION }, instructions: INSTRUCTIONS });
      }
      case 'ping': return reply({});
      case 'tools/list': {
        let t;
        await Promise.race([ready, new Promise(r => { t = setTimeout(r, 25000); })]);
        clearTimeout(t);
        return reply({ tools: bridge.list() });
      }
      case 'tools/call': {
        await ready;
        return reply(await bridge.callTool(params && params.name, params && params.arguments));
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default:
        if (id === undefined) return; // notifications
        return fail(-32601, `method not found: ${method}`);
    }
  }
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      handle(m).catch(e => m.id !== undefined && write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e && e.message || e) } }));
    }
  });
  input.on('end', () => { clearInterval(timer); clearInterval(slow); bridge.close(); process.exit(0); });
}

function loadEnv() {
  const { readEnv } = require('../dashboard/lib/config');
  const conf = readEnv(process.env.CONDUCTOR_CONFIG || path.join(os.homedir(), '.config', 'conductor', 'conductor.env'));
  return { ...conf, ...process.env };
}

// `node lib/connectors.js` = the MCP server; `node lib/connectors.js list` = what it would expose.
async function main(argv) {
  const env = loadEnv();
  const { createManager } = require('./accounts');
  const manager = createManager({ env });
  const off = env.CONDUCTOR_ACCOUNT_CONNECTORS === '0' || env.CONDUCTOR_ROLE === 'worker';
  const stateDir = env.CONDUCTOR_HOME || path.join(os.homedir(), '.claude', 'conductor');
  const logFile = path.join(stateDir, 'accounts-bridge.log');
  const cacheFile = path.join(stateDir, 'accounts-bridge-cache.json');
  if (argv[0] === 'list') { try { fs.unlinkSync(cacheFile); } catch {} }
  const log = s => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch {} };
  const bridge = off ? { discover: async () => {}, callTool: async () => ({ content: [{ type: 'text', text: 'The account bridge is off (CONDUCTOR_ACCOUNT_CONNECTORS=0).' }], isError: true }), list: () => [], summary: () => ({}), close() {} } : createBridge({ env, manager, log, cacheFile });
  if (argv[0] === 'list') {
    if (off) { console.log('The account bridge is off (CONDUCTOR_ACCOUNT_CONNECTORS=0).'); return; }
    await bridge.discover();
    const s = bridge.summary();
    if (!s.active && !s.connectors.length) console.log('Nothing to bridge: save two or more accounts with claude-account first.');
    else {
      console.log(`active account: ${s.active || '(not a saved one)'} — its own connectors and browser stay with Claude Code`);
      for (const c of s.connectors) console.log(`  ${c.account.padEnd(10)} ${c.name} (${c.tools} tools)`);
      for (const b of s.browsers) console.log(`  ${b.account.padEnd(10)} Chrome browser (${b.browsers} connected)`);
      if (!s.connectors.length && !s.browsers.length) console.log('  no connectors or browsers on the other accounts that this one lacks');
    }
    for (const e of s.errors || []) console.log(`  ! ${e}`);
    bridge.close();
    return;
  }
  serve({ bridge, fingerprint: off ? () => '' : manager.currentFingerprint });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(`conductor accounts bridge: ${e.message}`); process.exitCode = 1; });
}

module.exports = { main, slug, toolName, selectConnectors, parseRpcBody, createConnectorClient, createChromeClient, createBridge, listConnectors, serve, INSTRUCTIONS };
