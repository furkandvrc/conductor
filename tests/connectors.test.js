'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { slug, toolName, selectConnectors, parseRpcBody, createBridge, serve } = require('../lib/connectors');

test('tool names stay short, legal and unique', () => {
  assert.strictEqual(slug('Google Cloud BigQuery'), 'google_cloud_bigquery');
  assert.strictEqual(slug('monday.com'), 'monday_com');
  assert.strictEqual(toolName('second', 'Figma', 'get_screenshot'), 'second_figma__get_screenshot');
  assert.strictEqual(toolName('second', 'chrome', 'tabs_context_mcp'), 'second_chrome__tabs_context_mcp');
  const long = toolName('work-account-two', 'A Very Long Connector Display Name Here', 'x'.repeat(120));
  assert.ok(long.length <= 96, long);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
  assert.notStrictEqual(long, toolName('work-account-two', 'A Very Long Connector Display Name Here', 'x'.repeat(119) + 'y'));
});

test('only connectors the active account lacks are bridged', () => {
  const docs = { id: 'srv_docs', display_name: 'Claude Docs', url: 'https://api.anthropic.com/v1/pages/mcp' };
  const figMain = { id: 'srv_fig1', display_name: 'Figma', url: 'https://mcp.figma.com/mcp' };
  const figSecond = { id: 'srv_fig2', display_name: 'Figma', url: 'https://mcp.figma.com/mcp' };
  const notion = { id: 'srv_notion', display_name: 'Notion', url: 'https://mcp.notion.com/mcp', eligible: true };
  const asana = { id: 'srv_asana', display_name: 'Asana', url: 'https://mcp.asana.com', eligible: false };
  const linear = { id: 'srv_linear', display_name: 'Linear', url: 'https://mcp.linear.app' };
  const picked = selectConnectors([
    { account: 'main', connectors: [docs, figMain] },
    { account: 'second', connectors: [docs, figSecond, notion, asana, linear] },
    { account: 'third', connectors: [linear, { ...notion, id: 'srv_notion3' }] },
  ], 'main', [docs, figMain]);
  assert.deepStrictEqual(picked.map(p => `${p.account}:${p.name}`), ['second:Notion', 'second:Linear']);
});

