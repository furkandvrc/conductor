'use strict';
// USD per 1M tokens. Cache writes are priced from the input rate: 5-minute TTL = 1.25×, 1-hour TTL = 2×.
// Source: Anthropic API list prices (claude-api reference, cached 2026-10-06). Users can override any row
// from the dashboard (Settings → Pricing); overrides live in ~/.config/conductor/pricing.json.
const fs = require('fs');

const PRICING_DEFAULT = Object.freeze({
  'claude-fable-5-1': { in: 10, out: 50, cr: 0.25 },
  'claude-mythos-5-1': { in: 10, out: 50, cr: 0.25 },
  'claude-fable-5': { in: 10, out: 50, cr: 1.0 },
  'claude-mythos-5': { in: 10, out: 50, cr: 1.0 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cr: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cr: 0.5 },
  'claude-opus-4-7': { in: 5, out: 25, cr: 0.5 },
  'claude-opus-4-6': { in: 5, out: 25, cr: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.2 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, cr: 0.3 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01 },
  'claude-haiku-5-5@long': { in: 0.5, out: 2.5, cr: 0.05 }, // prompts over 100K tokens
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1 },
});

function loadPricing(file) {
  let over = {};
  try { over = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  return { ...PRICING_DEFAULT, ...over };
}

// Exact id first, then the longest known prefix (so "claude-opus-5-5-xyz" prices as Opus 5.5).
function priceFor(model, table) {
  if (table[model]) return table[model];
  let best = null;
  for (const k of Object.keys(table)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? table[best] : null;
}

// v = [input, output, cacheWrite5m, cacheWrite1h, cacheRead]; speed 'f' = fast mode (2× standard).
function cost(v, model, speed, table) {
  const p = priceFor(model, table);
  if (!p) return null;
  const m = speed === 'f' ? 2 : 1;
  return (m * (v[0] * p.in + v[1] * p.out + v[2] * p.in * 1.25 + v[3] * p.in * 2 + v[4] * p.cr)) / 1e6;
}

module.exports = { PRICING_DEFAULT, loadPricing, priceFor, cost };
