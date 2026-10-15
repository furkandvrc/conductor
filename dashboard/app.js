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
const WK = {
  gemini: { label: 'Gemini', color: 'var(--w-gemini)' },
  cursor: { label: 'Cursor', color: 'var(--w-cursor)' },
  copilot: { label: 'Copilot', color: 'var(--w-copilot)' },
  local: { label: 'Local', color: 'var(--w-local)' },
};
const WK_ORDER = ['gemini', 'cursor', 'copilot', 'local'];

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
      !i.ok && i.id === 'local' ? h('a', { href: '#/settings' }, t('setup.configure')) : null,
      !i.ok && i.id === 'pixel_hooks' ? h('a', { href: '#/office' }, t('setup.configure')) : null))));
}

async function pageOverview() {
  const [u, runsR, set, setup] = await Promise.all([api('/api/usage?days=30'), api('/api/runs?limit=5000'), api('/api/settings'), api('/api/setup')]);
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
  const [w, runsR, set] = await Promise.all([api('/api/workers'), api('/api/runs?limit=5000'), api('/api/settings')]);
  const runs = runsR.runs, since = Date.now() / 1000 - 30 * 86400;
  const c = set.conductor;
  const defaults = { gemini: c.CONDUCTOR_MODEL_GEMINI || 'claude-sonnet-5-5-medium', cursor: c.CONDUCTOR_MODEL_CURSOR || 'composer-2.5', copilot: c.CONDUCTOR_MODEL_COPILOT || 'auto', local: set.local.LOCAL_MODEL || t('wk.auto') };
  const host = u => { try { return new URL(u).host; } catch { return u; } };
  const cards = WK_ORDER.map(id => {
    const info = w.workers[id] || {}, mine = runs.filter(r => r.worker === id && r.t >= since), ok = mine.filter(r => r.rc === 0).length;
    const outTok = mine.reduce((a, r) => a + (r.out_bytes || 0), 0) / 4;
    return h('section', { class: 'card wcard' },
      h('div', { class: 'top' }, h('div', { class: 'av', style: `background:${WK[id].color}`, 'aria-hidden': 'true' }, WK[id].label[0]),
        h('div', {}, h('b', {}, WK[id].label), h('div', { class: 'note' }, `${t('wk.role.' + id)} · ${info.via || ''}`)),
        h('span', { class: 'pill st' }, h('span', { class: 'dot ' + (info.available ? 'on' : 'off') }), info.available ? t('wk.ready') : (id === 'local' ? t('wk.notConfigured') : t('wk.missing')))),
      h('dl', {},
        h('dt', {}, t('wk.default')), h('dd', { class: 'mono', title: defaults[id] }, defaults[id]),
        h('dt', {}, t('wk.version')), h('dd', {}, info.version || (id === 'local' && info.url ? host(info.url) : '–')),
        h('dt', {}, t('wk.runs30')), h('dd', {}, NF.format(mine.length)),
        h('dt', {}, t('wk.success')), h('dd', {}, mine.length ? pct(ok / mine.length) : '–'),
        h('dt', {}, t('wk.avg')), h('dd', {}, mine.length ? dur(mine.reduce((a, r) => a + r.secs, 0) / mine.length) : '–'),
        h('dt', {}, t('wk.total')), h('dd', {}, dur(mine.reduce((a, r) => a + (r.secs || 0), 0))),
        h('dt', { title: t('wk.offctxTip') }, t('wk.offctx')), h('dd', {}, `${tok(outTok)}`)),
      !info.available ? h('div', { class: 'actions' }, id === 'local' ? h('a', { class: 'btn', href: '#/settings' }, t('wk.setLocal')) : h('code', { class: 'mono note' }, info.install || '')) : null);
  });
  const byModel = {};
  for (const r of runs.filter(r => r.t >= since)) { const k = r.worker + '|' + r.model; const o = byModel[k] || (byModel[k] = { worker: r.worker, model: r.model, runs: 0, ok: 0, secs: 0 }); o.runs++; o.ok += r.rc === 0 ? 1 : 0; o.secs += r.secs || 0; }
  main.replaceChildren(h('div', {},
    pageHead(t('wk.title'), t('wk.sub')),
    h('div', { class: 'grid g4' }, cards),
    h('div', { class: 'grid mt' }, card(t('wk.daily'), t('wk.dailySub'), h('div', { class: 'chart', id: 'cRuns' }))),
    h('div', { class: 'grid mt' }, card(t('wk.modelUse'), t('common.days', { n: 30 }), table([
      { key: 'worker', label: t('col.worker'), fmt: v => wpill(v) }, { key: 'model', label: t('col.model'), fmt: v => h('span', { class: 'mono' }, v || '–') },
      { key: 'runs', label: t('col.runs'), num: true }, { key: 'ok', label: t('col.success'), num: true, sortv: r => r.ok / r.runs, fmt: (_, r) => pct(r.ok / r.runs) },
      { key: 'secs', label: t('col.avg'), num: true, sortv: r => r.secs / r.runs, fmt: (_, r) => dur(r.secs / r.runs) },
    ], Object.values(byModel), { sort: 'runs' }))),
  ));
  runsChart($('#cRuns'), runs, 30);
}

