'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManager, parseUsage, blockedUntil, pickNext, keychainService } = require('../lib/accounts');

const H = 3600e3;
const T0 = Date.parse('2026-11-09T10:00:00Z');

function memStore(current) {
  const profiles = new Map();
  return {
    kind: 'memory',
    current,
    readCurrent() { return this.current ? JSON.parse(JSON.stringify(this.current)) : null; },
    writeCurrent(o) { this.current = JSON.parse(JSON.stringify(o)); },
    readProfile: n => profiles.has(n) ? JSON.parse(JSON.stringify(profiles.get(n))) : null,
    writeProfile: (n, o) => profiles.set(n, JSON.parse(JSON.stringify(o))),
    deleteProfile: n => profiles.delete(n),
    readForeign: () => null, deleteForeign: () => {},
    profiles,
  };
}
const tok = (id, exp = T0 + 8 * H) => ({ accessToken: `at-${id}`, refreshToken: `rt-${id}`, expiresAt: exp, scopes: ['user:inference'] });

// fake API: token -> account, and per-account usage
function fakeApi(usage) {
  const calls = [];
  const who = t => t.replace(/^at-/, '').replace(/-\d+$/, '');
  const fn = async (p, token) => {
    calls.push(p);
    const id = who(token);
    if (p === '/api/oauth/profile') return { ok: true, body: { account: { uuid: `uuid-${id}`, email: `${id}@x.test` }, organization: { name: id, organization_type: 'claude_max' } } };
    if (p === '/api/oauth/usage') return { ok: true, body: usage[id] || {} };
    return { ok: false, status: 404 };
  };
  fn.calls = calls;
  return fn;
}
const win = (pct, resetsInH) => ({ utilization: pct, resets_at: new Date(T0 + resetsInH * H).toISOString() });

function setup(usage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-acc-'));
  const P = { stateDir: dir, state: path.join(dir, 'accounts.json'), profiles: path.join(dir, 'p'), globalConfig: path.join(dir, '.claude.json'), credFile: path.join(dir, 'cred.json') };
  const global = { theme: 'dark', projects: { a: 1 }, oauthAccount: { accountUuid: 'uuid-a', emailAddress: 'a@x.test' } };
  fs.writeFileSync(P.globalConfig, JSON.stringify(global));
  const store = memStore({ claudeAiOauth: tok('a'), mcpOAuth: { figma: { token: 'keep-me' } } });
  let t = T0;
  const api = fakeApi(usage);
  const m = createManager({ env: {}, paths: P, store, apiGet: api, now: () => t });
  return { m, store, P, api, setNow: v => { t = v; } };
}

test('parseUsage reads both windows as percent with reset times', () => {
  const u = parseUsage({ five_hour: win(48, 2), seven_day: win(89, 30), seven_day_opus: null }, T0);
  assert.strictEqual(u.five_hour.pct, 48);
  assert.strictEqual(u.five_hour.resetsAt, T0 + 2 * H);
  assert.strictEqual(u.seven_day.pct, 89);
});

test('blockedUntil: limited window blocks until its reset; past resets free the account', () => {
  const acc = { usage: { checkedAt: T0, five_hour: { pct: 100, resetsAt: T0 + H }, seven_day: { pct: 40, resetsAt: T0 + 50 * H } } };
  assert.strictEqual(blockedUntil(acc, T0, 98), T0 + H);
  assert.strictEqual(blockedUntil(acc, T0 + 2 * H, 98), 0);
  assert.strictEqual(blockedUntil({ limitedUntil: T0 + 5 }, T0, 98), T0 + 5);
  assert.strictEqual(blockedUntil({}, T0, 98), 0);
});

test('pickNext rotates in list order and skips limited accounts', () => {
  const free = { usage: {} };
  const full = { usage: { five_hour: { pct: 100, resetsAt: T0 + H } } };
  const list = [{ name: 'a', ...free }, { name: 'b', ...full }, { name: 'c', ...free }];
  assert.strictEqual(pickNext(list, 'a', T0, 98).name, 'c');
  assert.strictEqual(pickNext(list, 'c', T0, 98).name, 'a');
  assert.strictEqual(pickNext([{ name: 'a' }, { name: 'b', ...full }], 'a', T0, 98), null);
});

