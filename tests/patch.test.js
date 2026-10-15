'use strict';
// scripts/patch-pixel-agents.py against a minimal fake Pixel Agents build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'patch-pixel-agents.py');
const WEBVIEW = [
  'var x=1;',
  'addAgent(e,t,n,r,i,a,o){if(this.characters.has(e))return;}',
  'let d=a.state===R.TYPE?6:0,f=p.toScreenX(a.x),g=p.toScreenY(a.y+d-32);',
  'return(0,E.jsxs)(`div`,{className:`absolute flex`,style:{left:f,top:g-(O?34:28),pointerEvents:`none`},children:[',
  '(0,E.jsx)(`span`,{className:`x`,children:y}),a.folderName&&(0,E.jsx)(`span`,{className:`text-2xs leading-none overflow-hidden text-ellipsis block`,children:a.folderName})]});',
].join('');
const SERVER = '#!/usr/bin/env node\nlet e=(0,si.default)({logger:!t.embedded,bodyLimit:Kn});';

function fixture() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dist-'));
  fs.mkdirSync(path.join(dist, 'webview', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'webview', 'assets', 'index-abc.js'), WEBVIEW);
  fs.writeFileSync(path.join(dist, 'cli.js'), SERVER);
  return dist;
}
const run = (dist, cwd, env = {}) => spawnSync('python3', ['-I', SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, CONDUCTOR_PIXEL_DIST: dist, ...env } });

test('patch: all four changes land in the bundle, idempotently, and nothing is written elsewhere', () => {
  const dist = fixture(), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cwd-'));
  const r1 = run(dist, cwd, { CONDUCTOR_OFFICE_WORKERS: 'Gemini,Local' });
  assert.equal(r1.status, 0, r1.stderr);
  const web = fs.readFileSync(path.join(dist, 'webview', 'assets', 'index-abc.js'), 'utf8');
  assert.match(web, /^\/\*conductor-patch\*\/var __cName=f=>\["Gemini", "Local"\]/);
  assert.match(web, /children:__cName\(a\.folderName\)\}\),__cAlert\(y\)&&/, 'labels');
  assert.match(web, /addAgent\(e,t,n,r,i,a,o\)\{if\(__cHide\(a\)\)return;/, 'hidden sessions');
  assert.match(web, /top:\(a\.bubbleType\?p\.toScreenY\(a\.y\+d-50\):g\)-\(/, 'label lifted above bubbles');
  assert.match(fs.readFileSync(path.join(dist, 'cli.js'), 'utf8'), /bodyLimit:16777216\}/, 'server body limit');
  assert.ok(fs.existsSync(path.join(dist, 'cli.js.orig')) && fs.existsSync(path.join(dist, 'webview', 'assets', 'index-abc.js.orig')));
  assert.deepEqual(fs.readdirSync(cwd), [], 'no stray files in the working directory');
  const r2 = run(dist, cwd, { CONDUCTOR_OFFICE_WORKERS: 'Gemini,Local' });
  assert.match(r2.stdout, /server: up to date/); assert.match(r2.stdout, /up to date \(labels, hide, bubbles\)/);
});

test('patch: unknown markup is left alone', () => {
  const dist = fixture();
  fs.writeFileSync(path.join(dist, 'webview', 'assets', 'index-abc.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'cli.js'), 'nothing here');
  const r = run(dist, os.tmpdir());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not recognised/);
});