async function pageTasks() {
  const { runs } = await api('/api/runs?limit=5000');
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
  const [set, wk] = await Promise.all([api('/api/settings'), api('/api/workers')]);
  const c = set.conductor, l = set.local;
  const msg = () => h('span', { role: 'status' });
  const say = (el, ok, text) => { el.className = ok ? 'msg-ok' : 'msg-err'; el.textContent = text; };
  const save = async (body, el) => { const r = await post('/api/settings', body); say(el, r.ok, r.ok ? t('common.saved') : fmtErrors(r.errors)); return r; };
  const fld = (name, value, ph, list, id) => h('input', { id, type: 'text', name, value, placeholder: ph, list, autocomplete: 'off', spellcheck: 'false' });

  // worker models
  const dlists = h('div', {}, ['gemini', 'cursor', 'copilot', 'local'].map(id => h('datalist', { id: 'dl-' + id })));
  api('/api/models').then(m => { for (const id of ['gemini', 'cursor', 'copilot']) $('#dl-' + id)?.replaceChildren(...(m[id] || []).map(v => h('option', { value: v }))); }).catch(() => {});
  const wMsg = msg();
  const wForm = h('form', { class: 'form', onsubmit: async e => { e.preventDefault(); await save({ conductor: Object.fromEntries([...new FormData(e.target).entries()]) }, wMsg); } },
    h('label', { for: 'g' }, t('st.gemini')), fld('CONDUCTOR_MODEL_GEMINI', c.CONDUCTOR_MODEL_GEMINI, 'claude-sonnet-5-5-medium', 'dl-gemini', 'g'),
    h('div', { class: 'hint' }, t('st.geminiHint')),
    h('label', { for: 'cu' }, t('st.cursor')), fld('CONDUCTOR_MODEL_CURSOR', c.CONDUCTOR_MODEL_CURSOR, 'composer-2.5', 'dl-cursor', 'cu'),
    h('label', { for: 'co' }, t('st.copilot')), fld('CONDUCTOR_MODEL_COPILOT', c.CONDUCTOR_MODEL_COPILOT, 'auto', 'dl-copilot', 'co'),
    h('label', { for: 'to' }, t('st.timeout')), h('input', { id: 'to', type: 'number', name: 'CONDUCTOR_TIMEOUT', value: c.CONDUCTOR_TIMEOUT, placeholder: '900', min: 30, max: 7200 }),
    h('label', { for: 'ml' }, t('st.maxLines')), h('input', { id: 'ml', type: 'number', name: 'CONDUCTOR_MAX_LINES', value: c.CONDUCTOR_MAX_LINES, placeholder: '60', min: 10, max: 500 }),
    h('div', { class: 'hint' }, t('st.maxLinesHint')));

  // local endpoint
  const lMsg = msg(), testOut = h('div', { class: 'note', role: 'status', style: 'margin-top:8px' }), modelsOut = h('span', { class: 'note' });
  const showTest = r => {
    testOut.className = r.ok ? 'msg-ok' : 'msg-err';
    testOut.textContent = t('st.test.' + (r.code || (r.ok ? 'ok' : 'http_error')), { ms: r.ms, n: (r.models || []).length, status: r.status, message: r.message || '' });
  };
  const loadModels = async () => {
    modelsOut.textContent = t('st.testing');
    const r = await api('/api/local/models');
    $('#dl-local')?.replaceChildren(...(r.models || []).map(v => h('option', { value: v })));
    modelsOut.textContent = r.ok ? t('st.modelsLoaded', { n: r.models.length }) : '';
    if (!r.ok && r.code !== 'not_configured') showTest(r);
    const lm = $('#lm');
    if (lm && r.ok && r.models.length && !lm.value) lm.placeholder = `${t('wk.auto')}: ${r.models[0]}`;
  };
  const sec = (name, has, label) => [h('label', { for: name }, label), h('div', { class: 'row' },
    h('input', { id: name, type: 'password', name, placeholder: has ? t('st.secretSaved') : t('st.secretEmpty'), autocomplete: 'off' }),
    has ? h('button', { type: 'button', class: 'btn danger', onclick: async () => { const r = await save({ local: { [name]: null } }, lMsg); if (r.ok) route(); } }, t('st.remove')) : null)];
  const lForm = h('form', { class: 'form', onsubmit: async e => { e.preventDefault(); const r = await save({ local: Object.fromEntries([...new FormData(e.target).entries()]) }, lMsg); if (r.ok) await loadModels(); } },
    h('label', { for: 'lu' }, t('st.url')), h('input', { id: 'lu', type: 'url', name: 'LOCAL_URL', value: l.LOCAL_URL, placeholder: 'http://localhost:11434' }),
    h('div', { class: 'hint' }, t('st.urlHint')),
    sec('LOCAL_API_KEY', l.has_LOCAL_API_KEY, t('st.apiKey')),
    sec('CF_ACCESS_CLIENT_ID', l.has_CF_ACCESS_CLIENT_ID, t('st.cfId')),
    sec('CF_ACCESS_CLIENT_SECRET', l.has_CF_ACCESS_CLIENT_SECRET, t('st.cfSecret')),
    h('div', { class: 'hint' }, t('st.secretHint')),
    h('label', { for: 'lm' }, t('st.model')), h('div', { class: 'row' }, h('input', { id: 'lm', type: 'text', name: 'LOCAL_MODEL', value: l.LOCAL_MODEL, placeholder: t('wk.auto'), list: 'dl-local', autocomplete: 'off', spellcheck: 'false' }),
      h('button', { type: 'button', class: 'btn', onclick: loadModels }, t('st.loadModels'))),
    h('div', { class: 'hint' }, t('st.modelHint'), ' ', modelsOut));

  // toggles
  const oMsg = msg();
  const tg = (name, label, hint, def) => [h('label', { for: name }, label),
    h('div', {}, h('label', { class: 'switch' }, h('input', { id: name, type: 'checkbox', checked: (c[name] || def) === '1', onchange: e => save({ conductor: { [name]: e.target.checked ? '1' : '0' } }, oMsg) }), h('span', {}))),
    hint ? h('div', { class: 'hint' }, hint) : null];
  const oForm = h('div', { class: 'form' },
    tg('CONDUCTOR_PIXEL', t('st.pixel'), t('st.pixelHint'), '1'),
    tg('CONDUCTOR_PANEL_AUTOSTART', t('st.panelAuto'), t('st.panelAutoHint'), '1'),
    tg('CONDUCTOR_OFFICE_AUTOSTART', t('st.officeAuto'), t('st.officeAutoHint'), '0'));

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
  const sys = h('div', { class: 'tw' }, h('table', {}, h('tbody', {},
    WK_ORDER.map(id => h('tr', {}, h('td', {}, wpill(id)), h('td', {}, wk.workers[id]?.available ? '✓' : '✗'), h('td', { class: 'mono' }, wk.workers[id]?.path || wk.workers[id]?.url || '–'), h('td', {}, wk.workers[id]?.version || ''))),
    Object.entries(set.paths).map(([k, v]) => h('tr', {}, h('td', {}, pathLabel[k] || k), h('td', {}), h('td', { class: 'mono', colspan: 2 }, v))))));
  const idxLine = h('span', { class: 'note' });
  api('/api/usage?days=1').then(u => { idxLine.textContent = u.indexing.running ? t('idx.running', u.indexing) : t('st.lastScan', { ago: u.indexing.lastScan ? rel(u.indexing.lastScan / 1000) : '–', n: u.indexing.total }); }).catch(() => {});

  main.replaceChildren(h('div', {},
    pageHead(t('st.title'), t('st.sub')),
    dlists,
    h('div', { class: 'grid g2' },
      card(t('st.workers'), t('st.workersSub'), wForm, h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => wForm.requestSubmit() }, t('common.save')), wMsg)),
      card(t('st.local'), t('st.localSub'), lForm, h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => lForm.requestSubmit() }, t('common.save')),
        h('button', { class: 'btn', onclick: async () => { testOut.className = 'note'; testOut.textContent = t('st.testing'); showTest(await post('/api/local/test')); } }, t('st.test')), lMsg), testOut)),
    h('div', { class: 'grid g2 mt' },
      card(t('st.office'), null, oForm, h('div', { class: 'actions' }, oMsg)),
      card(t('st.budget'), t('st.budgetSub'), bForm, h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => bForm.requestSubmit() }, t('common.save')), bMsg))),
    h('div', { class: 'grid mt' }, card(t('st.pricing'), t('st.pricingSub'), h('div', { class: 'tw' }, pTable),
      h('div', { class: 'actions' }, newModel, h('button', { class: 'btn primary', onclick: savePricing }, t('st.savePricing')),
        h('button', { class: 'btn', onclick: async () => { const r = await save({ pricing: {} }, pMsg); if (r.ok) setTimeout(route, 600); } }, t('st.reset')), pMsg))),
    h('div', { class: 'grid mt' }, card(t('st.system'), t('st.version', { v: set.version }), sys, h('div', { class: 'actions' }, idxLine,
      h('button', { class: 'btn', onclick: async () => { await post('/api/rescan'); idxLine.textContent = t('st.rescanStarted'); } }, t('st.rescan'))))),
  ));
  if (l.LOCAL_URL) loadModels().catch(() => {});
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
