'use strict';
/* global t, LANG, LOCALE, setLang */
// ───────────────────────── helpers ─────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');
const tipEl = $('#tip');
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const real = xs => xs.flat(Infinity).filter(x => x != null && x !== false);
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
const NF = new Intl.NumberFormat(LOCALE);
const CF = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const usd = v => new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) < 1 && v !== 0 ? 3 : 2 }).format(v || 0);
const usdAxis = v => new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', maximumFractionDigits: v < 10 && v % 1 ? 1 : 0 }).format(v);
const tok = v => CF.format(v || 0);
const pct = v => isFinite(v) ? new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 }).format(v) : '–';
function dur(sec) {
  if (sec == null || isNaN(sec)) return '–';
  if (sec < 60) return t('dur.s', { s: Math.round(sec) });
  if (sec < 3600) return t('dur.m', { m: Math.floor(sec / 60), s: Math.round(sec % 60) });
  return t('dur.h', { h: Math.floor(sec / 3600), m: Math.round((sec % 3600) / 60) });
}
const dt = v => new Date(typeof v === 'number' ? v * 1000 : v).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayLabel = d => new Date(d + 'T12:00:00').toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
const dayTitle = d => new Date(d + 'T12:00:00').toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
function rel(v) {
  const sec = Date.now() / 1000 - (typeof v === 'number' ? v : new Date(v).getTime() / 1000);
  if (sec < 60) return t('time.now');
  if (sec < 3600) return t('time.min', { n: Math.floor(sec / 60) });
  if (sec < 86400) return t('time.hour', { n: Math.floor(sec / 3600) });
  return t('time.day', { n: Math.floor(sec / 86400) });
}
function localDay(ts) { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function lastDays(n) { const out = []; for (let i = n - 1; i >= 0; i--) out.push(localDay(Date.now() / 1000 - i * 86400)); return out; }
const fmtErrors = errs => (errs || []).map(e => typeof e === 'string' ? e : t('err.' + e.code, { field: e.field })).join(' · ');

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok && r.status !== 400) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-conductor': '1' }, body: JSON.stringify(body || {}) });

// ───────────────────────── identity & colors ─────────────────────────
// Categorical slots in fixed order per entity (validated reference palette, light and dark).
const MODEL_ORDER = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'];
const modelBase = m => m.replace(/@long$/, '');
const modelColor = m => { const i = MODEL_ORDER.indexOf(modelBase(m)); return i >= 0 ? `var(--s${i + 1})` : 'var(--sx)'; };
function modelName(m) {
  const long = m.endsWith('@long');
  const parts = modelBase(m).replace(/^claude-/, '').split('-');
  const fam = parts.shift() || m;
  return fam[0].toUpperCase() + fam.slice(1) + (parts.length ? ' ' + parts.join('.') : '') + (long ? ' (>100K)' : '');
}
const TOKEN_SERIES = () => [
  { key: 'in', label: t('tok.in'), color: 'var(--s1)' },
  { key: 'out', label: t('tok.out'), color: 'var(--s2)' },
  { key: 'cw', label: t('tok.cw'), color: 'var(--s3)' },
  { key: 'cr', label: t('tok.cr'), color: 'var(--s4)' },
];
// Worker identity: label + a categorical slot in fixed registry order (validated palette, 8 slots),
// filled from /api/workers. Unknown or overflow workers fall back to neutral grey.
let WK = {}, WK_ORDER = [];
function setWorkers(list) {
  WK = {}; WK_ORDER = [];
  const ranked = [...list.filter(w => w.enabled && w.available), ...list.filter(w => !(w.enabled && w.available))];
  ranked.forEach((w, i) => { WK[w.id] = { label: w.label, color: i < 8 ? `var(--s${i + 1})` : 'var(--sx)' }; WK_ORDER.push(w.id); });
}
const loadWorkers = async () => { const r = await api('/api/workers'); setWorkers(r.workers); return r.workers; };

// ───────────────────────── tooltip ─────────────────────────
function showTip(e, title, rows, total) {
  tipEl.replaceChildren(h('b', {}, title),
    ...rows.map(([label, color, value]) => h('div', { class: 'r' }, h('span', {}, h('i', { class: 'sw', style: `background:${color}` }), label), h('span', { class: 'num' }, value))),
    total != null ? h('div', { class: 'r tot' }, h('span', {}, t('common.total')), h('span', { class: 'num' }, total)) : '');
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}
const hideTip = () => { tipEl.hidden = true; };

