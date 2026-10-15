'use strict';
// Incremental index of Claude Code token usage from ~/.claude/projects/**/*.jsonl.
// Claude Code writes one transcript line per content block, each carrying the same message id and
// usage object, so usage is counted once per message id (keeping the field-wise maximum).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { cost } = require('./pricing');

const INDEX_VERSION = 4;

function localDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Project label from a session's cwd: the directory name, with git/agent worktrees folded into the
// repository they belong to (…/<repo>/.claude/worktrees/<name> → <repo>).
function projectName(cwd, home) {
  if (!cwd) return '(unknown)';
  if (home && path.resolve(cwd) === path.resolve(home)) return '~';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const wi = parts.lastIndexOf('worktrees');
  if (wi > 0) {
    let i = wi - 1;
    while (i > 0 && parts[i].startsWith('.')) i--;
    return parts[i];
  }
  return parts[parts.length - 1] || cwd;
}

// Name sessions after their git repository when the directory still exists: a subfolder or a
// worktree (whose .git is a file pointing into the main repo) counts as the repo itself.
const rootCache = new Map();
function repoName(cwd, home) {
  if (!cwd) return projectName(cwd, home);
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let name = null;
  try {
    let dir = path.resolve(cwd);
    const stop = home ? path.resolve(home) : path.parse(dir).root;
    while (dir && dir !== stop && dir !== path.dirname(dir)) {
      const g = path.join(dir, '.git');
      let st = null;
      try { st = fs.statSync(g); } catch {}
      if (st && st.isDirectory()) { name = path.basename(dir); break; }
      if (st && st.isFile()) {
        const m = fs.readFileSync(g, 'utf8').match(/gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/);
        name = m ? path.basename(m[1].trim()) : path.basename(dir);
        break;
      }
      dir = path.dirname(dir);
    }
  } catch {}
  if (!name) name = projectName(cwd, home);
  rootCache.set(cwd, name);
  return name;
}

function normModel(m) { return String(m).replace(/\[.*\]$/, '').replace(/-\d{8}$/, ''); }

