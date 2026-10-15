'use strict';
// Talk to an OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter, …),
// optionally behind a bearer key and/or a Cloudflare Access service token.

function headersFor(ep) {
  const h = { Accept: 'application/json' };
  if (ep.apiKey) h.Authorization = 'Bearer ' + ep.apiKey;
  if (ep.cfId) { h['CF-Access-Client-Id'] = ep.cfId; h['CF-Access-Client-Secret'] = ep.cfSecret || ''; }
  return h;
}
const baseOf = ep => String(ep.url || '').replace(/\/+$/, '').replace(/\/v1$/, '');

// GET <base>/v1/models → { ok, status, ms, models[], code, message }
async function listModels(ep, timeoutMs = 8000) {
  if (!ep || !ep.url) return { ok: false, code: 'not_configured', models: [] };
  const t0 = Date.now();
  try {
    const r = await fetch(baseOf(ep) + '/v1/models', { headers: headersFor(ep), signal: AbortSignal.timeout(timeoutMs) });
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

module.exports = { listModels, headersFor, baseOf };