// ───────────────────────── charts ─────────────────────────
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw) || 10 * mag;
  const out = []; for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toFixed(10));
  return out;
}
const legend = series => h('div', { class: 'legend' }, series.map(se => h('span', {}, h('i', { style: `background:${se.color}` }), se.label)));
function roundTop(x, y, w, hgt, r, fill) {
  r = Math.max(0, Math.min(r, w / 2, hgt));
  return s('path', { d: `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`, fill });
}
// Stacked columns: one per label, segments in series order (2px surface gap), rounded top, hover tooltip per column.
function stackedBars(el, cfg) {
  let lastW = 0;
  const draw = () => {
    const W = Math.max(280, el.clientWidth);
    if (W === lastW) return; lastW = W;
    el.replaceChildren();
    const H = cfg.height || 220, L = 56, R = 6, T = 8, B = 22;
    const n = cfg.labels.length, pw = W - L - R, ph = H - T - B, bw = pw / Math.max(1, n);
    const barW = Math.max(2, Math.min(26, bw * 0.68));
    const totals = cfg.labels.map((_, i) => cfg.series.reduce((a, se) => a + (cfg.data(i, se.key) || 0), 0));
    const ticks = niceTicks(Math.max(...totals, 0));
    const max = ticks[ticks.length - 1] || 1;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': cfg.aria || '' });
    for (const tk of ticks) {
      const y = T + ph - (tk / max) * ph;
      svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, class: tk === 0 ? 'bl' : 'gl' }));
      svg.append(s('text', { x: L - 8, y: y + 4, 'text-anchor': 'end', class: 'ax' }, cfg.axisFmt(tk)));
    }
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 56))));
    cfg.labels.forEach((lab, i) => {
      const cx = L + bw * i + bw / 2;
      const segs = cfg.series.map(se => ({ se, v: cfg.data(i, se.key) || 0 })).filter(g => g.v > 0);
      let y = T + ph;
      segs.forEach((g, j) => {
        const full = (g.v / max) * ph, gap = j > 0 ? 2 : 0, hh = Math.max(0, full - gap), yy = y - full;
        if (hh > 0) svg.append(j === segs.length - 1 ? roundTop(cx - barW / 2, yy, barW, hh, 4, g.se.color) : s('rect', { x: cx - barW / 2, y: yy + gap, width: barW, height: hh, fill: g.se.color }));
        y = yy;
      });
      if (i % every === 0) svg.append(s('text', { x: cx, y: H - 5, 'text-anchor': 'middle', class: 'ax' }, cfg.xfmt ? cfg.xfmt(lab) : lab));
      const hit = s('rect', { x: L + bw * i, y: T, width: bw, height: ph, class: 'hit' });
      hit.addEventListener('mousemove', e => showTip(e, cfg.xtitle ? cfg.xtitle(lab) : lab, segs.slice().reverse().map(g => [g.se.label, g.se.color, cfg.fmt(g.v)]), segs.length > 1 ? cfg.fmt(totals[i]) : null));
      hit.addEventListener('mouseleave', hideTip);
      svg.append(hit);
    });
    el.append(svg);
    const used = cfg.series.filter(se => cfg.labels.some((_, i) => (cfg.data(i, se.key) || 0) > 0));
    if (used.length > 1) el.append(legend(used));
    if (!used.length) el.append(h('div', { class: 'note' }, t('common.noData')));
  };
  draw();
  new ResizeObserver(() => draw()).observe(el);
}
function hbars(items, fmt, color = 'var(--s1)') {
  const max = Math.max(...items.map(i => i.value), 0) || 1;
  if (!items.length) return h('div', { class: 'empty' }, t('common.noData'));
  return h('div', { class: 'hbars' }, items.map(it => h('div', { class: 'hbar', title: `${it.label}: ${fmt(it.value)}` },
    h('span', { class: 'nm' }, it.label),
    h('span', { class: 'tr' }, h('i', { style: `width:${Math.max(1.5, it.value / max * 100)}%;background:${it.color || color}` })),
    h('span', { class: 'vl' }, fmt(it.value)))));
}
function stackLine(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return h('div', {},
    h('div', { class: 'stack', role: 'img', 'aria-label': parts.map(p => `${p.label} ${pct(p.value / total)}`).join(', ') },
      parts.filter(p => p.value > 0).map(p => h('i', { style: `width:${p.value / total * 100}%;background:${p.color}`, title: `${p.label}: ${tok(p.value)} (${pct(p.value / total)})` }))),
    h('div', { class: 'legend' }, parts.map(p => h('span', {}, h('i', { style: `background:${p.color}` }), `${p.label} · ${tok(p.value)} · ${pct(p.value / total)}`))));
}
// Sortable table. cols: {key,label,num?,fmt?,sortv?,nosort?}
function table(cols, rows, opts = {}) {
  let key = opts.sort || null, dir = opts.dir || -1;
  const wrap = h('div', { class: 'tw' });
  const draw = () => {
    const col = cols.find(c => c.key === key);
    const sorted = col ? [...rows].sort((a, b) => {
      const va = col.sortv ? col.sortv(a) : a[key], vb = col.sortv ? col.sortv(b) : b[key];
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    }) : rows;
    const shown = sorted.slice(0, opts.limit || 500);
    wrap.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, cols.map(c => h('th', {
        class: c.num ? 'n' : '', 'data-sort': c.nosort ? null : '1', scope: 'col', 'aria-sort': c.key === key ? (dir > 0 ? 'ascending' : 'descending') : null,
        onclick: c.nosort ? null : () => { if (key === c.key) dir = -dir; else { key = c.key; dir = c.num ? -1 : 1; } draw(); },
      }, c.label, c.key === key ? (dir > 0 ? ' ↑' : ' ↓') : '')))),
      h('tbody', {}, shown.length ? shown.map(r => h('tr', { class: opts.onRow ? 'click' : '', tabindex: opts.onRow ? '0' : null,
        onclick: opts.onRow ? () => opts.onRow(r) : null, onkeydown: opts.onRow ? e => { if (e.key === 'Enter') opts.onRow(r); } : null },
        cols.map(c => h('td', { class: c.num ? 'n' : '' }, c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '–'))))) :
        h('tr', {}, h('td', { colspan: cols.length, class: 'empty' }, opts.empty || t('common.none'))))),
      sorted.length > shown.length ? h('div', { class: 'note' }, t('common.showing', { shown: shown.length, total: sorted.length })) : '');
  };
  draw();
  return wrap;
}

