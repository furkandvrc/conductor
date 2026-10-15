'use strict';
// Settings files under ~/.config/conductor. conductor.env and local.env are sourced by bash
// (bin/delegate), so every value is validated against a strict character set and written
// single-quoted; a value can never contain a quote, backslash, backtick, $ or whitespace.
const fs = require('fs');

const MODEL_RE = /^[A-Za-z0-9._:\/@+-]{0,120}$/;
const SAFE_RE = /^[^\s'"\\`$]{0,400}$/;

const CONDUCTOR_KEYS = {
  CONDUCTOR_MODEL_GEMINI: v => MODEL_RE.test(v),
  CONDUCTOR_MODEL_CURSOR: v => MODEL_RE.test(v),
  CONDUCTOR_MODEL_COPILOT: v => MODEL_RE.test(v),
  CONDUCTOR_TIMEOUT: v => v === '' || (/^\d+$/.test(v) && +v >= 30 && +v <= 7200),
  CONDUCTOR_MAX_LINES: v => v === '' || (/^\d+$/.test(v) && +v >= 10 && +v <= 500),
  CONDUCTOR_PIXEL: v => v === '' || v === '0' || v === '1',
  CONDUCTOR_PANEL_AUTOSTART: v => v === '' || v === '0' || v === '1',
  CONDUCTOR_OFFICE_AUTOSTART: v => v === '' || v === '0' || v === '1',
  CONDUCTOR_BUDGET_DAILY: v => v === '' || /^\d{1,7}(\.\d{1,4})?$/.test(v),
  CONDUCTOR_BUDGET_MONTHLY: v => v === '' || /^\d{1,7}(\.\d{1,4})?$/.test(v),
  CONDUCTOR_ORCHESTRATOR: v => v === '' || /^(auto|claude|codex|antigravity|gemini|cursor|copilot|opencode|qwen)$/.test(v),
  CONDUCTOR_OFFICE_HIDE: v => v === '' || /^[A-Za-z0-9._,-]{1,200}$/.test(v),
};

function readEnv(file) {
  const o = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return o; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) v = v.slice(1, -1);
    o[m[1]] = v;
  }
  return o;
}

function writeEnv(file, obj, header) {
  const lines = [header];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (!SAFE_RE.test(String(v))) throw new Error(`refusing unsafe value for ${k}`);
    lines.push(`${k}='${v}'`);
  }
  fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  fs.chmodSync(file, 0o600);
}

// Each error is { field, code } so the UI can translate it.
function applyConductor(file, patch) {
  const errors = [];
  const cur = readEnv(file);
  for (const [k, v] of Object.entries(patch || {})) {
    const s = String(v ?? '').trim();
    if (!CONDUCTOR_KEYS[k]) errors.push({ field: k, code: 'unknown_field' });
    else if (!CONDUCTOR_KEYS[k](s)) errors.push({ field: k, code: 'invalid' });
    else cur[k] = s;
  }
  if (!errors.length) writeEnv(file, cur, '# conductor settings (edited from the dashboard)');
  return errors;
}

function applyPricing(file, patch) {
  const errors = [], out = {};
  for (const [model, p] of Object.entries(patch || {})) {
    if (!MODEL_RE.test(model) || !model) { errors.push({ field: model, code: 'invalid_model' }); continue; }
    const nums = ['in', 'out', 'cr'].map(k => Number(p && p[k]));
    if (nums.some(n => !isFinite(n) || n < 0 || n > 10000)) { errors.push({ field: model, code: 'invalid_price' }); continue; }
    out[model] = { in: nums[0], out: nums[1], cr: nums[2] };
  }
  if (!errors.length) fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return errors;
}

module.exports = { readEnv, writeEnv, applyConductor, applyPricing, CONDUCTOR_KEYS, MODEL_RE, SAFE_RE };
