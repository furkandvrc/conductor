'use strict';
// The "local" worker: any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp server,
// OpenRouter, …), optionally behind a bearer key and/or Cloudflare Access service token.
const { readEnv } = require('./config');

function endpoint(file) {
  const l = readEnv(file);
  if (!l.LOCAL_URL) return null;
  const headers = { Accept: 'application/json' };
  if (l.LOCAL_API_KEY) headers.Authorization = 'Bearer ' + l.LOCAL_API_KEY;
  if (l.CF_ACCESS_CLIENT_ID) {
    headers['CF-Access-Client-Id'] = l.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = l.CF_ACCESS_CLIENT_SECRET || '';
  }
  return { base: l.LOCAL_URL.replace(/\/+$/, '').replace(/\/v1$/, ''), headers, model: l.LOCAL_MODEL || '' };
}

// GET <base>/v1/models → { ok, status, ms, models[], message }
async function listModels(file, timeoutMs = 8000) {
  const ep = endpoint(file);
  if (!ep) return { ok: false, code: 'not_configured', models: [] };
  const t0 = Date.now();
  try {
    const r = await fetch(ep.base + '/v1/models', { headers: ep.headers, signal: AbortSignal.timeout(timeoutMs) });
    const txt = await r.text();
    let models = [];
    try { models = (JSON.parse(txt).data || []).map(m => m.id).filter(Boolean).sort(); } catch {}
    const blocked = !r.ok && /cloudflare/i.test(txt) && /blocked|attention required/i.test(txt);
    return {
      ok: r.ok, status: r.status, ms: Date.now() - t0, models,
      code: r.ok ? 'ok' : blocked ? 'cloudflare_blocked' : r.status === 401 || r.status === 403 ? 'unauthorized' : 'http_error',
      message: r.ok ? '' : txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, models: [], code: 'unreachable', message: String(e && e.message || e).slice(0, 160) };
  }
}

module.exports = { endpoint, listModels };
