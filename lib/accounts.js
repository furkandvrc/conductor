'use strict';
// Claude account rotation: keep several Claude subscriptions signed in and move to the next
// one when the active account reaches its 5-hour or weekly limit.
//
// What it touches, and nothing else:
//   - the `claudeAiOauth` field of Claude Code's own credential store (macOS Keychain item
//     "Claude Code-credentials", or ~/.claude/.credentials.json elsewhere). Every other field
//     in that store (MCP server sign-ins, ...) is read back and written unchanged.
//   - the `oauthAccount` key of ~/.claude.json (which account the UI shows). Other keys are kept.
// Saved accounts live in their own Keychain items ("Conductor Claude account: <name>") or, off
// macOS, in ~/.claude/conductor/accounts/<name>.json (mode 600). Non-secret state (names,
// emails, last known usage, switch log) is ~/.claude/conductor/accounts.json.
//
// Usage is read from /api/oauth/usage, which costs no tokens. Claude Code owns the active
// account's tokens and refreshes them itself; a saved account that is not in use is owned by
// conductor alone, so conductor refreshes its token when it expires (about every 8 hours) to keep
// its usage current. That is how a window that resets early is noticed. CONDUCTOR_ACCOUNT_REFRESH=0
// turns that off. The dashboard server also runs the check in the background, so it happens even
// when no prompt is sent.
//
// Claude Code re-reads its credential store when it refreshes a token or gets a 401, so new
// sessions and `delegate claude` runs use the new account at once; a session that was already
// running keeps its cached token until its next refresh (or restart it with `claude --continue`).
//
// CLI: claude-account add <name> | login <name> | list | use <name> | auto | remove <name> | status
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const HOME = os.homedir();
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const API = 'https://api.anthropic.com';
const BETA = 'oauth-2025-04-20';
const WINDOWS = ['five_hour', 'seven_day'];
// Claude Code's own OAuth client and token endpoint (the same request it sends to refresh).
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function paths(env = process.env) {
  const stateDir = env.CONDUCTOR_HOME || path.join(HOME, '.claude', 'conductor');
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  return {
    stateDir,
    state: path.join(stateDir, 'accounts.json'),
    profiles: path.join(stateDir, 'accounts'),
    globalConfig: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(HOME, '.claude.json'),
    credFile: path.join(claudeDir, '.credentials.json'),
  };
}

