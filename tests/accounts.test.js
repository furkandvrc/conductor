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

// fake token endpoint: rotates the pair, records which refresh tokens were spent
function fakeRefresh() {
  let n = 0;
  const calls = [];
  const fn = async oauth => {
    calls.push(oauth.refreshToken);
    if (fn.fail) return { ok: false, status: fn.fail };
    n++;
    return { ok: true, body: { access_token: `${oauth.accessToken.replace(/-\d+$/, '')}-${n}`, refresh_token: `${oauth.refreshToken.replace(/-\d+$/, '')}-${n}`, expires_in: 8 * 3600, scope: 'user:inference user:profile' } };
  };
  fn.calls = calls;
  return fn;
}

function setup(usage, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-acc-'));
  const P = { stateDir: dir, state: path.join(dir, 'accounts.json'), profiles: path.join(dir, 'p'), globalConfig: path.join(dir, '.claude.json'), credFile: path.join(dir, 'cred.json') };
  const global = { theme: 'dark', projects: { a: 1 }, oauthAccount: { accountUuid: 'uuid-a', emailAddress: 'a@x.test' } };
  fs.writeFileSync(P.globalConfig, JSON.stringify(global));
  const store = memStore({ claudeAiOauth: tok('a'), mcpOAuth: { figma: { token: 'keep-me' } } });
  let t = T0;
  const api = fakeApi(usage);
  const refresh = fakeRefresh();
  const m = createManager({ env, paths: P, store, apiGet: api, refreshOAuth: refresh, now: () => t });
  return { m, store, P, api, refresh, usage, setNow: v => { t = v; } };
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

// a is the main account (first saved); b is the spare one
async function twoAccounts(usage, env) {
  const ctx = setup(usage, env);
  await ctx.m.add('a');
  ctx.store.writeProfile('b', { claudeAiOauth: tok('b') });
  const s = ctx.m._load();
  s.accounts.push({ name: 'b', uuid: 'uuid-b', email: 'b@x.test', oauthAccount: { accountUuid: 'uuid-b', emailAddress: 'b@x.test' } });
  fs.writeFileSync(ctx.P.state, JSON.stringify(s));
  return ctx;
}

test('pickNext goes to the main account first when it is free', () => {
  const list = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.strictEqual(pickNext(list, 'b', T0, 98).name, 'c');
  assert.strictEqual(pickNext(list, 'b', T0, 98, 'a').name, 'a');
  assert.strictEqual(pickNext(list, 'a', T0, 98, 'a').name, 'b');
});

test('goes back to the main account as soon as its window resets', async () => {
  const { m, store, setNow, usage } = await twoAccounts({ a: { five_hour: win(100, 2) }, b: { five_hour: win(10, 3) } });
  let r = await m.auto({ reason: 'manual' });
  assert.strictEqual(r.to, 'b');
  // a's token expired meanwhile: conductor refreshes it to read fresh usage
  store.writeProfile('a', { claudeAiOauth: tok('a', T0 + H) });
  setNow(T0 + H);
  r = await m.auto({ reason: 'manual' });
  assert.strictEqual(r.switched, false, 'main is still limited');
  setNow(T0 + 2 * H + 1);
  usage.a = {};
  r = await m.auto({ reason: 'manual' });
  assert.strictEqual(r.switched, true);
  assert.strictEqual(r.to, 'a');
  assert.match(r.message, /back to the main account/);
  assert.strictEqual(store.current.claudeAiOauth.refreshToken, store.readProfile('a').claudeAiOauth.refreshToken);
  assert.strictEqual(m._load().log.at(-1).reason, 'main');
});

test('an early reset of the main account is seen even after its token expired', async () => {
  const { m, store, refresh, setNow, usage } = await twoAccounts({ a: { five_hour: win(100, 4) }, b: { five_hour: win(10, 3) } });
  assert.strictEqual((await m.auto({ reason: 'manual' })).to, 'b');
  store.writeProfile('a', { ...store.readProfile('a'), claudeAiOauth: tok('a', T0 + H) });
  setNow(T0 + 2 * H); // a's token expired; its window says 4h but was reset early
  usage.a = { five_hour: win(0, 7) };
  const r = await m.auto({ reason: 'prompt' });
  assert.deepStrictEqual(refresh.calls, ['rt-a']);
  assert.strictEqual(r.to, 'a');
  const saved = store.readProfile('a').claudeAiOauth;
  assert.strictEqual(saved.refreshToken, 'rt-a-1');
  assert.strictEqual(saved.expiresAt, T0 + 2 * H + 8 * H);
  assert.deepStrictEqual(saved.scopes, ['user:inference', 'user:profile']);
  assert.strictEqual(store.current.claudeAiOauth.accessToken, 'at-a-1', 'Claude Code gets the refreshed pair');
  assert.deepStrictEqual(store.current.mcpOAuth, { figma: { token: 'keep-me' } });
});

test('the active account is never refreshed by conductor; refresh off and a signed-out account are reported', async () => {
  const { m, store, refresh, setNow, usage } = await twoAccounts({ a: { five_hour: win(10, 4) }, b: {} });
  store.current.claudeAiOauth = tok('a', T0 + H);
  store.writeProfile('a', { claudeAiOauth: tok('a', T0 + H) });
  setNow(T0 + 2 * H);
  await m.status({ refresh: true });
  assert.deepStrictEqual(refresh.calls, [], 'a is in use and b is still valid');

  store.writeProfile('b', { claudeAiOauth: tok('b', T0 + H) });
  refresh.fail = 400;
  let st = await m.status({ refresh: true });
  assert.deepStrictEqual(refresh.calls, ['rt-b']);
  assert.match(st.accounts.find(a => a.name === 'b').lastError, /signed out; run: claude-account login b/);
  assert.strictEqual(store.readProfile('b').claudeAiOauth.refreshToken, 'rt-b', 'a failed refresh leaves the saved pair alone');
  void usage;
});

test('CONDUCTOR_ACCOUNT_REFRESH=0 and a held lock both skip the refresh', async () => {
  const off = await twoAccounts({ a: {}, b: {} }, { CONDUCTOR_ACCOUNT_REFRESH: '0' });
  off.store.writeProfile('b', { claudeAiOauth: tok('b', T0 + H) });
  off.setNow(T0 + 2 * H);
  await off.m.status({ refresh: true });
  assert.deepStrictEqual(off.refresh.calls, []);

  const on = await twoAccounts({ a: {}, b: {} });
  on.store.writeProfile('b', { claudeAiOauth: tok('b', T0 + H) });
  on.setNow(T0 + 2 * H);
  fs.writeFileSync(path.join(on.P.stateDir, '.lock-b'), '');
  await on.m.status({ refresh: true });
  assert.deepStrictEqual(on.refresh.calls, [], 'another process holds b');
  fs.unlinkSync(path.join(on.P.stateDir, '.lock-b'));
  await on.m.status({ refresh: true });
  assert.deepStrictEqual(on.refresh.calls, ['rt-b']);
  assert.ok(!fs.existsSync(path.join(on.P.stateDir, '.lock-b')), 'lock released');
});

test('the background watch is throttled like prompts', async () => {
  const { m, api, setNow } = await twoAccounts({ a: { five_hour: win(10, 4) }, b: {} });
  await m.auto({ reason: 'watch' });
  const n = api.calls.length;
  setNow(T0 + 60e3);
  await m.auto({ reason: 'watch' });
  assert.strictEqual(api.calls.length, n);
  setNow(T0 + 6 * 60e3);
  await m.auto({ reason: 'watch' });
  assert.ok(api.calls.length > n);
});

test('a hand-picked account is kept until it hits its own limit', async () => {
  const { m, store, usage } = await twoAccounts({ a: { five_hour: win(10, 2) }, b: { five_hour: win(10, 3) } });
  await m.use('b');
  let r = await m.auto({ reason: 'manual' });
  assert.strictEqual(r.switched, false);
  assert.strictEqual(store.current.claudeAiOauth.accessToken, 'at-b');
  usage.b = { five_hour: win(100, 3) };
  r = await m.auto({ reason: 'manual' });
  assert.strictEqual(r.to, 'a');
});

test('CONDUCTOR_ACCOUNT_RETURN=0 stays on the account it moved to; primary can be changed', async () => {
  const { m, setNow, usage } = await twoAccounts({ a: { five_hour: win(100, 2) }, b: {} }, { CONDUCTOR_ACCOUNT_RETURN: '0' });
  assert.strictEqual((await m.auto({ reason: 'manual' })).to, 'b');
  setNow(T0 + 3 * H);
  usage.a = {};
  assert.strictEqual((await m.auto({ reason: 'manual' })).switched, false);
  m.setPrimary('b');
  const st = await m.status();
  assert.strictEqual(st.primary, 'b');
  assert.deepStrictEqual(st.accounts.map(a => a.primary), [false, true]);
  assert.throws(() => m.setPrimary('nope'), /no account/);
});

test('a limit stop from a session still on the old account does not mark the new one', async () => {
  const { m, setNow, usage } = await twoAccounts({ a: { five_hour: win(100, 2) }, b: { five_hour: win(10, 3) } });
  assert.strictEqual((await m.auto({ reason: 'manual' })).to, 'b');
  setNow(T0 + 60e3);
  let r = await m.auto({ reason: 'rate_limit' });
  assert.strictEqual(r.switched, false);
  assert.ok(!m._load().accounts.find(a => a.name === 'b').limitedUntil, 'b had room: not marked');
  // after the grace period a limit on b is believed even before usage shows it
  setNow(T0 + 11 * 60e3);
  usage.b = { five_hour: win(60, 3) };
  r = await m.auto({ reason: 'rate_limit' });
  assert.ok(m._load().accounts.find(a => a.name === 'b').limitedUntil > T0 + 11 * 60e3);
});

test('onLimitStop wakes a stopped session once when the account was switched, never in a loop', async () => {
  const { m, store, setNow } = await twoAccounts({ a: { five_hour: win(100, 2) }, b: { five_hour: win(10, 3) } });
  let r = await m.onLimitStop('sess-1');
  assert.strictEqual(r.resume, true);
  assert.match(r.message, /switched: a → b/);
  assert.match(r.wake, /Continue the task from where you left off/);
  assert.strictEqual(store.current.claudeAiOauth.accessToken, 'at-b');
  // the woken session stops on a limit again (it was still on a's token): no second wake
  setNow(T0 + 2 * 60e3);
  r = await m.onLimitStop('sess-1');
  assert.strictEqual(r.resume, false);
  assert.match(r.message, /\/exit, then claude --continue/);
  // another session that was on a gets its own wake
  r = await m.onLimitStop('sess-2');
  assert.strictEqual(r.resume, true);
  assert.match(r.message, /now b, which has room/);
  // ten minutes later the first session may be woken again
  setNow(T0 + 13 * 60e3);
  assert.strictEqual(m.claimResume('sess-1'), true);
  assert.strictEqual(m.claimResume(''), false);
});

test('onLimitStop: no wake when every account is limited or when resuming is off', async () => {
  const all = await twoAccounts({ a: { five_hour: win(100, 2) }, b: { five_hour: win(100, 4) } });
  let r = await all.m.onLimitStop('s');
  assert.strictEqual(r.resume, false);
  assert.match(r.message, /All Claude accounts are at their limit/);
  const off = await twoAccounts({ a: { five_hour: win(100, 2) }, b: {} }, { CONDUCTOR_ACCOUNT_RESUME: '0' });
  r = await off.m.onLimitStop('s');
  assert.strictEqual(r.resume, false);
  assert.match(r.message, /switched: a → b.*\/exit, then claude --continue/);
});
