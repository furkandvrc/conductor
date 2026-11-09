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
  const long = 'preamble\n## REPORT\nanswer first\n' + Array.from({ length: 50 }, (_, i) => `detail ${i}`).join('\n');
  const lr = D.report(long, 20);
  assert.ok(lr.text.startsWith('## REPORT\nanswer first')); assert.equal(lr.text.split('\n').length, 20);
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

test('settings: model pool is validated, deduplicated and kept with weight 0', () => {
  assert.ok(S.saveWorker('gemini', { pool: [{ model: 'a', weight: 101 }] }).length);
  assert.ok(S.saveWorker('gemini', { pool: [{ model: 'bad model', weight: 1 }] }).length);
  assert.ok(S.saveWorker('gemini', { pool: 'x' }).length);
  assert.deepEqual(S.saveWorker('gemini', { pool: [{ model: 'a', weight: 60 }, { model: 'b', weight: 0 }, { model: 'a', weight: 5 }] }), []);
  assert.deepEqual(S.findWorker('gemini').pool, [{ model: 'a', weight: 60 }, { model: 'b', weight: 0 }]);
  S.saveWorker('gemini', { pool: [] });
});

test('delegate: pool pick holds the configured ratios and skips switched-off models', () => {
  const w = { id: 'gemini', model: 'fallback', pool: [{ model: 'a', weight: 60 }, { model: 'b', weight: 30 }, { model: 'c', weight: 10 }, { model: 'off', weight: 0 }] };
  assert.equal(D.pickModel({ ...w, pool: [] }, []), 'fallback');
  assert.equal(D.pickModel({ ...w, pool: [{ model: 'x', weight: 0 }] }, []), 'fallback');
  const now = 1e9, runs = [], seen = {};
  for (let i = 0; i < 20; i++) { const m = D.pickModel(w, runs, now); seen[m] = (seen[m] || 0) + 1; runs.push({ worker: 'gemini', model: m, t: now }); }
  assert.deepEqual(seen, { a: 12, b: 6, c: 2 });
  // runs older than 14 days and other workers' runs do not count
  assert.equal(D.pickModel(w, [{ worker: 'gemini', model: 'a', t: now - 20 * 86400 }, { worker: 'cursor', model: 'a', t: now }], now), 'a');
});

test('delegate: brief reports by default, full on request', () => {
  assert.match(D.CONTRACT('/r', false), /STATUS: done \| partial \| failed/);
  assert.match(D.CONTRACT('/r', false), /under 120 words/);
  assert.match(D.CONTRACT('/r', false, 'full'), /at most 300 words/);
  assert.equal(D.parseArgs(['w', 't'], {}).maxLines, 30);
  assert.equal(D.parseArgs(['w', 't'], { CONDUCTOR_REPORT: 'full' }).maxLines, 60);
  assert.equal(D.parseArgs(['w', 't'], { CONDUCTOR_REPORT: 'full', CONDUCTOR_MAX_LINES: '45' }).maxLines, 45);
});

test('nudge hook: reminds after N inline reads, resets on delegate, silent when off or no workers', () => {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-n-')), conf = path.join(home, 'c.env');
  const env = { ...process.env, CONDUCTOR_HOME: home, CONDUCTOR_CONFIG: conf, CONDUCTOR_ROLE: '' };
  const hook = (payload) => spawnSync('bash', [path.join(__dirname, '..', 'scripts', 'nudge.sh')], { input: JSON.stringify(payload), env, encoding: 'utf8' }).stdout;
  const read = { session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } };
  const bash = cmd => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(hook(read), '', 'no workers file → silent');
  fs.writeFileSync(path.join(home, 'orchestrator-workers-claude.txt'), '- gemini: reading\n- codex: hard tasks\n');
  fs.writeFileSync(conf, "CONDUCTOR_DELEGATION='max'\n");
  for (let i = 0; i < 3; i++) assert.equal(hook(i % 2 ? bash('cd /r && cat a.js') : read), '');
  const out = JSON.parse(hook(bash('rtk grep -n x f')));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /4 inline file reads.*gemini, codex/);
  assert.equal(hook(bash('npm test')), '', 'non-read commands do not count');
  for (let i = 0; i < 3; i++) hook(read);
  hook(bash('delegate gemini "x"'));
  for (let i = 0; i < 3; i++) assert.equal(hook(read), '', 'counter restarts after a delegate call');
  fs.writeFileSync(conf, "CONDUCTOR_DELEGATION='off'\n");
  for (let i = 0; i < 10; i++) assert.equal(hook(read), '');
});

test('agy models: the "Fetching…" banner and error lines are not models', () => {
  const g = R.ADAPTERS.find(a => a.id === 'gemini');
  const out = 'Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\nNot signed in. Run agy to sign in\nError: request failed\n';
  const ids = out.split('\n').map(l => (l.match(g.listModels.re) || [])[1]).filter(Boolean);
  assert.deepStrictEqual(ids, ['gemini-4-argon-medium', 'claude-sonnet-5-5-low', 'gpt-oss-120b-medium']);
  assert.deepStrictEqual('Fetching available models...\nError: not logged in\n'.split('\n').map(l => (l.match(g.listModels.re) || [])[1]).filter(Boolean), []);
});

test('cursor, codex and opencode model listings ignore banners, warnings and errors', () => {
  const ad = id => R.ADAPTERS.find(a => a.id === id).listModels;
  const viaRe = (id, out) => out.split('\n').map(l => (l.match(ad(id).re) || [])[1]).filter(Boolean);
  assert.deepStrictEqual(viaRe('cursor', 'Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\nError: not logged in\nTip - run cursor-agent login\n'), ['auto', 'gpt-5.3-codex']);
  assert.deepStrictEqual(ad('codex').parse('WARN something\n{"models":[{"slug":"a","visibility":"list"},{"slug":"b","visibility":"hide"}]}\n'), ['a']);
  assert.deepStrictEqual(ad('codex').parse('Error: not signed in'), []);
  assert.deepStrictEqual(viaRe('opencode', 'opencode/big-pickle\nanthropic/claude-sonnet-5-5\nNo providers configured\n'), ['opencode/big-pickle', 'anthropic/claude-sonnet-5-5']);
});