class UsageIndex {
  constructor({ projectsDir, indexFile, home, resolveRepos = true }) {
    this.resolveRepos = resolveRepos;
    this.projectsDir = projectsDir;
    this.indexFile = indexFile;
    this.home = home;
    this.progress = { running: false, done: 0, total: 0, lastScan: 0, error: null };
    this.data = { version: INDEX_VERSION, files: {}, daily: {}, sessions: {} };
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (j && j.version === INDEX_VERSION) this.data = j;
    } catch {}
  }

  ingestLine(line, f) {
    if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) return false;
    let d;
    try { d = JSON.parse(line); } catch { return false; }
    if (d.type !== 'assistant') return false;
    const m = d.message, u = m && m.usage;
    if (!u || !m.id || !m.model || m.model === '<synthetic>') return false;
    const cc = u.cache_creation;
    const cw5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
    const cw1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
    const vals = [u.input_tokens || 0, u.output_tokens || 0, cw5, cw1, u.cache_read_input_tokens || 0];
    const prev = f.recent[m.id];
    const delta = vals.map((v, i) => Math.max(0, v - (prev ? prev[i] : 0)));
    if (prev && delta.every(x => x === 0)) return false;
    f.recent[m.id] = prev ? vals.map((v, i) => Math.max(v, prev[i])) : vals;
    f.order.push(m.id);
    if (f.order.length > 300) delete f.recent[f.order.shift()];

    const date = localDate(d.timestamp);
    if (!date) return false;
    let model = normModel(m.model);
    if (model.startsWith('claude-haiku-5-5') && vals[0] + vals[2] + vals[3] + vals[4] > 100000) model = 'claude-haiku-5-5@long';
    const project = this.resolveRepos ? repoName(d.cwd, this.home) : projectName(d.cwd, this.home);
    const side = d.isSidechain ? 1 : 0;
    const speed = u.speed === 'fast' ? 'f' : 's';
    const key = [date, project, model, side, speed].join('|');
    const b = this.data.daily[key] || (this.data.daily[key] = [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 5; i++) b[i] += delta[i];
    if (!prev) b[5]++;
    const sid = d.sessionId || d.session_id;
    if (sid) {
      const s = this.data.sessions[sid] || (this.data.sessions[sid] = { p: project, first: d.timestamp, last: d.timestamp, n: 0, m: {} });
      if (d.timestamp < s.first) s.first = d.timestamp;
      if (d.timestamp > s.last) s.last = d.timestamp;
      if (!side) s.p = project;
      const mk = model + '|' + speed;
      const sm = s.m[mk] || (s.m[mk] = [0, 0, 0, 0, 0]);
      for (let i = 0; i < 5; i++) sm[i] += delta[i];
      if (!prev) s.n++;
    }
    return true;
  }

  async scanFile(file) {
    let st;
    try { st = await fsp.stat(file); } catch { return false; }
    let f = this.data.files[file];
    if (!f || st.size < f.offset) f = this.data.files[file] = { offset: 0, partial: '', recent: {}, order: [] };
    if (st.size === f.offset) return false;
    const fh = await fsp.open(file, 'r');
    let changed = false;
    try {
      const CHUNK = 4 * 1024 * 1024;
      while (f.offset < st.size) {
        const len = Math.min(CHUNK, st.size - f.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        const lines = (f.partial + buf.toString('utf8', 0, bytesRead)).split('\n');
        f.partial = lines.pop();
        if (f.partial.length > 8 * 1024 * 1024) f.partial = '';
        for (const line of lines) if (this.ingestLine(line, f)) changed = true;
      }
    } finally { await fh.close(); }
    return changed;
  }

  async scan() {
    if (this.progress.running) return;
    const p = this.progress;
    p.running = true; p.error = null;
    try {
      const files = await walk(this.projectsDir, []);
      p.total = files.length; p.done = 0;
      let changed = false;
      for (const file of files) { if (await this.scanFile(file)) changed = true; p.done++; }
      const live = new Set(files);
      for (const k of Object.keys(this.data.files)) if (!live.has(k)) delete this.data.files[k];
      if (changed && this.indexFile) {
        await fsp.writeFile(this.indexFile + '.tmp', JSON.stringify(this.data));
        await fsp.rename(this.indexFile + '.tmp', this.indexFile);
      }
    } catch (e) { p.error = String(e && e.message || e); }
    p.running = false; p.lastScan = Date.now();
  }

  report(days, projectFilter, table, now = Date.now()) {
    const today = localDate(now);
    const from = days > 0 ? localDate(now - (days - 1) * 86400000) : '0000-00-00';
    const monthStart = today.slice(0, 8) + '01';
    const zero = () => ({ in: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 });
    const add = (acc, b, c) => { acc.in += b[0]; acc.out += b[1]; acc.cw += b[2] + b[3]; acc.cr += b[4]; acc.msgs += b[5] || 0; acc.cost += c || 0; };
    const totals = zero(), todayT = zero(), monthT = zero(), sideT = zero();
    const byDay = {}, byModel = {}, byProject = {}, projects = new Set(), unpriced = new Set();
    for (const [key, b] of Object.entries(this.data.daily)) {
      const [date, project, model, side, speed] = key.split('|');
      projects.add(project);
      if (projectFilter && project !== projectFilter) continue;
      const c = cost(b, model, speed, table);
      if (c === null) unpriced.add(model);
      if (date === today) add(todayT, b, c);
      if (date >= monthStart) add(monthT, b, c);
      if (date < from) continue;
      add(totals, b, c);
      if (side === '1') add(sideT, b, c);
      const dm = (byDay[date] = byDay[date] || {});
      add(dm[model] = dm[model] || zero(), b, c);
      add(byModel[model] = byModel[model] || zero(), b, c);
      add(byProject[project] = byProject[project] || zero(), b, c);
    }
    const sessions = [];
    for (const [sid, s] of Object.entries(this.data.sessions)) {
      if (projectFilter && s.p !== projectFilter) continue;
      if (localDate(s.last) < from) continue;
      const t = zero(); const models = new Set();
      for (const [mk, v] of Object.entries(s.m)) {
        const [model, speed] = mk.split('|'); models.add(model);
        add(t, [...v, 0], cost(v, model, speed, table));
      }
      t.msgs = s.n;
      sessions.push({ id: sid, project: s.p, first: s.first, last: s.last, models: [...models], ...t });
    }
    sessions.sort((a, b) => b.cost - a.cost);
    const list = o => Object.entries(o).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.cost - a.cost);
    const daysOut = [];
    if (days > 0) for (let i = days - 1; i >= 0; i--) { const d = localDate(now - i * 86400000); daysOut.push({ date: d, models: byDay[d] || {} }); }
    else for (const d of Object.keys(byDay).sort()) daysOut.push({ date: d, models: byDay[d] });
    return {
      days: daysOut, totals, today: todayT, month: monthT, subagents: sideT,
      byModel: list(byModel), byProject: list(byProject), sessions: sessions.slice(0, 200), sessionCount: sessions.length,
      projects: [...projects].sort(), unpriced: [...unpriced], indexing: { ...this.progress },
    };
  }
}

async function walk(dir, out) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

module.exports = { UsageIndex, projectName, repoName, localDate, normModel };