// ---------- credential stores ----------
// Claude Code's own naming: "Claude Code-credentials", plus "-<sha256(dir)[0:8]>" when
// CLAUDE_CONFIG_DIR is set; Keychain account = $USER (or "claude-code-user").
function keychainService(configDir) {
  const suffix = configDir ? '-' + crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8) : '';
  return 'Claude Code-credentials' + suffix;
}
function keychainUser(env = process.env) {
  let u;
  try { u = env.USER || os.userInfo().username; } catch { u = ''; }
  return /^[a-zA-Z0-9._-]+$/.test(u || '') ? u : 'claude-code-user';
}
const SEC = '/usr/bin/security';
function kcRead(service, user) {
  try {
    const out = execFileSync(SEC, ['find-generic-password', '-a', user, '-w', '-s', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    return out ? JSON.parse(out) : null;
  } catch { return null; }
}
function kcWrite(service, user, obj) {
  const hex = Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${user}" -s "${service}" -X "${hex}"\n`;
  // Same as Claude Code: stdin keeps the secret out of `ps`; long payloads fall back to argv.
  const r = line.length <= 4000
    ? spawnSync(SEC, ['-i'], { input: line, encoding: 'utf8', timeout: 10000 })
    : spawnSync(SEC, ['add-generic-password', '-U', '-a', user, '-s', service, '-X', hex], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(`Keychain write failed for "${service}" (exit ${r.status}${r.stderr ? ': ' + r.stderr.trim() : ''})`);
}
function kcDelete(service, user) {
  spawnSync(SEC, ['delete-generic-password', '-a', user, '-s', service], { stdio: 'ignore', timeout: 10000 });
}

function readJsonFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJsonAtomic(f, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, f);
}

function keychainStore(env = process.env) {
  const user = keychainUser(env);
  const current = keychainService(env.CLAUDE_CONFIG_DIR);
  const prof = n => `Conductor Claude account: ${n}`;
  return {
    kind: 'keychain',
    readCurrent: () => kcRead(current, user),
    writeCurrent: obj => kcWrite(current, user, obj),
    readProfile: n => kcRead(prof(n), user),
    writeProfile: (n, o) => kcWrite(prof(n), user, o),
    deleteProfile: n => kcDelete(prof(n), user),
    // credentials written by `claude auth login` run with CLAUDE_CONFIG_DIR=<dir>
    readForeign: dir => kcRead(keychainService(dir), user),
    deleteForeign: dir => kcDelete(keychainService(dir), user),
  };
}
function fileStore(env = process.env) {
  const P = paths(env);
  const pf = n => path.join(P.profiles, `${n}.json`);
  return {
    kind: 'file',
    readCurrent: () => readJsonFile(P.credFile),
    writeCurrent: o => writeJsonAtomic(P.credFile, o),
    readProfile: n => readJsonFile(pf(n)),
    writeProfile: (n, o) => writeJsonAtomic(pf(n), o),
    deleteProfile: n => { try { fs.unlinkSync(pf(n)); } catch {} },
    readForeign: dir => readJsonFile(path.join(dir, '.credentials.json')),
    deleteForeign: () => {},
  };
}
function defaultStore(env = process.env) {
  if (env.CONDUCTOR_ACCOUNT_STORE === 'file') return fileStore(env);
  return process.platform === 'darwin' ? keychainStore(env) : fileStore(env);
}

// ---------- network ----------
async function apiGet(p, token, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API + p, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': BETA, 'Content-Type': 'application/json', 'User-Agent': 'conductor-accounts' }, signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, body: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// Exchange a refresh token for a new token pair. The old refresh token stops working.
async function refreshOAuth(oauth, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const body = { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID };
    if (Array.isArray(oauth.scopes) && oauth.scopes.length) body.scope = oauth.scopes.join(' ');
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'conductor-accounts' }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, body: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// One lock per saved account, shared by every conductor process (hooks, dashboard, CLI): a
// refresh and a switch to that account never overlap, so Claude Code is never handed a refresh
// token that has just been rotated away.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lockAccount(dir, name, waitMs) {
  const f = path.join(dir, `.lock-${name}`);
  const end = Date.now() + waitMs;
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      fs.closeSync(fs.openSync(f, 'wx', 0o600));
      return () => { try { fs.unlinkSync(f); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(f).mtimeMs > 60e3) { fs.unlinkSync(f); continue; } } catch { continue; } // left by a crashed process
    }
    if (Date.now() >= end) return null;
    sleepSync(100);
  }
}

// ---------- pure helpers (tested) ----------
function tokenUsable(oauth, now) { return !!(oauth && oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > now + 60000)); }

// /api/oauth/usage -> { checkedAt, five_hour: {pct, resetsAt}, seven_day: {...} }  (resetsAt in ms)
function parseUsage(body, now) {
  const u = { checkedAt: now };
  for (const w of WINDOWS) {
    const x = body && body[w];
    if (!x || typeof x.utilization !== 'number') continue;
    const r = x.resets_at ? Date.parse(x.resets_at) : NaN;
    u[w] = { pct: x.utilization, resetsAt: Number.isFinite(r) ? r : null };
  }
  return u;
}

// When an account is blocked until, from its last known usage and any rate-limit mark; 0 = free.
function blockedUntil(acc, now, threshold) {
  let until = acc.limitedUntil && acc.limitedUntil > now ? acc.limitedUntil : 0;
  const u = acc.usage || {};
  for (const w of WINDOWS) {
    const x = u[w];
    if (!x || typeof x.pct !== 'number' || x.pct < threshold) continue;
    const r = x.resetsAt || 0;
    if (r > now) until = Math.max(until, r);
    else if (!r) until = Math.max(until, (u.checkedAt || now) + 3600e3); // no reset time known: re-check in an hour
  }
  return until;
}