test('streamable HTTP bodies: JSON and SSE', () => {
  assert.deepStrictEqual(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', 3).result, { ok: 1 });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n';
  assert.deepStrictEqual(parseRpcBody(sse, 7).result, { tools: [] });
  assert.strictEqual(parseRpcBody(sse, 8), null);
  assert.strictEqual(parseRpcBody('', 1), null);
});

// ---------- the bridge with fake accounts, a fake API and a fake browser ----------
function fakeFetch({ lists, tools, calls }) {
  return async (url, init) => {
    const auth = init.headers.Authorization.replace('Bearer ', '');
    if (url.includes('/v1/mcp_servers')) {
      const data = lists[auth];
      return data ? { ok: true, status: 200, json: async () => ({ data, next_page: null }) } : { ok: false, status: 401, json: async () => ({}) };
    }
    const id = decodeURIComponent(url.split('/v1/mcp/')[1]);
    assert.ok(init.headers['X-Mcp-Client-Session-Id'], 'the proxy needs X-Mcp-Client-Session-Id');
    const body = JSON.parse(init.body);
    const reply = result => ({ status: 200, headers: { get: () => null }, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n` });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {} });
    if (!('id' in body)) return { status: 202, headers: { get: () => null }, text: async () => '' };
    if (body.method === 'tools/list') return reply({ tools: tools[id] || [] });
    if (body.method === 'tools/call') { calls.push({ id, token: auth, name: body.params.name }); return reply({ content: [{ type: 'text', text: `${id}:${body.params.name}` }] }); }
    throw new Error('unexpected ' + body.method);
  };
}
function fakeChrome(browsersByAccount, started) {
  return ({ getToken }) => {
    let token = null;
    return {
      async request(method, params) {
        token = await getToken();
        started.push(token);
        if (method === 'tools/list') return { tools: [{ name: 'navigate', description: 'Go to a URL', inputSchema: { type: 'object' } }] };
        if (params.name === 'list_connected_browsers') return { content: [{ type: 'text', text: JSON.stringify(browsersByAccount[token] || []) }] };
        return { content: [{ type: 'text', text: `chrome@${token}:${params.name}` }] };
      },
      stop() {},
    };
  };
}
function setupBridge(state, env = {}, cacheFile) {
  const lists = {
    tokMain: [{ id: 'srv_docs', display_name: 'Claude Docs', url: 'u/docs' }],
    tokSecond: [{ id: 'srv_docs', display_name: 'Claude Docs', url: 'u/docs' }, { id: 'srv_fig', display_name: 'Figma', url: 'u/figma', eligible: true }, { id: 'srv_off', display_name: 'Box', url: 'u/box', eligible: false }],
  };
  const tools = { srv_fig: [{ name: 'whoami', description: 'Who am I', inputSchema: { type: 'object' } }], srv_docs: [{ name: 'read', inputSchema: { type: 'object' } }] };
  const calls = [], started = [];
  const manager = {
    async tokens() {
      return {
        active: state.active,
        current: state.active === 'main' ? 'tokMain' : 'tokSecond',
        accounts: [
          { name: 'main', active: state.active === 'main', token: 'tokMain', scopes: ['user:mcp_servers'] },
          { name: 'second', active: state.active === 'second', token: 'tokSecond', scopes: ['user:mcp_servers'] },
        ],
      };
    },
  };
  const bridge = createBridge({ env, manager, fetch: fakeFetch({ lists, tools, calls }), chromeClient: fakeChrome({ tokSecond: [{ deviceId: 'd2' }] }, started), cacheFile });
  return { bridge, calls, started };
}

test('bridge exposes the other account\'s connectors and browser, and calls them with its token', async () => {
  const state = { active: 'main' };
  const { bridge, calls } = setupBridge(state);
  await bridge.discover();
  const names = bridge.list().map(t => t.name).sort();
  assert.deepStrictEqual(names, ['second_chrome__navigate', 'second_figma__whoami']);
  assert.match(bridge.list().find(t => t.name === 'second_figma__whoami').description, /via Claude account "second"/);
  const r = await bridge.callTool('second_figma__whoami', {});
  assert.strictEqual(r.content[0].text, 'srv_fig:whoami');
  assert.deepStrictEqual(calls, [{ id: 'srv_fig', token: 'tokSecond', name: 'whoami' }]);
  const c = await bridge.callTool('second_chrome__navigate', { url: 'x' });
  assert.strictEqual(c.content[0].text, 'chrome@tokSecond:navigate');
  const bad = await bridge.callTool('nope', {});
  assert.strictEqual(bad.isError, true);
});

test('when the other account becomes active, the bridge hands its tools back to Claude Code', async () => {
  const state = { active: 'main' };
  const { bridge } = setupBridge(state);
  await bridge.discover();
  state.active = 'second';
  await bridge.discover();
  // main has no browser and only Claude Docs, which second has too: nothing to bridge
  assert.deepStrictEqual(bridge.list(), []);
});

test('a slow, older discovery never overwrites a newer one', async () => {
  const state = { active: 'main' };
  const { bridge } = setupBridge(state);
  const first = bridge.discover();      // sees main active: second's tools
  state.active = 'second';
  const second = bridge.discover();     // sees second active: nothing
  await Promise.all([second, first]);
  assert.deepStrictEqual(bridge.list(), []);
});

test('the browser probe is shared through the cache file, not repeated by every session', async () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-bridge-'));
  const cache = path.join(dir, 'cache.json');
  const a = setupBridge({ active: 'main' }, {}, cache);
  await a.bridge.discover();
  assert.ok(a.started.length >= 1);
  const b = setupBridge({ active: 'main' }, {}, cache); // a second session
  await b.bridge.discover();
  assert.strictEqual(b.started.length, 0);
  assert.ok(b.bridge.list().some(t => t.name === 'second_chrome__navigate'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the browser part can be switched off', async () => {
  const { bridge } = setupBridge({ active: 'main' }, { CONDUCTOR_ACCOUNT_CHROME: '0' });
  await bridge.discover();
  assert.deepStrictEqual(bridge.list().map(t => t.name), ['second_figma__whoami']);
});

test('MCP over stdio: initialize, tools/list, tools/call, list_changed on an account switch', async () => {
  const state = { active: 'main' };
  const { bridge } = setupBridge(state);
  const input = new PassThrough(), output = new PassThrough();
  let fp = 'a';
  const origExit = process.exit;
  process.exit = () => {};
  const msgs = [];
  let buf = '';
  output.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  serve({ bridge, input, output, fingerprint: () => fp, pollMs: 20 });
  const send = m => input.write(JSON.stringify(m) + '\n');
  const waitFor = async pred => { for (let i = 0; i < 200; i++) { const m = msgs.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const init = await waitFor(m => m.id === 1);
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.strictEqual(init.result.capabilities.tools.listChanged, true);
    assert.match(init.result.instructions, /_chrome__/);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tl = await waitFor(m => m.id === 2);
    assert.strictEqual(tl.result.tools.length, 2);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'second_figma__whoami', arguments: {} } });
    assert.strictEqual((await waitFor(m => m.id === 3)).result.content[0].text, 'srv_fig:whoami');
    input.write('null\n[]\n42\n');
    send({ jsonrpc: '2.0', id: 4, method: 'bogus' });
    assert.strictEqual((await waitFor(m => m.id === 4)).error.code, -32601);
    state.active = 'second'; fp = 'b';
    await waitFor(m => m.method === 'notifications/tools/list_changed');
    send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    assert.deepStrictEqual((await waitFor(m => m.id === 5)).result.tools, []);
  } finally {
    input.end();
    await new Promise(r => setTimeout(r, 30));
    process.exit = origExit;
  }
});
