'use strict';
// Conductor settings, shared by `delegate`, the dashboard and the hooks.
//   ~/.config/conductor/conductor.env   general switches (KEY='value')
//   ~/.config/conductor/workers.json    per-worker enabled/model/goodAt + custom CLI adapters
//   ~/.config/conductor/endpoints.json  OpenAI-compatible endpoints (with secrets; mode 600)
// The JSON files are never sourced by a shell, so they only need structural validation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readEnv } = require('../dashboard/lib/config');
const { ADAPTERS, customAdapter, endpointAdapter } = require('./registry');

const HOME = os.homedir();
const CONF = process.env.CONDUCTOR_CONFIG_DIR || path.join(HOME, '.config', 'conductor');
const STATE = process.env.CONDUCTOR_HOME || path.join(HOME, '.claude', 'conductor');
const P = {
  conf: CONF, state: STATE,
  env: process.env.CONDUCTOR_CONFIG || path.join(CONF, 'conductor.env'),
  workers: path.join(CONF, 'workers.json'),
  endpoints: path.join(CONF, 'endpoints.json'),
  legacyLocal: process.env.CONDUCTOR_LOCAL_ENV || path.join(CONF, 'local.env'),
  logs: path.join(STATE, 'logs'),
  runs: path.join(STATE, 'runs.jsonl'),
  agents: path.join(STATE, 'agents'),
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/;
const MODEL_RE = /^[A-Za-z0-9._:\/@+-]{0,120}$/;
const SECRET_RE = /^[^\s]{0,500}$/;
const URL_RE = /^https?:\/\/[^\s'"`]{1,300}$/;
const TEXT_RE = /^[^\n\r\t]{0,200}$/;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  fs.chmodSync(file, 0o600);
}

function general() { return readEnv(P.env); }

function workersConfig() {
  const w = readJson(P.workers, {}) || {};
  return { workers: w.workers && typeof w.workers === 'object' ? w.workers : {}, custom: Array.isArray(w.custom) ? w.custom : [] };
}

// endpoints.json, migrating the single-endpoint local.env of 0.2.x the first time it is read
function endpoints() {
  const e = readJson(P.endpoints, null);
  if (e && Array.isArray(e.endpoints)) return e.endpoints;
  const l = readEnv(P.legacyLocal);
  if (!l.LOCAL_URL) return [];
  const migrated = [{ id: 'local', label: 'Local', url: l.LOCAL_URL, model: l.LOCAL_MODEL || '', apiKey: l.LOCAL_API_KEY || '', cfId: l.CF_ACCESS_CLIENT_ID || '', cfSecret: l.CF_ACCESS_CLIENT_SECRET || '' }];
  try {
    writeJson(P.endpoints, { endpoints: migrated });
    // keep a single copy of the secret: drop local.env once endpoints.json has it
    if (readJson(P.endpoints, {}).endpoints?.[0]?.url === l.LOCAL_URL) fs.unlinkSync(P.legacyLocal);
  } catch {}
  return migrated;
}

function validateEndpoint(e) {
  const errors = [];
  if (!ID_RE.test(e.id || '')) errors.push({ field: 'id', code: 'invalid' });
  if (ADAPTERS.some(a => a.id === e.id || a.aliases.includes(e.id))) errors.push({ field: 'id', code: 'reserved' });
  if (e.label && !LABEL_RE.test(e.label)) errors.push({ field: 'label', code: 'invalid' });
  if (!URL_RE.test(e.url || '')) errors.push({ field: 'url', code: 'invalid' });
  if (!MODEL_RE.test(e.model || '')) errors.push({ field: 'model', code: 'invalid' });
  for (const k of ['apiKey', 'cfId', 'cfSecret']) if (e[k] != null && !SECRET_RE.test(e[k])) errors.push({ field: k, code: 'invalid_chars' });
  if (e.goodAt && !TEXT_RE.test(e.goodAt)) errors.push({ field: 'goodAt', code: 'invalid' });
  return errors;
}

// Upsert one endpoint. Secret fields: undefined/'' keep the stored value, null clears it.
function saveEndpoint(input) {
  const list = endpoints();
  const prev = list.find(x => x.id === (input.originalId || input.id)) || {};
  const next = { id: input.id, label: input.label || '', url: (input.url || '').trim(), model: (input.model || '').trim(), goodAt: input.goodAt || '' };
  for (const k of ['apiKey', 'cfId', 'cfSecret']) next[k] = input[k] === null ? '' : (input[k] ? String(input[k]).trim() : prev[k] || '');
  const errors = validateEndpoint(next);
  if (list.some(x => x.id === next.id && x.id !== (input.originalId || input.id))) errors.push({ field: 'id', code: 'duplicate' });
  if (errors.length) return errors;
  const out = list.filter(x => x.id !== (input.originalId || input.id));
  out.push(next);
  writeJson(P.endpoints, { endpoints: out });
  return [];
}
function deleteEndpoint(id) { writeJson(P.endpoints, { endpoints: endpoints().filter(x => x.id !== id) }); }

function saveWorker(id, patch) {
  const errors = [];
  const cfg = workersConfig();
  const cur = cfg.workers[id] || {};
  if (patch.enabled != null) { if (typeof patch.enabled !== 'boolean') errors.push({ field: 'enabled', code: 'invalid' }); else cur.enabled = patch.enabled; }
  if (patch.model != null) { if (!MODEL_RE.test(patch.model)) errors.push({ field: 'model', code: 'invalid' }); else cur.model = patch.model.trim(); }
  if (patch.goodAt != null) { if (!TEXT_RE.test(patch.goodAt)) errors.push({ field: 'goodAt', code: 'invalid' }); else cur.goodAt = patch.goodAt.trim(); }
  if (!errors.length) { cfg.workers[id] = cur; writeJson(P.workers, cfg); }
  return errors;
}

// Every worker Conductor knows about, with the user's overrides applied.
function allWorkers() {
  const cfg = workersConfig(), env = general();
  const legacyModel = { gemini: env.CONDUCTOR_MODEL_GEMINI, cursor: env.CONDUCTOR_MODEL_CURSOR, copilot: env.CONDUCTOR_MODEL_COPILOT };
  const list = [
    ...ADAPTERS,
    ...cfg.custom.filter(c => c && ID_RE.test(c.id || '') && c.cmd && !ADAPTERS.some(a => a.id === c.id)).map(customAdapter),
    ...endpoints().filter(e => ID_RE.test(e.id || '')).map(endpointAdapter),
  ];
  return list.map(a => {
    const o = cfg.workers[a.id] || {};
    return { ...a, enabled: o.enabled !== false, model: o.model || legacyModel[a.id] || a.defaultModel || '', goodAt: o.goodAt || a.goodAt };
  });
}

function findWorker(name) {
  const all = allWorkers();
  return all.find(w => w.id === name) || all.find(w => (w.aliases || []).includes(name)) || null;
}

const safeLabel = l => String(l || '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 24) || 'Worker';

module.exports = { P, general, workersConfig, endpoints, saveEndpoint, deleteEndpoint, saveWorker, allWorkers, findWorker, validateEndpoint, writeJson, readJson, safeLabel, ID_RE, LABEL_RE, MODEL_RE };
