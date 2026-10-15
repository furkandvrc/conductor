'use strict';
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cost, priceFor, PRICING_DEFAULT } = require('../dashboard/lib/pricing');
const { UsageIndex, projectName, repoName } = require('../dashboard/lib/usage');
const cfg = require('../dashboard/lib/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-test-'));
const line = (id, usage, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: extra.ts || new Date().toISOString(), cwd: extra.cwd || '/work/app', sessionId: extra.sid || 's1',
  isSidechain: !!extra.side, message: { id, model: extra.model || 'claude-opus-5-5', usage },
}) + '\n';

test('pricing: exact, prefix and unknown models', () => {
  assert.equal(priceFor('claude-opus-5-5', PRICING_DEFAULT).in, 4);
  assert.equal(priceFor('claude-opus-5-5-preview', PRICING_DEFAULT).in, 4, 'longest prefix wins over claude-opus-5');
  assert.equal(priceFor('gpt-x', PRICING_DEFAULT), null);
});

test('pricing: cost formula (input, output, cache 5m/1h, cache read, fast mode)', () => {
  const t = PRICING_DEFAULT;
  // 1M of each bucket on Opus 5.5: 4 + 20 + 5 + 8 + 0.2
  assert.equal(+cost([1e6, 1e6, 1e6, 1e6, 1e6], 'claude-opus-5-5', 's', t).toFixed(4), 37.2);
  assert.equal(+cost([1e6, 0, 0, 0, 0], 'claude-opus-5-5', 'f', t).toFixed(4), 8);
  assert.equal(cost([1, 1, 1, 1, 1], 'mystery-model', 's', t), null);
});

test('usage: repeated lines for one message id are counted once (max wins)', async () => {
  const dir = tmp(), proj = path.join(dir, 'projects', '-work-app');
  fs.mkdirSync(proj, { recursive: true });
  const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } };
  const u2 = { ...u1, output_tokens: 50 }; // a later block of the same message reports more output
  fs.writeFileSync(path.join(proj, 'a.jsonl'), line('m1', u1) + line('m1', u1) + line('m1', u2) + '{"type":"user"}\n' + 'not json\n');
  const ix = new UsageIndex({ projectsDir: path.join(dir, 'projects'), indexFile: path.join(dir, 'ix.json'), home: '/home/u' });
  await ix.scan();
  const r = ix.report(1, '', PRICING_DEFAULT);
  assert.equal(r.totals.msgs, 1);
  assert.equal(r.totals.in, 10);
  assert.equal(r.totals.out, 50);
  assert.equal(r.totals.cw, 200);
  assert.equal(r.totals.cr, 1000);
  assert.equal(r.byProject[0].key, 'app');
});

test('usage: incremental scan picks up appended lines and partial lines', async () => {
  const dir = tmp(), proj = path.join(dir, 'p');
  fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 'b.jsonl');
  const u = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 };
  const full = line('x1', u);
  fs.writeFileSync(f, full + full.slice(0, 20));               // second line cut mid-way
  const ix = new UsageIndex({ projectsDir: dir, indexFile: null, home: '/h' });
  await ix.scan();
  assert.equal(ix.report(1, '', PRICING_DEFAULT).totals.msgs, 1);
  fs.appendFileSync(f, full.slice(20) + line('x2', u));
  await ix.scan();
  // the completed second "x1" line is a duplicate; x2 is new
  assert.equal(ix.report(1, '', PRICING_DEFAULT).totals.msgs, 2);
});

test('usage: subagent (sidechain) cost is reported separately', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'c.jsonl'), line('a', { input_tokens: 1e6, output_tokens: 0 }) + line('b', { input_tokens: 1e6, output_tokens: 0 }, { side: true }));
  const ix = new UsageIndex({ projectsDir: dir, indexFile: null, home: '/h' });
  await ix.scan();
  const r = ix.report(1, '', PRICING_DEFAULT);
  assert.equal(+r.totals.cost.toFixed(2), 8);
  assert.equal(+r.subagents.cost.toFixed(2), 4);
});

test('projectName: basename, home, worktrees folded into their repo', () => {
  assert.equal(projectName('/Users/a/code/shop', '/Users/a'), 'shop');
  assert.equal(projectName('/Users/a', '/Users/a'), '~');
  assert.equal(projectName('/Users/a/code/shop/.claude/worktrees/feat-x', '/Users/a'), 'shop');
  assert.equal(projectName('/Users/a/code/store/.orchestrator/worktrees/backend-33', '/Users/a'), 'store');
  assert.equal(projectName('', '/h'), '(unknown)');
});

test('config: values that could break out of a sourced env file are rejected', () => {
  const dir = tmp(), f = path.join(dir, 'c.env');
  assert.deepEqual(cfg.applyConductor(f, { CONDUCTOR_TIMEOUT: '600' }), []);
  for (const bad of ['9; rm -rf /', "x'y", '$(id)', '`id`', 'a b']) {
    assert.ok(cfg.applyConductor(f, { CONDUCTOR_MODEL_CURSOR: bad }).length, `should reject ${bad}`);
  }
  assert.ok(cfg.applyConductor(f, { NOT_A_KEY: '1' }).length);
  assert.match(fs.readFileSync(f, 'utf8'), /CONDUCTOR_TIMEOUT='600'/);
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
});

test('config: local secrets are write-only, blank keeps, null clears', () => {
  const dir = tmp(), f = path.join(dir, 'l.env');
  assert.deepEqual(cfg.applyLocal(f, { LOCAL_URL: 'https://llm.example.com', LOCAL_API_KEY: 'sk-abc' }), []);
  assert.deepEqual(cfg.publicLocal(f), { LOCAL_URL: 'https://llm.example.com', LOCAL_MODEL: '', has_LOCAL_API_KEY: true, has_CF_ACCESS_CLIENT_ID: false, has_CF_ACCESS_CLIENT_SECRET: false });
  cfg.applyLocal(f, { LOCAL_API_KEY: '' });
  assert.equal(cfg.readEnv(f).LOCAL_API_KEY, 'sk-abc');
  cfg.applyLocal(f, { LOCAL_API_KEY: null });
  assert.equal(cfg.readEnv(f).LOCAL_API_KEY, undefined);
  assert.ok(cfg.applyLocal(f, { LOCAL_URL: 'javascript:alert(1)' }).length);
  assert.ok(cfg.applyLocal(f, { LOCAL_API_KEY: "a'b" }).length);
});

test('config: pricing overrides are validated', () => {
  const dir = tmp(), f = path.join(dir, 'p.json');
  assert.deepEqual(cfg.applyPricing(f, { 'claude-opus-6': { in: 3, out: 15, cr: 0.3 } }), []);
  assert.ok(cfg.applyPricing(f, { 'claude-opus-6': { in: -1, out: 1, cr: 1 } }).length);
  assert.ok(cfg.applyPricing(f, { 'bad model;': { in: 1, out: 1, cr: 1 } }).length);
});

test('repoName: subfolders and worktrees resolve to the repository', () => {
  const dir = tmp(), repo = path.join(dir, 'shop');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
  assert.equal(repoName(path.join(repo, 'packages', 'web'), dir), 'shop');
  const wt = path.join(dir, 'elsewhere', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/feat-x\n`);
  assert.equal(repoName(wt, dir), 'shop');
  assert.equal(repoName(path.join(dir, 'gone', 'app'), dir), 'app', 'missing dirs fall back to the folder name');
});
