'use strict';
// Worker registry, settings and the delegate core. Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// isolate every file the code touches before requiring it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-w-'));
process.env.CONDUCTOR_CONFIG_DIR = path.join(tmp, 'conf');
process.env.CONDUCTOR_HOME = path.join(tmp, 'state');
process.env.CONDUCTOR_LOCAL_ENV = path.join(tmp, 'conf', 'local.env');
process.env.CONDUCTOR_CONFIG = path.join(tmp, 'conf', 'conductor.env');
fs.mkdirSync(process.env.CONDUCTOR_CONFIG_DIR, { recursive: true });

const R = require('../lib/registry');
const S = require('../lib/settings');
const D = require('../lib/delegate');

const job = { prompt: 'TASK', model: 'm1', dir: '/repo', timeout: 300, outFile: '/tmp/out' };
const build = (id, write) => R.findBuiltin(id).build({ ...job, write });

test('registry: every built-in is read-only by default and can write on request', () => {
  const ro = { gemini: ['--mode', 'accept-edits'], cursor: ['--mode', 'ask'], codex: ['-s', 'read-only'], claude: ['Edit'], 'gemini-cli': ['default'], opencode: ['--agent', 'plan'], qwen: ['default'] };
  assert.ok(!build('gemini', false).args.includes('accept-edits'));
  assert.ok(build('gemini', true).args.includes('accept-edits'));
  assert.ok(build('cursor', false).args.includes('ask') && !build('cursor', true).args.includes('ask'));
  assert.deepEqual(build('copilot', false).args.slice(-2), ['--deny-tool', 'write']);
  assert.deepEqual(build('copilot', true).args.slice(-2), ['--allow-tool', 'write']);
  assert.ok(build('codex', false).args.includes('read-only') && build('codex', true).args.includes('workspace-write'));
  assert.ok(build('claude', false).args.includes('Edit') && build('claude', true).args.includes('acceptEdits'));
  assert.ok(build('opencode', false).args.includes('plan') && !build('opencode', true).args.includes('plan'));
  assert.ok(Object.keys(ro).length);
});

test('registry: prompt routing (stdin vs argument) and output file', () => {
  const c = build('codex', false);
  assert.equal(c.stdin, 'TASK'); assert.equal(c.outFile, '/tmp/out'); assert.equal(c.args.at(-1), '-');
  assert.equal(build('claude', false).stdin, 'TASK');
  assert.ok(build('claude', false).args.includes('--safe-mode'), 'claude worker runs isolated from user hooks/plugins');
  assert.ok(build('cursor', false).args.includes('TASK'));
  assert.ok(build('gemini', false).args.at(-1).endsWith('TASK'), 'agy gets the no-shell preamble + prompt');
});

test('registry: custom CLI placeholders are substituted per argument, never through a shell', () => {
  const a = R.customAdapter({ id: 'aider', cmd: 'aider', args: ['--message', '{prompt}', '--model', '{model}'], readArgs: ['--dry-run'], writeArgs: ['--yes'] });
  const b = a.build({ prompt: 'x; rm -rf /', model: '', dir: '/r', write: false });
  assert.deepEqual(b.args, ['--message', 'x; rm -rf /', '--dry-run'], 'model args dropped when no model; prompt stays one argv item');
  assert.deepEqual(a.build({ prompt: 'p', model: 'gpt', dir: '/r', write: true }).args, ['--message', 'p', '--model', 'gpt', '--yes']);
});

test('settings: legacy local.env migrates to endpoints.json', () => {
  fs.writeFileSync(process.env.CONDUCTOR_LOCAL_ENV, "LOCAL_URL='https://llm.example.com/v1'\nLOCAL_MODEL='m'\nLOCAL_API_KEY='k1'\n");
  const eps = S.endpoints();
  assert.equal(eps.length, 1);
  assert.equal(eps[0].id, 'local'); assert.equal(eps[0].apiKey, 'k1');
  assert.ok(!fs.existsSync(process.env.CONDUCTOR_LOCAL_ENV), 'the secret is not left behind in local.env');
  assert.ok(fs.existsSync(path.join(process.env.CONDUCTOR_CONFIG_DIR, 'endpoints.json')));
  assert.equal((fs.statSync(path.join(process.env.CONDUCTOR_CONFIG_DIR, 'endpoints.json')).mode & 0o777).toString(8), '600');
});

test('settings: endpoint validation, secrets kept on blank and cleared on null', () => {
  assert.ok(S.saveEndpoint({ id: 'codex', url: 'http://x' }).some(e => e.code === 'reserved'));
  assert.ok(S.saveEndpoint({ id: 'Bad Id', url: 'http://x' }).length);
  assert.ok(S.saveEndpoint({ id: 'lm', url: 'javascript:alert(1)' }).length);
  assert.deepEqual(S.saveEndpoint({ id: 'lm', label: 'LM Studio', url: 'http://localhost:1234', apiKey: 's3' }), []);
  S.saveEndpoint({ id: 'lm', url: 'http://localhost:1234', apiKey: '' });
  assert.equal(S.endpoints().find(e => e.id === 'lm').apiKey, 's3');
  S.saveEndpoint({ id: 'lm', url: 'http://localhost:1234', apiKey: null });
  assert.equal(S.endpoints().find(e => e.id === 'lm').apiKey, '');
  S.deleteEndpoint('lm');
  assert.ok(!S.endpoints().some(e => e.id === 'lm'));
});

test('settings: per-worker overrides and disabling', () => {
  assert.deepEqual(S.saveWorker('cursor', { model: 'gpt-5.3-codex', goodAt: 'edits' }), []);
  assert.ok(S.saveWorker('cursor', { model: 'bad model;' }).length);
  const w = S.findWorker('cursor-agent');
  assert.equal(w.id, 'cursor'); assert.equal(w.model, 'gpt-5.3-codex'); assert.equal(w.goodAt, 'edits');
  S.saveWorker('cursor', { enabled: false });
  assert.equal(S.findWorker('cursor').enabled, false);
});

test('delegate: argument parsing', () => {
  const o = D.parseArgs(['cursor', '--write', '--model', 'x', '--timeout', '60', 'fix', 'the', 'bug'], {});
  assert.equal(o.worker, 'cursor'); assert.equal(o.write, true); assert.equal(o.model, 'x'); assert.equal(o.timeout, 60); assert.equal(o.task, 'fix the bug');
  assert.equal(D.parseArgs(['local', '--', '--not-a-flag'], {}).task, '--not-a-flag');
  assert.throws(() => D.parseArgs(['cursor', '--model'], {}));
  assert.throws(() => D.parseArgs(['cursor', '--bogus'], {}));
  assert.equal(D.parseArgs(['x', 't'], { CONDUCTOR_TIMEOUT: '120' }).timeout, 120);
});

test('delegate: report keeps the REPORT section when output is long', () => {
  const out = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n## REPORT\ndid things';
  const r = D.report(out, 20);
  assert.ok(r.text.startsWith('## REPORT')); assert.match(r.note, /REPORT/);
  assert.equal(D.report('short', 20).note, '');
  assert.equal(D.reportSection('blah\n## REPORT\n done '), 'done');
});

test('delegate: the orchestrator host is excluded from its own worker list', () => {
  S.saveWorker('cursor', { enabled: true });
  const ids = host => D.usableFor(host).map(w => w.id);
  const all = ids('');
  for (const [host, worker] of [['claude', 'claude'], ['codex', 'codex']]) {
    if (all.includes(worker)) assert.ok(!ids(host).includes(worker), `${host} must not delegate to itself`);
  }
});