// ───────────────────────── layout bits ─────────────────────────
const pageHead = (title, sub, ...right) => h('div', { class: 'ph' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), h('div', { class: 'filters' }, right));
const kpi = (label, value, sub, meter) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null, meter || null);
function budgetMeter(spent, limit) {
  if (!(limit > 0)) return null;
  const r = spent / limit;
  return h('div', {}, h('div', { class: 'meter' + (r > 1 ? ' over' : ''), role: 'meter', 'aria-valuenow': Math.round(r * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${Math.min(100, r * 100)}%` })),
    h('div', { class: 's' }, t('budget.line', { limit: usd(limit), pct: pct(r) }) + (r > 1 ? t('budget.over') : '')));
}
const seg = (options, current, onChange) => h('div', { class: 'seg', role: 'group' }, options.map(([v, label]) => h('button', { class: v === current ? 'on' : '', 'aria-pressed': String(v === current), onclick: () => onChange(v) }, label)));
const card = (title, sub, ...body) => h('section', { class: 'card' }, h('h2', {}, title, sub ? h('small', {}, sub) : null), body);
const card2 = card;
function wpill(id) { const w = WK[id] || { label: id, color: 'var(--sx)' }; return h('span', { class: 'pill' }, h('i', { class: 'sw', style: `background:${w.color}` }), w.label); }
const status = r => r.rc === 0 ? h('span', { class: 'ok' }, t('common.ok')) : h('span', { class: 'fail' }, t('common.fail', { rc: r.rc }));

const dlg = $('#dlg');
$('#dlgClose').addEventListener('click', () => dlg.close());
function openDialog(title, ...body) { $('#dlgTitle').textContent = title; $('#dlgBody').replaceChildren(...real(body)); dlg.showModal(); }
function openRun(r) {
  const logBox = h('pre', {}, '');
  const name = r.log ? r.log.split('/').pop() : '';
  openDialog(t('tk.detail'),
    h('div', { class: 'bar' }, wpill(r.worker), h('span', { class: 'pill mono' }, r.model || '–'), status(r), h('span', { class: 'pill' }, dur(r.secs)), r.write ? h('span', { class: 'pill' }, t('common.write')) : null, r.project ? h('span', { class: 'pill' }, r.project) : null, h('span', { class: 'note' }, dt(r.t))),
    h('h3', {}, t('tk.task')), h('pre', {}, r.task || (r.legacy ? t('tk.noText') : t('tk.empty2'))),
    h('h3', {}, t('tk.report')), h('pre', {}, r.report || t('tk.empty2')),
    name ? [h('h3', {}, t('tk.log') + ' ', h('button', { class: 'btn', onclick: async e => {
      e.target.disabled = true; logBox.textContent = t('common.loading');
      try { const res = await fetch('/api/log?name=' + encodeURIComponent(name)); logBox.textContent = res.ok ? await res.text() : t('tk.logFail', { s: res.status }); } catch { logBox.textContent = t('tk.logFail', { s: '-' }); }
    } }, t('tk.load'))), logBox] : null);
}

// ───────────────────────── pages ─────────────────────────
const state = { claudeDays: 30, claudeProject: '', taskWorker: '', taskStatus: '', taskQuery: '' };

function setupCard(st) {
  const missing = st.items.filter(i => !i.ok);
  if (!missing.length) return null;
  const okN = st.items.length - missing.length;
  return h('section', { class: 'card setup' },
    h('h2', {}, t('setup.title'), h('small', {}, t('setup.sub', { ok: okN, n: st.items.length }))),
    h('ul', { class: 'checklist' }, st.items.map(i => h('li', { class: i.ok ? 'done' : '' },
      h('span', { class: i.ok ? 'ok' : (i.required ? 'fail' : 'note'), 'aria-hidden': 'true' }, i.ok ? '✓' : (i.required ? '✗' : '○')), ' ', t('setup.' + i.id),
      !i.ok && i.hint ? h('code', { class: 'mono' }, i.hint) : null,
      !i.ok && i.id === 'endpoint_any' ? h('a', { href: '#/workers' }, t('setup.configure')) : null,
      !i.ok && i.id === 'pixel_hooks' ? h('a', { href: '#/office' }, t('setup.configure')) : null))));
}

async function pageOverview() {
  const [u, runsR, set, setup] = await Promise.all([api('/api/usage?days=30'), api('/api/runs?limit=5000'), api('/api/settings'), api('/api/setup'), loadWorkers()]);
  setIdx(u.indexing);
  const runs = runsR.runs, since30 = Date.now() / 1000 - 30 * 86400;
  const r30 = runs.filter(r => r.t >= since30), ok30 = r30.filter(r => r.rc === 0).length;
  const T = u.totals, cacheHit = T.cr / Math.max(1, T.in + T.cw + T.cr);
  const sum = x => x.in + x.out + x.cw + x.cr;
  const c = set.conductor;
  main.replaceChildren(h('div', {},
    pageHead(t('ov.title'), t('ov.sub', { note: t('cost.note') }), h('button', { class: 'btn', onclick: () => route() }, t('common.refresh'))),
    setupCard(setup),
    h('div', { class: 'grid g4' },
      kpi(t('ov.today'), usd(u.today.cost), t('ov.tokensReplies', { tokens: tok(sum(u.today)), replies: NF.format(u.today.msgs) }), budgetMeter(u.today.cost, +c.CONDUCTOR_BUDGET_DAILY)),
      kpi(t('ov.month'), usd(u.month.cost), t('ov.tokens', { tokens: tok(sum(u.month)) }), budgetMeter(u.month.cost, +c.CONDUCTOR_BUDGET_MONTHLY)),
      kpi(t('ov.last30'), usd(T.cost), t('ov.subShare', { tokens: tok(sum(T)), pct: pct(u.subagents.cost / Math.max(1e-9, T.cost)) })),
      kpi(t('ov.cacheHit'), pct(cacheHit), t('ov.cacheSub'))),
    h('div', { class: 'grid mt' }, card(t('ov.dailyCost'), t('ov.byModelHover'), h('div', { class: 'chart', id: 'cCost' }))),
    h('div', { class: 'grid g2 mt' },
      card(t('ov.tokenMix'), t('common.days', { n: 30 }), stackLine(TOKEN_SERIES().map(x => ({ label: x.label, color: x.color, value: T[x.key] })))),
      card(t('ov.projects'), t('ov.projectsSub'), hbars(u.byProject.slice(0, 8).map(p => ({ label: p.key, value: p.cost })), usd))),
    h('div', { class: 'grid g2 mt' },
      card(t('ov.delegated'), t('ov.delegatedSub', { n: NF.format(r30.length), pct: r30.length ? pct(ok30 / r30.length) : '–', time: dur(r30.reduce((a, r) => a + (r.secs || 0), 0)) }), h('div', { class: 'chart', id: 'cRuns' })),
      card(t('ov.recent'), null, runs.length ? h('div', {}, runs.slice(0, 7).map(r => h('div', { class: 'bar recent', tabindex: '0', role: 'button', onclick: () => openRun(r), onkeydown: e => { if (e.key === 'Enter') openRun(r); } },
        wpill(r.worker), h('span', { class: 'clamp1' }, r.task || r.model || '–'), status(r), h('span', { class: 'note' }, rel(r.t))))) : h('div', { class: 'empty' }, t('ov.noTasks')))),
  ));
  stackedBars($('#cCost'), {
    labels: u.days.map(d => d.date), series: u.byModel.map(m => ({ key: m.key, label: modelName(m.key), color: modelColor(m.key) })),
    data: (i, k) => (u.days[i].models[k] || {}).cost || 0, fmt: usd, axisFmt: usdAxis, xfmt: dayLabel, xtitle: dayTitle, aria: t('ov.dailyCost'),
  });
  runsChart($('#cRuns'), runs, 30);
}

function runsChart(el, runs, n) {
  const days = lastDays(n), byDay = {};
  for (const r of runs) { const d = localDay(r.t); const o = byDay[d] || (byDay[d] = {}); o[r.worker] = (o[r.worker] || 0) + 1; }
  stackedBars(el, {
    labels: days, height: 180, series: WK_ORDER.map(id => ({ key: id, label: WK[id].label, color: WK[id].color })),
    data: (i, k) => (byDay[days[i]] || {})[k] || 0, fmt: v => `${NF.format(v)} ${t('col.runs').toLowerCase()}`, axisFmt: v => NF.format(v), xfmt: dayLabel, xtitle: dayTitle, aria: t('wk.daily'),
  });
}

async function pageClaude() {
  const q = `days=${state.claudeDays}${state.claudeProject ? '&project=' + encodeURIComponent(state.claudeProject) : ''}`;
  const u = await api('/api/usage?' + q);
  setIdx(u.indexing);
  const T = u.totals, days = u.days.map(d => d.date);
  const projectSel = h('select', { 'aria-label': t('col.project'), onchange: e => { state.claudeProject = e.target.value; route(); } },
    h('option', { value: '' }, t('common.allProjects')), u.projects.map(p => h('option', { value: p, selected: p === state.claudeProject ? true : null }, p)));
  const tokenCols = [
    { key: 'in', label: t('col.in'), num: true, fmt: tok }, { key: 'out', label: t('col.out'), num: true, fmt: tok },
    { key: 'cw', label: t('col.cw'), num: true, fmt: tok }, { key: 'cr', label: t('col.cr'), num: true, fmt: tok },
    { key: 'msgs', label: t('col.replies'), num: true, fmt: v => NF.format(v) }, { key: 'cost', label: t('col.cost'), num: true, fmt: usd },
  ];
  main.replaceChildren(h('div', {},
    pageHead(t('cl.title'), t('cl.sub', { note: t('cost.note') }),
      seg([[7, t('common.days', { n: 7 })], [30, t('common.days', { n: 30 })], [90, t('common.days', { n: 90 })], [365, t('common.year')], [0, t('common.all')]], state.claudeDays, v => { state.claudeDays = v; route(); }), projectSel),
    u.unpriced.length ? h('div', { class: 'card warnbox' }, t('cl.unpriced', { list: u.unpriced.join(', ') })) : null,
    h('div', { class: 'grid g4' },
      kpi(t('cl.cost'), usd(T.cost), t('cl.replies', { n: NF.format(T.msgs) })),
      kpi(t('cl.totalTokens'), tok(T.in + T.out + T.cw + T.cr), t('cl.outSub', { v: tok(T.out) })),
      kpi(t('ov.cacheHit'), pct(T.cr / Math.max(1, T.in + T.cw + T.cr)), t('cl.readSub', { v: tok(T.cr) })),
      kpi(t('cl.sessions'), NF.format(u.sessionCount), t('cl.subCost', { v: usd(u.subagents.cost) }))),
    h('div', { class: 'grid g2 mt' },
      card(t('cl.dailyCost'), t('cl.byModel'), h('div', { class: 'chart', id: 'cCost' })),
      card(t('cl.dailyTokens'), t('cl.byType'), h('div', { class: 'chart', id: 'cTok' }))),
    h('div', { class: 'grid mt' }, card(t('cl.models'), null, table([{ key: 'key', label: t('col.model'), fmt: k => h('span', { class: 'pill' }, h('i', { class: 'sw', style: `background:${modelColor(k)}` }), modelName(k)) }, ...tokenCols], u.byModel, { sort: 'cost' }))),
    h('div', { class: 'grid mt' }, card(t('cl.projects'), null, table([{ key: 'key', label: t('col.project') }, ...tokenCols], u.byProject, { sort: 'cost' }))),
    h('div', { class: 'grid mt' }, card(t('cl.sessions'), t('cl.sessionsTop'), table([
      { key: 'last', label: t('col.last'), fmt: v => dt(v), sortv: r => r.last },
      { key: 'project', label: t('col.project') },
      { key: 'models', label: t('col.models'), nosort: true, fmt: v => v.map(modelName).join(', ') },
      { key: 'msgs', label: t('col.replies'), num: true, fmt: v => NF.format(v) },
      { key: 'tokens', label: t('col.tokens'), num: true, sortv: r => r.in + r.out + r.cw + r.cr, fmt: (_, r) => tok(r.in + r.out + r.cw + r.cr) },
      { key: 'cost', label: t('col.cost'), num: true, fmt: usd },
    ], u.sessions, { sort: 'cost', limit: 200 }))),
  ));
  const xfmt = days.length > 120 ? d => d.slice(0, 7) : dayLabel;
  stackedBars($('#cCost'), { labels: days, series: u.byModel.map(m => ({ key: m.key, label: modelName(m.key), color: modelColor(m.key) })), data: (i, k) => (u.days[i].models[k] || {}).cost || 0, fmt: usd, axisFmt: usdAxis, xfmt, xtitle: dayTitle, aria: t('cl.dailyCost') });
  stackedBars($('#cTok'), { labels: days, series: TOKEN_SERIES(), data: (i, k) => Object.values(u.days[i].models).reduce((a, m) => a + (m[k] || 0), 0), fmt: tok, axisFmt: tok, xfmt, xtitle: dayTitle, aria: t('cl.dailyTokens') });
}

async function pageWorkers() {
  const [ws, runsR] = await Promise.all([loadWorkers(), api('/api/runs?limit=5000')]);
  const runs = runsR.runs, since = Date.now() / 1000 - 30 * 86400;
  const order = w => (w.enabled && w.available ? 0 : w.available ? 1 : 2);
  const sorted = [...ws].sort((a, b) => order(a) - order(b));
  const stateOf = w => !w.available ? (w.kind === 'endpoint' ? t('wk.notConfigured') : t('wk.missing')) : !w.enabled ? t('wk.disabled') : t('wk.ready');
  const dotOf = w => (w.available && w.enabled ? 'on' : 'off');

  const card = w => {
    const mine = runs.filter(r => r.worker === w.id && r.t >= since), ok = mine.filter(r => r.rc === 0).length;
    const msgEl = h('span', { role: 'status' });
    const dl = 'dl-w-' + w.id;
    const modelIn = h('input', { type: 'text', value: w.model, placeholder: w.defaultModel || t('wk.auto'), list: dl, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('st.model') });
    const goodIn = h('input', { type: 'text', value: w.goodAt, 'aria-label': t('wk.goodAt') });
    const say = (ok2, text) => { msgEl.className = ok2 ? 'msg-ok' : 'msg-err'; msgEl.textContent = text; };
    const loadModels = async () => {
      msgEl.className = 'note'; msgEl.textContent = t('st.testing');
      const r = await api('/api/workers/models?id=' + encodeURIComponent(w.id));
      $('#' + dl)?.replaceChildren(...(r.models || []).map(v => h('option', { value: v })));
      if (r.ok) say(true, t('st.modelsLoaded', { n: r.models.length })); else say(false, t('st.test.' + (r.code || 'http_error'), { status: r.status, message: r.message || '', ms: r.ms }));
    };
    const save = async extra => { const r = await post('/api/workers/save', { id: w.id, model: modelIn.value, goodAt: goodIn.value, ...extra }); say(r.ok, r.ok ? t('common.saved') : fmtErrors(r.errors)); return r; };
    const epFields = w.kind === 'endpoint' ? endpointForm(w, () => route()) : null;
    return h('section', { class: 'card wcard' + (w.enabled && w.available ? '' : ' dim') },
      h('div', { class: 'top' },
        h('div', { class: 'av', style: `background:${(WK[w.id] || {}).color || 'var(--sx)'}`, 'aria-hidden': 'true' }, w.label[0]),
        h('div', { class: 'grow' }, h('b', {}, w.label, ' ', h('span', { class: 'pill tiny' }, t('wk.kind.' + w.kind))), h('div', { class: 'note' }, w.via, w.version ? ` · ${w.version}` : '')),
        h('span', { class: 'pill st' }, h('span', { class: 'dot ' + dotOf(w) }), stateOf(w)),
        h('label', { class: 'switch', title: t('wk.enabled') }, h('input', { type: 'checkbox', checked: w.enabled, 'aria-label': t('wk.enabled'), onchange: async e => { const r = await save({ enabled: e.target.checked }); if (r.ok) route(); } }), h('span', {}))),
      h('datalist', { id: dl }),
      h('div', { class: 'form compact' },
        h('label', {}, t('st.model')), h('div', { class: 'row' }, modelIn, w.listsModels ? h('button', { type: 'button', class: 'btn', onclick: loadModels }, t('st.loadModels')) : null),
        h('label', {}, t('wk.goodAt')), goodIn),
      epFields,
      w.notes ? h('div', { class: 'note' }, w.notes) : null,
      !w.available && w.install ? h('div', { class: 'note' }, t('wk.install') + ': ', h('code', { class: 'mono' }, w.install)) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => save({}) }, t('common.save')), msgEl,
        h('span', { class: 'note grow-r' }, mine.length ? `${NF.format(mine.length)} ${t('col.runs').toLowerCase()} · ${pct(ok / mine.length)} · ${dur(mine.reduce((a, r) => a + (r.secs || 0), 0) / mine.length)}` : t('wk.noRuns'))));
  };

  const byModel = {};
  for (const r of runs.filter(r => r.t >= since)) { const k = r.worker + '|' + r.model; const o = byModel[k] || (byModel[k] = { worker: r.worker, model: r.model, runs: 0, ok: 0, secs: 0 }); o.runs++; o.ok += r.rc === 0 ? 1 : 0; o.secs += r.secs || 0; }
  main.replaceChildren(h('div', {},
    pageHead(t('wk.title'), t('wk.sub')),
    h('div', { class: 'grid g2' }, sorted.map(card), h('section', { class: 'card wcard add' }, h('h2', {}, t('ep.add'), h('small', {}, t('ep.addSub'))), endpointForm(null, () => route()))),
    h('div', { class: 'grid mt' }, card2(t('wk.daily'), t('wk.dailySub'), h('div', { class: 'chart', id: 'cRuns' }))),
    h('div', { class: 'grid mt' }, card2(t('wk.modelUse'), t('common.days', { n: 30 }), table([
      { key: 'worker', label: t('col.worker'), fmt: v => wpill(v) }, { key: 'model', label: t('col.model'), fmt: v => h('span', { class: 'mono' }, v || '–') },
      { key: 'runs', label: t('col.runs'), num: true }, { key: 'ok', label: t('col.success'), num: true, sortv: r => r.ok / r.runs, fmt: (_, r) => pct(r.ok / r.runs) },
      { key: 'secs', label: t('col.avg'), num: true, sortv: r => r.secs / r.runs, fmt: (_, r) => dur(r.secs / r.runs) },
    ], Object.values(byModel), { sort: 'runs' }))),
  ));
  runsChart($('#cRuns'), runs, 30);
}

// Endpoint editor: existing endpoint (w) or a new one (w = null).
function endpointForm(w, done) {
  const isNew = !w;
  const msgEl = h('span', { role: 'status' }), testEl = h('div', { class: 'note', role: 'status' });
  const f = {
    id: h('input', { type: 'text', value: w ? w.id : '', placeholder: 'ollama', autocomplete: 'off', spellcheck: 'false', disabled: !isNew, 'aria-label': 'ID' }),
    label: h('input', { type: 'text', value: w ? w.label : '', placeholder: 'Ollama', autocomplete: 'off', 'aria-label': t('ep.label') }),
    url: h('input', { type: 'url', value: w ? w.url || '' : '', placeholder: 'http://localhost:11434', 'aria-label': t('st.url') }),
    apiKey: h('input', { type: 'password', placeholder: w && w.has_apiKey ? t('st.secretSaved') : t('st.secretEmpty'), autocomplete: 'off', 'aria-label': t('st.apiKey') }),
    cfId: h('input', { type: 'password', placeholder: w && w.has_cfId ? t('st.secretSaved') : t('st.secretEmpty'), autocomplete: 'off', 'aria-label': t('st.cfId') }),
    cfSecret: h('input', { type: 'password', placeholder: w && w.has_cfSecret ? t('st.secretSaved') : t('st.secretEmpty'), autocomplete: 'off', 'aria-label': t('st.cfSecret') }),
    model: isNew ? h('input', { type: 'text', placeholder: t('wk.auto'), autocomplete: 'off', spellcheck: 'false', 'aria-label': t('st.model') }) : null,
  };
  const body = () => ({ id: f.id.value.trim(), label: f.label.value.trim(), url: f.url.value.trim(), apiKey: f.apiKey.value, cfId: f.cfId.value, cfSecret: f.cfSecret.value,
    model: isNew ? f.model.value.trim() : (w.model || ''), goodAt: isNew ? '' : (w.goodAt || '') });
  const say = (ok, text) => { msgEl.className = ok ? 'msg-ok' : 'msg-err'; msgEl.textContent = text; };
  const showTest = r => { testEl.className = r.ok ? 'msg-ok' : 'msg-err'; testEl.textContent = t('st.test.' + (r.code || (r.ok ? 'ok' : 'http_error')), { ms: r.ms, n: (r.models || []).length, status: r.status, message: r.message || '' }); };
  const save = async () => { const r = await post('/api/endpoints/save', body()); say(r.ok, r.ok ? t('common.saved') : fmtErrors(r.errors)); if (r.ok) setTimeout(done, 500); return r; };
  return h('div', { class: 'epform' },
    h('div', { class: 'form compact' },
      isNew ? [h('label', {}, 'ID'), f.id] : null,
      h('label', {}, t('ep.label')), f.label,
      h('label', {}, t('st.url')), f.url,
      h('label', {}, t('st.apiKey')), f.apiKey,
      h('label', {}, t('st.cfId')), f.cfId,
      h('label', {}, t('st.cfSecret')), f.cfSecret,
      isNew ? [h('label', {}, t('st.model')), f.model] : null),
    h('div', { class: 'note' }, t('st.secretHint')),
    h('div', { class: 'actions' },
      h('button', { class: isNew ? 'btn primary' : 'btn', onclick: save }, isNew ? t('ep.addBtn') : t('ep.saveEp')),
      !isNew ? h('button', { class: 'btn', onclick: async () => { testEl.className = 'note'; testEl.textContent = t('st.testing'); showTest(await post('/api/endpoints/test', { id: w.id })); } }, t('st.test')) : null,
      !isNew ? h('button', { class: 'btn danger', onclick: async () => { if (confirmDelete(w.id)) { await post('/api/endpoints/delete', { id: w.id }); done(); } } }, t('ep.delete')) : null,
      msgEl),
    testEl);
}
// two-step delete without a browser dialog: first click arms, second click (within 4 s) confirms
const armed = new Map();
function confirmDelete(id) {
  const now = Date.now();
  if (armed.get(id) > now) { armed.delete(id); return true; }
  armed.set(id, now + 4000);
  const tip = h('div', { class: 'toast' }, t('ep.confirm'));
  document.body.append(tip); setTimeout(() => tip.remove(), 4000);
  return false;
}

async function pageTasks() {
  const [{ runs }] = await Promise.all([api('/api/runs?limit=5000'), loadWorkers()]);
  const box = h('div', {});
  const draw = () => {
    const q = state.taskQuery.toLowerCase();
    const rows = runs.filter(r => (!state.taskWorker || r.worker === state.taskWorker) &&
      (!state.taskStatus || (state.taskStatus === 'ok' ? r.rc === 0 : r.rc !== 0)) &&
      (!q || `${r.task} ${r.report} ${r.project} ${r.model}`.toLowerCase().includes(q)));
    box.replaceChildren(table([
      { key: 't', label: t('col.time'), fmt: v => dt(v) },
      { key: 'worker', label: t('col.worker'), fmt: v => wpill(v) },
      { key: 'model', label: t('col.model'), fmt: v => h('span', { class: 'mono' }, v || '–') },
      { key: 'project', label: t('col.project'), fmt: v => v || '–' },
      { key: 'task', label: t('col.task'), nosort: true, fmt: (v, r) => h('div', { class: 'clamp' }, v || (r.legacy ? t('tk.legacy') : '–')) },
      { key: 'rc', label: t('col.status'), fmt: (_, r) => status(r) },
      { key: 'secs', label: t('col.duration'), num: true, fmt: dur },
    ], rows, { sort: 't', onRow: openRun, empty: runs.length ? t('tk.empty') : t('ov.noTasks') }));
  };
  const wsel = h('select', { 'aria-label': t('col.worker'), onchange: e => { state.taskWorker = e.target.value; draw(); } }, h('option', { value: '' }, t('tk.allWorkers')), WK_ORDER.map(id => h('option', { value: id, selected: state.taskWorker === id ? true : null }, WK[id].label)));
  const ssel = h('select', { 'aria-label': t('col.status'), onchange: e => { state.taskStatus = e.target.value; draw(); } }, h('option', { value: '' }, t('tk.allStatus')), h('option', { value: 'ok', selected: state.taskStatus === 'ok' ? true : null }, t('tk.ok')), h('option', { value: 'fail', selected: state.taskStatus === 'fail' ? true : null }, t('tk.fail')));
  const search = h('input', { type: 'search', placeholder: t('tk.search'), value: state.taskQuery, 'aria-label': t('tk.search'), oninput: e => { state.taskQuery = e.target.value; draw(); } });
  main.replaceChildren(h('div', {}, pageHead(t('tk.title'), t('tk.sub', { n: NF.format(runs.length) }), search, wsel, ssel), h('section', { class: 'card' }, box)));
  draw();
}

async function pageOffice() {
  let st = await api('/api/office');
  const frameBox = h('div', { class: 'office' });
  const info = h('div', { class: 'bar' });
  const paint = () => {
    info.replaceChildren(...real([
      h('span', { class: 'dot ' + (st.running ? 'on' : 'off') }), st.running ? t('of.running', { port: st.port }) : t('of.stopped'),
      st.installed ? (st.running ? h('button', { class: 'btn', onclick: () => act('stop') }, t('of.stop')) : h('button', { class: 'btn primary', onclick: () => act('start') }, t('of.start'))) : null,
      st.running ? h('a', { class: 'btn', href: st.url, target: '_blank', rel: 'noopener' }, t('of.newTab')) : null,
      st.running && !st.hooksInstalled && st.approveUrl ? h('span', { class: 'note' }, t('of.hooksMissing'), h('a', { href: st.approveUrl, target: '_blank', rel: 'noopener' }, t('of.approve'))) : null,
      st.hooksInstalled ? h('span', { class: 'note' }, t('of.hooksOk')) : null]));
    if (!st.installed) frameBox.replaceChildren(h('div', { class: 'ph-off' }, h('div', {}, h('p', {}, t('of.notInstalled')), h('code', {}, 'npm install -g pixel-agents'))));
    else if (st.running) frameBox.replaceChildren(h('iframe', { src: st.url, title: 'Pixel Agents' }));
    else frameBox.replaceChildren(h('div', { class: 'ph-off' }, h('div', {}, h('p', {}, t('of.closed')), h('button', { class: 'btn primary', onclick: () => act('start') }, t('of.startBig')))));
  };
  const act = async what => {
    frameBox.replaceChildren(h('div', { class: 'ph-off' }, what === 'start' ? t('of.starting') : t('of.stopping')));
    st = await post('/api/office/' + what);
    paint();
  };
  main.replaceChildren(h('div', {}, pageHead(t('of.title'), t('of.sub')), info, frameBox));
  paint();
  if (st.installed && !st.running) act('start'); // opening the page is the "click to run"
}

async function pageSettings() {
  const [set, hosts] = await Promise.all([api('/api/settings'), api('/api/hosts')]);
  const c = set.conductor;
  const msg = () => h('span', { role: 'status' });
  const say = (el, ok, text) => { el.className = ok ? 'msg-ok' : 'msg-err'; el.textContent = text; };
  const save = async (body, el) => { const r = await post('/api/settings', body); say(el, r.ok, r.ok ? t('common.saved') : fmtErrors(r.errors)); return r; };

  // orchestrator + host integrations
  const hMsg = msg(), hOut = h('pre', { class: 'mono out', hidden: true });
  const orch = h('select', { id: 'orch', onchange: e => save({ conductor: { CONDUCTOR_ORCHESTRATOR: e.target.value === 'auto' ? '' : e.target.value } }, hMsg) },
    [['auto', t('or.auto')], ['claude', 'Claude Code'], ['codex', 'Codex']].map(([v, l]) => h('option', { value: v, selected: (c.CONDUCTOR_ORCHESTRATOR || 'auto') === v ? true : null }, l)));
  const hostRows = hosts.hosts.map(x => h('tr', {},
    h('td', {}, h('b', {}, x.name)),
    h('td', {}, x.cli ? '✓ ' + t('or.cli') : '✗ ' + t('or.noCli')),
    h('td', {}, x.installed ? h('span', { class: 'ok' }, t('or.installed')) : h('span', { class: 'note' }, t('or.notInstalled'))),
    h('td', {}, x.cli && !x.installed ? h('button', { class: 'btn primary', onclick: async e => {
      e.target.disabled = true; hMsg.className = 'note'; hMsg.textContent = t('or.installing');
      const r = await post('/api/hosts/install', { host: x.id }); say(hMsg, r.ok, r.ok ? t('or.done') : t('or.failed'));
      hOut.hidden = false; hOut.textContent = r.output || ''; if (r.ok) setTimeout(route, 1500);
    } }, t('or.install')) : null)));
  const orchCard = card2(t('or.title'), t('or.sub'),
    h('div', { class: 'form' }, h('label', { for: 'orch' }, t('or.label')), orch, h('div', { class: 'hint' }, t('or.hint'))),
    h('div', { class: 'tw mt' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('or.host')), h('th', {}, 'CLI'), h('th', {}, 'Conductor'), h('th', {}))), h('tbody', {}, hostRows))),
    h('div', { class: 'note mt' }, t('or.codexNote')),
    h('div', { class: 'actions' }, hMsg), hOut);

  // general
  const gMsg = msg();
  const gForm = h('form', { class: 'form', onsubmit: async e => { e.preventDefault(); await save({ conductor: Object.fromEntries([...new FormData(e.target).entries()]) }, gMsg); } },
    h('label', { for: 'to' }, t('st.timeout')), h('input', { id: 'to', type: 'number', name: 'CONDUCTOR_TIMEOUT', value: c.CONDUCTOR_TIMEOUT, placeholder: '900', min: 30, max: 7200 }),
    h('label', { for: 'ml' }, t('st.maxLines')), h('input', { id: 'ml', type: 'number', name: 'CONDUCTOR_MAX_LINES', value: c.CONDUCTOR_MAX_LINES, placeholder: '60', min: 10, max: 500 }),
    h('div', { class: 'hint' }, t('st.maxLinesHint')));

  // toggles
  const oMsg = msg();
  const tg = (name, label, hint, def) => [h('label', { for: name }, label),
    h('div', {}, h('label', { class: 'switch' }, h('input', { id: name, type: 'checkbox', checked: (c[name] || def) === '1', onchange: e => save({ conductor: { [name]: e.target.checked ? '1' : '0' } }, oMsg) }), h('span', {}))),
    hint ? h('div', { class: 'hint' }, hint) : null];
  const hideIn = h('input', { id: 'hide', type: 'text', value: c.CONDUCTOR_OFFICE_HIDE, placeholder: 'sessions,observer-sessions', onchange: e => save({ conductor: { CONDUCTOR_OFFICE_HIDE: e.target.value.trim() } }, oMsg) });
  const oForm = h('div', { class: 'form' },
    tg('CONDUCTOR_PIXEL', t('st.pixel'), t('st.pixelHint'), '1'),
    tg('CONDUCTOR_PANEL_AUTOSTART', t('st.panelAuto'), t('st.panelAutoHint'), '1'),
    tg('CONDUCTOR_OFFICE_AUTOSTART', t('st.officeAuto'), t('st.officeAutoHint'), '0'),
    h('label', { for: 'hide' }, t('st.hide')), hideIn, h('div', { class: 'hint' }, t('st.hideHint')));

  // budget
  const bMsg = msg();
  const bForm = h('form', { class: 'form', onsubmit: async e => { e.preventDefault(); await save({ conductor: Object.fromEntries([...new FormData(e.target).entries()]) }, bMsg); } },
    h('label', { for: 'bd' }, t('st.daily')), h('input', { id: 'bd', type: 'number', step: '0.01', min: 0, name: 'CONDUCTOR_BUDGET_DAILY', value: c.CONDUCTOR_BUDGET_DAILY, placeholder: t('st.none') }),
    h('label', { for: 'bm' }, t('st.monthly')), h('input', { id: 'bm', type: 'number', step: '0.01', min: 0, name: 'CONDUCTOR_BUDGET_MONTHLY', value: c.CONDUCTOR_BUDGET_MONTHLY, placeholder: t('st.none') }),
    h('div', { class: 'hint' }, t('st.budgetHint')));

  // pricing
  const pMsg = msg();
  const allModels = [...new Set([...Object.keys(set.pricing.defaults), ...Object.keys(set.pricing.overrides)])];
  const eff = m => set.pricing.overrides[m] || set.pricing.defaults[m] || { in: 0, out: 0, cr: 0 };
  const pTable = h('table', { class: 'ptable' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('col.model')), h('th', { class: 'n', scope: 'col' }, t('st.pIn')), h('th', { class: 'n', scope: 'col' }, t('st.pOut')), h('th', { class: 'n', scope: 'col' }, t('st.pCr')))),
    h('tbody', {}, allModels.map(m => h('tr', { 'data-model': m },
      h('td', {}, h('span', { class: 'pill' }, h('i', { class: 'sw', style: `background:${modelColor(m)}` }), modelName(m)), set.pricing.overrides[m] ? h('span', { class: 'note' }, t('st.custom')) : null),
      ['in', 'out', 'cr'].map(k => h('td', { class: 'n' }, h('input', { type: 'number', step: '0.001', min: 0, 'data-k': k, value: eff(m)[k], 'aria-label': `${modelName(m)} ${k}` })))))));
  const newModel = h('input', { type: 'text', placeholder: t('st.newModel'), style: 'width:260px', 'aria-label': t('st.newModel') });
  const savePricing = async () => {
    const out = {};
    for (const tr of pTable.querySelectorAll('tbody tr')) {
      const m = tr.dataset.model, v = {}; tr.querySelectorAll('input').forEach(i => { v[i.dataset.k] = +i.value; });
      const d = set.pricing.defaults[m];
      if (!d || d.in !== v.in || d.out !== v.out || d.cr !== v.cr) out[m] = v;
    }
    if (newModel.value.trim()) out[newModel.value.trim()] = { in: 0, out: 0, cr: 0 };
    const r = await save({ pricing: out }, pMsg); if (r.ok) setTimeout(route, 600);
  };

  // system
  const pathLabel = { state: t('path.state'), config: t('path.config'), projects: t('path.projects'), plugin: t('path.plugin') };
  const sys = h('div', { class: 'tw' }, h('table', {}, h('tbody', {}, Object.entries(set.paths).map(([k, v]) => h('tr', {}, h('td', {}, pathLabel[k] || k), h('td', { class: 'mono' }, v))))));
  const idxLine = h('span', { class: 'note' });
  api('/api/usage?days=1').then(u => { idxLine.textContent = u.indexing.running ? t('idx.running', u.indexing) : t('st.lastScan', { ago: u.indexing.lastScan ? rel(u.indexing.lastScan / 1000) : '–', n: u.indexing.total }); }).catch(() => {});

  main.replaceChildren(h('div', {},
    pageHead(t('st.title'), t('st.sub')),
    h('div', { class: 'grid' }, orchCard),
    h('div', { class: 'grid g2 mt' },
      card2(t('st.general'), t('st.workersLink'), gForm, h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => gForm.requestSubmit() }, t('common.save')), gMsg)),
      card2(t('st.budget'), t('st.budgetSub'), bForm, h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => bForm.requestSubmit() }, t('common.save')), bMsg))),
    h('div', { class: 'grid mt' }, card2(t('st.office'), null, oForm, h('div', { class: 'actions' }, oMsg))),
    h('div', { class: 'grid mt' }, card2(t('st.pricing'), t('st.pricingSub'), h('div', { class: 'tw' }, pTable),
      h('div', { class: 'actions' }, newModel, h('button', { class: 'btn primary', onclick: savePricing }, t('st.savePricing')),
        h('button', { class: 'btn', onclick: async () => { const r = await save({ pricing: {} }, pMsg); if (r.ok) setTimeout(route, 600); } }, t('st.reset')), pMsg))),
    h('div', { class: 'grid mt' }, card2(t('st.system'), t('st.version', { v: set.version }), sys, h('div', { class: 'actions' }, idxLine,
      h('button', { class: 'btn', onclick: async () => { await post('/api/rescan'); idxLine.textContent = t('st.rescanStarted'); } }, t('st.rescan'))))),
  ));
}

// ───────────────────────── router & chrome ─────────────────────────
const PAGES = { overview: pageOverview, claude: pageClaude, workers: pageWorkers, tasks: pageTasks, office: pageOffice, settings: pageSettings };
let routeSeq = 0;
async function route() {
  const page = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'overview';
  const fn = PAGES[page] || pageOverview;
  document.querySelectorAll('.side a[data-page]').forEach(a => { const on = a.dataset.page === page; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const seq = ++routeSeq;
  hideTip();
  if (main.dataset.page !== page) main.replaceChildren(h('div', { class: 'empty' }, t('common.loading')));
  main.dataset.page = page;
  document.title = `${t('nav.' + page)} · Conductor`;
  try { await fn(); } catch (e) { if (seq === routeSeq) main.replaceChildren(h('section', { class: 'card' }, h('h2', {}, t('common.error')), h('pre', { class: 'mono' }, String(e.message || e)))); }
}
function setIdx(ix) {
  if (!ix) return;
  $('#idxStatus').textContent = ix.running ? t('idx.running', ix) : t('idx.done', { total: ix.total, ago: ix.lastScan ? rel(ix.lastScan / 1000) : '' });
  if (ix.running && ['overview', 'claude'].includes(main.dataset.page)) setTimeout(() => { if (['overview', 'claude'].includes(main.dataset.page)) route(); }, 4000);
}

// static chrome text
document.documentElement.lang = LANG;
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
document.querySelectorAll('[data-lang]').forEach(b => { b.classList.toggle('on', b.dataset.lang === LANG); b.addEventListener('click', () => setLang(b.dataset.lang)); });

function applyTheme(th) {
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
  document.querySelectorAll('[data-theme-set]').forEach(b => b.classList.toggle('on', b.dataset.themeSet === (th || 'auto')));
  try { localStorage.setItem('conductor-theme', th || 'auto'); } catch {}
}
let savedTheme = 'auto';
try { savedTheme = localStorage.getItem('conductor-theme') || 'auto'; } catch {}
applyTheme(savedTheme);
document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => { applyTheme(b.dataset.themeSet); main.dataset.page = ''; route(); }));

addEventListener('hashchange', route);
const refreshIdx = () => api('/api/usage?days=1').then(u => setIdx(u.indexing)).catch(() => {});
refreshIdx(); setInterval(refreshIdx, 60000);
setInterval(() => { if (['overview', 'tasks', 'workers'].includes(main.dataset.page) && !dlg.open && document.visibilityState === 'visible') route(); }, 60000);
route();