// The account to move to: the main account if it is free, else the first free one after
// `active` in list order, or null.
function pickNext(accounts, active, now, threshold, primary = '') {
  const i = accounts.findIndex(a => a.name === active);
  const order = accounts.slice(i + 1).concat(accounts.slice(0, Math.max(i, 0)));
  const p = order.findIndex(a => a.name === primary);
  if (p > 0) order.unshift(order.splice(p, 1)[0]);
  return order.find(a => a.name !== active && !blockedUntil(a, now, threshold)) || null;
}

function sameToken(a, b) {
  return !!(a && b && ((a.refreshToken && a.refreshToken === b.refreshToken) || (a.accessToken && a.accessToken === b.accessToken)));
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toTimeString().slice(0, 5) : `${d.toISOString().slice(5, 10)} ${d.toTimeString().slice(0, 5)}`;
}

// ---------- the manager ----------
function createManager(opts = {}) {
  const env = opts.env || process.env;
  const P = opts.paths || paths(env);
  const store = opts.store || defaultStore(env);
  const now = opts.now || (() => Date.now());
  const get = opts.apiGet || apiGet;
  const refresh = opts.refreshOAuth || refreshOAuth;
  const refreshOn = () => env.CONDUCTOR_ACCOUNT_REFRESH !== '0';
  const threshold = () => {
    const v = Number(opts.threshold ?? env.CONDUCTOR_ACCOUNT_THRESHOLD);
    return Number.isFinite(v) && v >= 50 && v <= 100 ? v : 98;
  };
  const pollMs = () => {
    const v = Number(env.CONDUCTOR_ACCOUNT_POLL);
    return (Number.isFinite(v) && v >= 60 ? v : 300) * 1000;
  };

  function load() {
    const s = readJsonFile(P.state) || {};
    return { version: 1, accounts: Array.isArray(s.accounts) ? s.accounts : [], active: s.active || '', primary: s.primary || '', lastPoll: s.lastPoll || 0, log: Array.isArray(s.log) ? s.log : [] };
  }
  // The main account: the one set with `claude-account primary`, else the first one saved.
  function primaryOf(s) {
    return s.accounts.find(a => a.name === s.primary) || s.accounts[0] || null;
  }
  const returnOn = () => env.CONDUCTOR_ACCOUNT_RETURN !== '0';
  // A hand-picked account (CLI or dashboard) is kept until it hits its own limit.
  function heldByHand(s) {
    const last = s.log[s.log.length - 1];
    return !!(last && last.to === s.active && (last.reason === 'use' || last.reason === 'dashboard'));
  }
  function save(s) { s.log = s.log.slice(-50); writeJsonAtomic(P.state, s); }

  function readGlobalAccount() {
    const j = readJsonFile(P.globalConfig);
    return j && j.oauthAccount ? j.oauthAccount : null;
  }
  // Replace only oauthAccount in ~/.claude.json, keeping every other key and the file mode.
  function writeGlobalAccount(oauthAccount) {
    if (!oauthAccount) return;
    let raw;
    try { raw = fs.readFileSync(P.globalConfig, 'utf8'); } catch { return; }
    let j;
    try { j = JSON.parse(raw); } catch { return; } // never rewrite a file we cannot parse
    j.oauthAccount = oauthAccount;
    let mode = 0o600;
    try { mode = fs.statSync(P.globalConfig).mode & 0o777; } catch {}
    const target = fs.realpathSync(P.globalConfig);
    writeJsonAtomic(target, j, mode);
  }

  async function identify(oauth) {
    if (!tokenUsable(oauth, now())) return null;
    const r = await get('/api/oauth/profile', oauth.accessToken);
    if (!r.ok || !r.body || !r.body.account) return null;
    return { uuid: r.body.account.uuid, email: r.body.account.email || '', org: r.body.organization && r.body.organization.name || '', plan: r.body.organization && r.body.organization.organization_type || '' };
  }

  // Which saved account is in Claude Code's store right now; refreshes that account's saved
  // tokens (they rotate on every refresh). Only saves when the owner is certain.
  async function sync(s) {
    const cur = store.readCurrent();
    const oauth = cur && cur.claudeAiOauth;
    if (!oauth) return null;
    let acc = null;
    for (const a of s.accounts) {
      const p = store.readProfile(a.name);
      if (p && sameToken(p.claudeAiOauth, oauth)) { acc = a; break; }
    }
    if (!acc) {
      const who = await identify(oauth);
      if (who) acc = s.accounts.find(a => a.uuid && a.uuid === who.uuid) || null;
    }
    if (!acc) { s.active = ''; return null; }
    const p = store.readProfile(acc.name) || {};
    if (JSON.stringify(p.claudeAiOauth) !== JSON.stringify(oauth)) store.writeProfile(acc.name, { ...p, claudeAiOauth: oauth });
    const g = readGlobalAccount();
    if (g && g.accountUuid === acc.uuid) acc.oauthAccount = g;
    s.active = acc.name;
    return acc;
  }

  // A usable access token for a saved account. The active account's token belongs to Claude Code
  // and is never refreshed here; an idle account's expired token is refreshed and saved back.
  async function tokenFor(s, acc) {
    let p = store.readProfile(acc.name);
    let oauth = p && p.claudeAiOauth;
    if (tokenUsable(oauth, now())) return oauth;
    if (!oauth || !oauth.refreshToken || !refreshOn() || acc.name === s.active) return null;
    const release = lockAccount(P.stateDir, acc.name, 0); // another process is on it: skip this round
    if (!release) return null;
    try {
      const cur = store.readCurrent();
      p = store.readProfile(acc.name) || {};
      oauth = p.claudeAiOauth;
      if (!oauth) return null;
      if (cur && sameToken(cur.claudeAiOauth, oauth)) return null; // Claude Code uses it now
      if (tokenUsable(oauth, now())) return oauth;
      const r = await refresh(oauth);
      if (!r.ok || !r.body || !r.body.access_token) {
        acc.lastError = r.status === 400 || r.status === 401 ? `signed out; run: claude-account login ${acc.name}` : `token refresh ${r.status || r.error || 'error'}`;
        return null;
      }
      const b = r.body;
      const next = { ...oauth, accessToken: b.access_token, refreshToken: b.refresh_token || oauth.refreshToken, expiresAt: now() + (Number(b.expires_in) || 3600) * 1000 };
      if (Number(b.refresh_token_expires_in) > 0) next.refreshTokenExpiresAt = now() + Number(b.refresh_token_expires_in) * 1000;
      if (typeof b.scope === 'string' && b.scope.trim()) next.scopes = b.scope.trim().split(/\s+/);
      store.writeProfile(acc.name, { ...p, claudeAiOauth: next });
      return next;
    } finally { release(); }
  }

  async function poll(s, acc, force) {
    if (!acc) return null;
    if (!force && acc.usage && now() - (acc.usage.checkedAt || 0) < pollMs()) return acc.usage;
    const oauth = await tokenFor(s, acc);
    if (!oauth) return acc.usage || null;
    const r = await get('/api/oauth/usage', oauth.accessToken);
    s.lastPoll = now();
    if (!r.ok) { acc.lastError = `usage ${r.status || r.error || 'error'}`; return acc.usage || null; }
    acc.usage = parseUsage(r.body, now());
    acc.lastError = '';
    if (acc.limitedUntil && !blockedUntil({ usage: acc.usage }, now(), threshold())) acc.limitedUntil = 0;
    return acc.usage;
  }

  // Put `target` into Claude Code's store, keeping every other field of that store.
  function apply(s, target, reason) {
    const release = lockAccount(P.stateDir, target.name, 20000); // wait out a refresh in flight
    if (!release) throw new Error(`"${target.name}" is busy (token refresh); try again`);
    try {
      const p = store.readProfile(target.name);
      if (!p || !p.claudeAiOauth) throw new Error(`no saved credentials for "${target.name}"; run: claude-account add ${target.name}`);
      const cur = store.readCurrent() || {};
      store.writeCurrent({ ...cur, claudeAiOauth: p.claudeAiOauth });
    } finally { release(); }
    writeGlobalAccount(target.oauthAccount);
    s.log.push({ t: now(), from: s.active || '', to: target.name, reason });
    s.active = target.name;
  }

  async function add(name, { from } = {}) {
    if (!NAME_RE.test(name || '')) throw new Error('account name: lowercase letters, digits, . _ - (max 32)');
    const s = load();
    let blob, global;
    if (from) {
      blob = store.readForeign(from);
      global = (readJsonFile(path.join(from, '.claude.json')) || {}).oauthAccount || null;
    } else {
      blob = store.readCurrent();
      global = readGlobalAccount();
    }
    const oauth = blob && blob.claudeAiOauth;
    if (!oauth) throw new Error(from ? 'that sign-in left no Claude credentials' : 'Claude Code is not signed in with a Claude account (run /login first)');
    const who = await identify(oauth);
    const uuid = (who && who.uuid) || (global && global.accountUuid) || '';
    const email = (who && who.email) || (global && global.emailAddress) || '';
    if (!uuid) throw new Error('could not tell which account this is (network?); try again');
    const clash = s.accounts.find(a => a.uuid === uuid && a.name !== name);
    if (clash) throw new Error(`this is ${email || 'the same account'}, already saved as "${clash.name}"`);
    const prev = s.accounts.find(a => a.name === name);
    if (prev && prev.uuid && prev.uuid !== uuid) throw new Error(`"${name}" is already ${prev.email || 'another account'}; remove it first`);
    store.writeProfile(name, { claudeAiOauth: oauth });
    const acc = prev || { name, addedAt: now() };
    Object.assign(acc, { uuid, email, plan: (who && who.plan) || '', oauthAccount: global && global.accountUuid === uuid ? global : acc.oauthAccount || null });
    if (!prev) s.accounts.push(acc);
    if (!from) s.active = name;
    await poll(s, acc, true);
    save(s);
    return acc;
  }

  // Sign a second account in without touching the current one: `claude auth login` with a
  // throw-away CLAUDE_CONFIG_DIR, then import and delete what it wrote.
  async function login(name, { claudeBin = 'claude', email } = {}) {
    if (!NAME_RE.test(name || '')) throw new Error('account name: lowercase letters, digits, . _ - (max 32)');
    fs.mkdirSync(P.stateDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(P.stateDir, 'login-'));
    try {
      const args = ['auth', 'login', '--claudeai'];
      if (email) args.push('--email', email);
      const r = spawnSync(claudeBin, args, { stdio: 'inherit', env: { ...env, CLAUDE_CONFIG_DIR: dir } });
      if (r.status !== 0) throw new Error(`claude auth login exited ${r.status}`);
      return await add(name, { from: dir });
    } finally {
      try { store.deleteForeign(dir); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function use(name, reason = 'use') {
    const s = load();
    const target = s.accounts.find(a => a.name === name);
    if (!target) throw new Error(`no account "${name}"; see: claude-account list`);
    await sync(s);
    if (s.active !== name) apply(s, target, reason);
    save(s);
    return target;
  }

  function remove(name) {
    const s = load();
    if (!s.accounts.some(a => a.name === name)) throw new Error(`no account "${name}"`);
    s.accounts = s.accounts.filter(a => a.name !== name);
    if (s.active === name) s.active = '';
    if (s.primary === name) s.primary = '';
    store.deleteProfile(name);
    save(s);
  }

  // The rotation step. reason: 'prompt' (hook, throttled), 'watch' (dashboard server timer,
  // throttled the same way), 'rate_limit' (the turn just failed on a limit), 'manual'.
  async function auto({ reason = 'manual', force = false } = {}) {
    const s = load();
    const res = { switched: false, from: '', to: '', active: '', message: '' };
    if (s.accounts.length < 2 || env.CONDUCTOR_ACCOUNTS === '0') { res.active = s.active; return res; }
    if ((reason === 'prompt' || reason === 'watch') && !force && now() - s.lastPoll < pollMs()) { res.active = s.active; return res; }
    s.lastPoll = now();
    const acc = await sync(s);
    res.active = res.from = s.active;
    if (!acc) { save(s); res.message = 'Claude Code is signed in to an account conductor does not know; add it with claude-account add <name>'; return res; }
    await poll(s, acc, true);
    if (reason === 'rate_limit') {
      const b = blockedUntil(acc, now(), threshold());
      acc.limitedUntil = b || now() + 30 * 60e3; // the limit hit even if usage did not show it yet
    }
    const until = blockedUntil(acc, now(), threshold());
    // Back to the main account as soon as it has room again (its window reset), unless the
    // current one was picked by hand and still has room.
    const main = primaryOf(s);
    if (returnOn() && main && main !== acc && !(heldByHand(s) && !until)) {
      await poll(s, main, false); // fresh usage if its saved token still works, else the last known
      if (!blockedUntil(main, now(), threshold())) {
        apply(s, main, 'main');
        save(s);
        Object.assign(res, { switched: true, to: main.name, active: main.name, message: `Claude account switched back to the main account: ${acc.name} → ${main.name} (${main.name} has room again).` });
        return res;
      }
    }
    if (!until) { save(s); return res; }
    const others = s.accounts.filter(a => a !== acc);
    for (const o of others) await poll(s, o, false);
    const next = pickNext(s.accounts, acc.name, now(), threshold(), returnOn() ? main && main.name : '');
    if (!next) {
      const soonest = Math.min(until, ...others.map(o => blockedUntil(o, now(), threshold()) || Infinity));
      res.message = `All Claude accounts are at their limit; the first frees up at ${fmtTime(soonest)}.`;
      save(s);
      return res;
    }
    apply(s, next, reason);
    save(s);
    Object.assign(res, { switched: true, to: next.name, active: next.name, message: `Claude account switched: ${acc.name} → ${next.name} (${acc.name} is limited until ${fmtTime(until)}).` });
    return res;
  }

  function setPrimary(name) {
    const s = load();
    if (!s.accounts.some(a => a.name === name)) throw new Error(`no account "${name}"; see: claude-account list`);
    s.primary = name;
    save(s);
    return name;
  }

  async function status({ refresh = false } = {}) {
    const s = load();
    if (refresh) { await sync(s); for (const a of s.accounts) await poll(s, a, true); save(s); }
    const t = threshold();
    const main = primaryOf(s);
    return {
      active: s.active, primary: main ? main.name : '', returnToPrimary: returnOn(), threshold: t, store: store.kind, enabled: env.CONDUCTOR_ACCOUNTS !== '0',
      accounts: s.accounts.map(a => ({ name: a.name, email: a.email || '', plan: a.plan || '', active: a.name === s.active, primary: a === main, usage: a.usage || null, blockedUntil: blockedUntil(a, now(), t), lastError: a.lastError || '' })),
      log: s.log.slice(-10),
    };
  }

  return { add, login, use, remove, auto, status, setPrimary, sync: async () => { const s = load(); const a = await sync(s); save(s); return a; }, _load: load };
}

// ---------- CLI ----------
const HELP = `claude-account — rotate between Claude accounts when one hits its 5-hour or weekly limit

  claude-account add <name>       save the account Claude Code is signed in with now
  claude-account login <name>     sign another account in (browser) and save it; the current
                                  sign-in is not touched
  claude-account list             accounts, last known usage, which one is active
  claude-account status           same, after fetching fresh usage for each account
  claude-account use <name>       switch now (kept until it hits its own limit)
  claude-account primary [<name>] show or set the main account (default: the first one saved);
                                  conductor moves back to it as soon as it has room again
  claude-account auto             switch if the active account is at its limit, or back to the
                                  main account if that one has room again
  claude-account remove <name>    forget an account (does not sign it out anywhere)

Settings (~/.config/conductor/conductor.env): CONDUCTOR_ACCOUNTS=0 turns automatic switching
off; CONDUCTOR_ACCOUNT_THRESHOLD (50-100, default 98) is the usage % that counts as limited;
CONDUCTOR_ACCOUNT_RETURN=0 stays on the account it moved to instead of going back to the main one;
CONDUCTOR_ACCOUNT_POLL (60-3600 s, default 300) is how often usage is checked (it costs no tokens);
CONDUCTOR_ACCOUNT_REFRESH=0 stops conductor refreshing idle accounts' tokens (their usage then goes
stale once the token expires, so an early reset is only seen at the stated reset time).
New sessions and delegate runs use the new account at once; a session that was already running
picks it up at its next token refresh, or restart it with \`claude --continue\`.`;

function pct(w) { return w && typeof w.pct === 'number' ? `${Math.round(w.pct)}%` : '–'; }
function printStatus(st) {
  if (!st.accounts.length) { console.log('No accounts saved yet. Start with: claude-account add <name>'); return; }
  for (const a of st.accounts) {
    const u = a.usage || {};
    const lim = a.blockedUntil ? `  limited until ${fmtTime(a.blockedUntil)}` : '';
    console.log(`${a.active ? '*' : ' '} ${(a.name + (a.primary ? ' (main)' : '')).padEnd(12)} ${(a.email || '').padEnd(28)} 5h ${pct(u.five_hour).padStart(4)} (resets ${fmtTime(u.five_hour && u.five_hour.resetsAt)})  week ${pct(u.seven_day).padStart(4)} (resets ${fmtTime(u.seven_day && u.seven_day.resetsAt)})${lim}${a.lastError ? '  [' + a.lastError + ']' : ''}`);
  }
  if (!st.enabled) console.log('\nAutomatic switching is off (CONDUCTOR_ACCOUNTS=0).');
}

async function main(argv) {
  const { readEnv } = require('../dashboard/lib/config');
  const conf = readEnv(process.env.CONDUCTOR_CONFIG || path.join(HOME, '.config', 'conductor', 'conductor.env'));
  const env = { ...conf, ...process.env };
  const m = createManager({ env });
  const [cmd, arg] = argv;
  switch (cmd) {
    case 'add': { const a = await m.add(arg); console.log(`saved "${a.name}" (${a.email || a.uuid})`); break; }
    case 'login': {
      const i = argv.indexOf('--email');
      const a = await m.login(arg, { email: i > 0 ? argv[i + 1] : undefined });
      console.log(`saved "${a.name}" (${a.email || a.uuid}); the account Claude Code uses now is unchanged`);
      break;
    }
    case 'list': printStatus(await m.status()); break;
    case 'status': printStatus(await m.status({ refresh: true })); break;
    case 'use': { const a = await m.use(arg); console.log(`now using "${a.name}" (${a.email}). Running sessions switch at their next token refresh; or restart with: claude --continue`); break; }
    case 'remove': m.remove(arg); console.log(`removed "${arg}"`); break;
    case 'primary': {
      if (arg) m.setPrimary(arg);
      const st = await m.status();
      console.log(st.primary ? `main account: ${st.primary}${st.returnToPrimary ? '' : ' (going back to it is off: CONDUCTOR_ACCOUNT_RETURN=0)'}` : 'no accounts saved yet');
      break;
    }
    case 'sync': { const a = await m.sync(); console.log(a ? `active: ${a.name}` : 'active account is not one of the saved ones'); break; }
    case 'auto': {
      const r = await m.auto({ reason: argv.includes('--rate-limit') ? 'rate_limit' : 'manual', force: true });
      console.log(r.message || `active: ${r.active || '-'} (no switch needed)`);
      break;
    }
    case 'hook': return hook(m, arg);
    case undefined: case '-h': case '--help': case 'help': console.log(HELP); break;
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 2;
  }
}

// Desktop notification (macOS) — hooks run in the background, so this is how a switch is seen.
function notify(text) {
  if (process.platform !== 'darwin' || process.env.CONDUCTOR_ACCOUNT_NOTIFY === '0') return;
  const safe = String(text).replace(/["\\]/g, "'").slice(0, 240);
  spawnSync('/usr/bin/osascript', ['-e', `display notification "${safe}" with title "Conductor"`], { stdio: 'ignore', timeout: 5000 });
}

// Hook entry: `claude-account hook <prompt|stop-failure>` with the hook JSON on stdin.
// Never fails the hook: any error is swallowed and the exit code is 0.
async function hook(m, event) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  try {
    if (event === 'stop-failure') {
      if (input.error !== 'rate_limit') return;
      const r = await m.auto({ reason: 'rate_limit' });
      const msg = r.switched
        ? `${r.message} New sessions use it now; to carry on this conversation with it: /exit, then claude --continue.`
        : r.message;
      if (msg) { notify(msg); process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n'); }
      return;
    }
    const r = await m.auto({ reason: 'prompt' });
    if (r.switched) { notify(r.message); process.stdout.write(JSON.stringify({ systemMessage: r.message }) + '\n'); }
  } catch { /* a broken rotation must never block Claude Code */ }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(`claude-account: ${e.message}`); process.exitCode = 1; });
}

module.exports = { createManager, parseUsage, blockedUntil, pickNext, keychainService, keychainUser, paths, NAME_RE, fileStore, notify };
