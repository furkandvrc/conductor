'use strict';
// Quota and sign-in failures: delegate stops a worker early and says why; gen-image's agy watcher
// reads the subagent transcripts. Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-f-'));
process.env.CONDUCTOR_CONFIG_DIR = path.join(tmp, 'conf');
process.env.CONDUCTOR_HOME = path.join(tmp, 'state');
const D = require('../lib/delegate');

test('fatal lines: real quota, limit and sign-in messages from each CLI', () => {
  const limit = [
    'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h.","error_code":429}',
    'error: Individual quota reached. Please upgrade your subscription to increase your limits.',
    'ERROR: You’ve hit your usage limit. Upgrade to Plus to continue using Codex',
    "You've hit your 5-hour limit · resets 6:30pm (Europe/Istanbul)",
    'Claude AI usage limit reached|1794729237',
    'Error: Quota exceeded for quota metric generate_content_requests',
  ];
  for (const l of limit) assert.equal((D.fatalLine(l) || {}).kind, 'limit', l);
  for (const l of ['Invalid API key · Please run /login', 'Error: not logged in. Run cursor-agent login'])
    assert.equal((D.fatalLine(l) || {}).kind, 'auth', l);
});

test('fatal lines: code, diffs and prose about limits do not count', () => {
  for (const l of [
    '  const LIMIT_RE = /hit your (?:\\w+ )?limit|usage limit reached/i;',
    'The quota error handling lives in delegate.js; usage limit messages are matched',
    '- error: quota exceeded handling', '+ERROR: quota', 'errors: 3 quota tests failed',
  ]) assert.equal(D.fatalLine(l), null, l);
});

test('settle: a failed run with a limit line gets exit 6, a successful one keeps 0', () => {
  assert.equal(D.settle({ rc: 1, out: "You've hit your 5-hour limit · resets 2am", err: '' }).rc, 6);
  assert.equal(D.settle({ rc: 0, out: '', err: 'Error: not logged in' }).rc, 7);
  const ok = D.settle({ rc: 0, out: '## REPORT\nSTATUS: done', err: 'ERROR: usage limit warning at 90%' });
  assert.equal(ok.rc, 0); assert.equal(ok.fatal, null);
  assert.equal(D.settle({ rc: 1, out: '', err: 'segfault' }).rc, 1);
});

test('runCli: a CLI that prints a quota error and then hangs is stopped after the grace period', async () => {
  process.env.CONDUCTOR_FATAL_GRACE = '1';
  const script = 'process.stderr.write("AGY_ERROR: {\\"short_error\\":\\"RESOURCE_EXHAUSTED (code 429): Individual quota reached.\\"}\\n"); setTimeout(() => {}, 60000);';
  const t0 = Date.now();
  const res = D.settle(await D.runCli({}, { cmd: process.execPath, args: ['-e', script], cwd: tmp }, 60));
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  assert.equal(res.rc, 6);
  assert.equal(res.fatal.kind, 'limit');
});

test('agy_status.py: quota error in an image subagent, a finished run, a planner error', () => {
  const PY = path.join(__dirname, '..', 'scripts', 'agy_status.py');
  const brain = path.join(tmp, 'brain'), work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'err.log'), ''); fs.writeFileSync(path.join(work, 'events.ndjson'), '');
  const conv = (id, steps, subs = []) => {
    fs.mkdirSync(path.join(brain, id, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(brain, id, '.system_generated', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');
    for (const s of subs) fs.writeFileSync(path.join(brain, id, '.system_generated', 'subagents', `${s}.json`), JSON.stringify({ conversationId: s }));
  };
  const run = (...a) => spawnSync('python3', ['-I', PY, work, brain, ...a], { encoding: 'utf8' }).stdout.trim();

  conv('sub1', [{ type: 'GENERIC', status: 'ERROR', error: 'image failed to generate: 429 Too Many Requests, body: {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 2h16m11s.","status":"RESOURCE_EXHAUSTED"}}' }]);
  conv('p1', [{ type: 'USER_INPUT', status: 'DONE' }, { type: 'PLANNER_RESPONSE', content: 'launched', tool_calls: [{ name: 'invoke_subagent' }] }], ['sub1']);
  assert.equal(run('p1'), 'FATAL limit\tYou have exhausted your capacity on this model. Your quota will reset after 2h16m11s.');

  conv('sub2', [{ type: 'GENERIC', status: 'DONE' }]);
  conv('p2', [{ type: 'SYSTEM_MESSAGE', content: '[Message] sender=sub2 content=done' }, { type: 'PLANNER_RESPONSE', content: 'Saved icon.jpg' }], ['sub2']);
  assert.equal(run('p2'), 'DONE\tSaved icon.jpg');
  conv('p3', [{ type: 'PLANNER_RESPONSE', content: 'Waiting for it to finish.' }], ['sub2']);
  assert.equal(run('p3'), '', 'still waiting: no subagent has reported back');

  conv('sub4', [{ type: 'GENERIC', status: 'ERROR', error: 'image failed to generate: 429 Too Many Requests' }]);
  conv('p4', [{ type: 'PLANNER_RESPONSE', content: 'launched', tool_calls: [{}] }], ['sub4']);
  assert.match(run('p4'), /^FATAL limit\t/);

  fs.writeFileSync(path.join(work, 'err.log'), 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED"}\n');
  assert.equal(run(), 'FATAL limit\tRESOURCE_EXHAUSTED (code 429): Individual quota reached.');
});