test('keychainService matches Claude Code naming', () => {
  assert.strictEqual(keychainService(), 'Claude Code-credentials');
  assert.match(keychainService('/tmp/x'), /^Claude Code-credentials-[0-9a-f]{8}$/);
});

test('add + auto: switches only claudeAiOauth and oauthAccount, keeps everything else', async () => {
  const { m, store, P } = setup({ a: { five_hour: win(100, 2), seven_day: win(50, 40) }, b: { five_hour: win(10, 3), seven_day: win(20, 50) } });
  await m.add('a');
  // second account arrives as if signed in elsewhere
  store.writeProfile('b', { claudeAiOauth: tok('b') });
  const s = m._load();
  s.accounts.push({ name: 'b', uuid: 'uuid-b', email: 'b@x.test', oauthAccount: { accountUuid: 'uuid-b', emailAddress: 'b@x.test' } });
  fs.writeFileSync(P.state, JSON.stringify(s));

  const r = await m.auto({ reason: 'prompt', force: true });
  assert.strictEqual(r.switched, true);
  assert.strictEqual(r.to, 'b');
  assert.strictEqual(store.current.claudeAiOauth.accessToken, 'at-b');
  assert.deepStrictEqual(store.current.mcpOAuth, { figma: { token: 'keep-me' } });
  const g = JSON.parse(fs.readFileSync(P.globalConfig, 'utf8'));
  assert.strictEqual(g.oauthAccount.accountUuid, 'uuid-b');
  assert.strictEqual(g.theme, 'dark');
  assert.deepStrictEqual(g.projects, { a: 1 });
});

test('auto keeps the account when it is under the threshold', async () => {
  const { m, store, P } = setup({ a: { five_hour: win(97, 2), seven_day: win(90, 40) }, b: {} });
  await m.add('a');
  store.writeProfile('b', { claudeAiOauth: tok('b') });
  const s = m._load();
  s.accounts.push({ name: 'b', uuid: 'uuid-b' });
  fs.writeFileSync(P.state, JSON.stringify(s));
  const r = await m.auto({ reason: 'manual' });
  assert.strictEqual(r.switched, false);
  assert.strictEqual(r.active, 'a');
  assert.strictEqual(store.current.claudeAiOauth.accessToken, 'at-a');
});

test('rotated tokens are saved back to the right profile before switching away', async () => {
  const { m, store, P } = setup({ a: { five_hour: win(30, 2) } });
  await m.add('a');
  // Claude Code refreshed: new tokens for the same account
  store.current.claudeAiOauth = tok('a-2');
  store.current.claudeAiOauth.accessToken = 'at-a-2';
  const acc = await m.sync();
  assert.strictEqual(acc.name, 'a');
  assert.strictEqual(store.readProfile('a').claudeAiOauth.refreshToken, 'rt-a-2');
  assert.ok(fs.existsSync(P.state));
});

test('rate_limit marks the account even when usage does not show it yet; all-limited reports the first reset', async () => {
  const { m, store, P } = setup({ a: { five_hour: win(50, 2) }, b: { five_hour: win(100, 4) } });
  await m.add('a');
  store.writeProfile('b', { claudeAiOauth: tok('b') });
  const s = m._load();
  s.accounts.push({ name: 'b', uuid: 'uuid-b', email: 'b@x.test' });
  fs.writeFileSync(P.state, JSON.stringify(s));
  const r = await m.auto({ reason: 'rate_limit' });
  assert.strictEqual(r.switched, false);
  assert.match(r.message, /All Claude accounts are at their limit/);
  assert.strictEqual(store.current.claudeAiOauth.accessToken, 'at-a');
});

test('prompt checks are throttled', async () => {
  const { m, store, P, api } = setup({ a: {}, b: {} });
  await m.add('a');
  store.writeProfile('b', { claudeAiOauth: tok('b') });
  const s = m._load();
  s.accounts.push({ name: 'b', uuid: 'uuid-b' });
  fs.writeFileSync(P.state, JSON.stringify(s));
  await m.auto({ reason: 'prompt' });
  const n = api.calls.length;
  await m.auto({ reason: 'prompt' });
  assert.strictEqual(api.calls.length, n);
});

test('add refuses the same account under a second name', async () => {
  const { m } = setup({});
  await m.add('a');
  await assert.rejects(m.add('other'), /already saved as "a"/);
  await assert.rejects(m.add('Bad Name'), /account name/);
});
