import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Isolate settings and the credential store before the server modules load.
const root = mkdtempSync(join(tmpdir(), 'arc1cm-srv-'));
const ws = join(root, 'ws');
mkdirSync(ws);
const keyring = join(root, 'keyring.json');
process.env.ARC1CM_TEST_KEYRING_FILE = keyring;
process.env.XDG_CONFIG_HOME = join(root, 'cfg');
process.env.APPDATA = join(root, 'appdata');
const { startServer } = await import('../src/server.js');

let srv;
let base;
let sap;
let sapPort;

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-ARC1CM-Token': srv.token, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

before(async () => {
  srv = await startServer({ cwd: ws, keepAlive: true });
  base = `http://127.0.0.1:${srv.port}`;
  // A fake SAP ADT endpoint.
  sap = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/sap/bc/adt/discovery') return res.writeHead(404).end();
    if (url.searchParams.get('sap-client') === '302') return res.writeHead(302, { Location: '/saml' }).end();
    const ok = req.headers.authorization === `Basic ${Buffer.from('DEV:right').toString('base64')}`;
    res.writeHead(ok ? 200 : 401).end();
  });
  await new Promise((r) => sap.listen(0, '127.0.0.1', r));
  sapPort = sap.address().port;
});

after(async () => {
  await srv.close();
  sap.close();
});

test('API needs the session token, a loopback Host and a same-origin caller', async () => {
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
  assert.equal((await call('GET', '/api/bootstrap', null, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/bootstrap', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const hostCheck = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: '/api/bootstrap', headers: { Host: 'attacker.example', 'X-ARC1CM-Token': srv.token } }, (r) => resolve(r.statusCode));
  });
  assert.equal(hostCheck, 403);
  const ok = await call('GET', '/api/bootstrap');
  assert.equal(ok.status, 200);
  assert.ok(ok.json.catalog.settings.SAP_ALLOW_WRITES);
});

test('static files are served with a CSP and no path traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});

test('create, store the password in the credential store, and move it back to the file', async () => {
  const created = await call('POST', '/api/file/create', { dir: ws });
  assert.equal(created.status, 200);
  const m = created.json;
  assert.equal(m.servers[0].name, 'sap-dev');
  const path = m.path;

  const entry = structuredClone(m.servers[0].entry);
  entry.env.SAP_USER = 'dev';
  entry.env.SAP_ALLOW_WRITES = 'true';
  const save1 = await call('POST', '/api/file/save', {
    path,
    baseHash: m.hash,
    rootKey: m.rootKey,
    format: m.format,
    servers: [{ name: 'sap-dev', arc1: true, entry, inner: ['npx', '-y', 'arc-1'], style: 'plain', mode: 'store', password: 's3cret' }],
  });
  assert.equal(save1.status, 200, JSON.stringify(save1.json));
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  const srvEntry = onDisk.mcpServers['sap-dev'];
  assert.equal(srvEntry.command, 'npx');
  assert.deepEqual(srvEntry.args, ['-y', 'arc1-connection-manager@1', 'run', '--', 'npx', '-y', 'arc-1']);
  assert.equal(srvEntry.env.SAP_PASSWORD, undefined);
  assert.equal(JSON.parse(readFileSync(keyring, 'utf8'))['DEV@https://sap-host:44300?client=100'], 's3cret');
  const m2 = save1.json.model;
  assert.equal(m2.servers[0].wrapped, true);
  assert.equal(m2.servers[0].stored, true);

  // a stale base hash is a conflict
  const stale = await call('POST', '/api/file/save', { path, baseHash: m.hash, rootKey: 'mcpServers', servers: [] });
  assert.deepEqual(stale.json, { conflict: true });

  // reveal only works for accounts in the open file
  assert.equal((await call('POST', '/api/secret/reveal', { account: 'X@https://other?client=1' })).status, 403);
  assert.equal((await call('POST', '/api/secret/reveal', { account: m2.servers[0].account })).json.password, 's3cret');

  // back to the file: the stored password is written into env again, command unwrapped
  const save2 = await call('POST', '/api/file/save', {
    path,
    baseHash: m2.hash,
    rootKey: m2.rootKey,
    format: m2.format,
    servers: [{ ...m2.servers[0], mode: 'file', wasWrapped: true, originalAccount: m2.servers[0].account }],
  });
  assert.equal(save2.status, 200);
  const back = JSON.parse(readFileSync(path, 'utf8')).mcpServers['sap-dev'];
  assert.deepEqual(back.args, ['-y', 'arc-1']);
  assert.equal(back.env.SAP_PASSWORD, 's3cret');
  assert.equal(Object.keys(back.env).indexOf('SAP_PASSWORD'), Object.keys(back.env).indexOf('SAP_USER') + 1);
});

test('store mode without a password is refused unless explicitly allowed', async () => {
  const p = join(ws, 'b.json');
  writeFileSync(p, '{}');
  const m = (await call('POST', '/api/file/open', { path: p })).json;
  const body = {
    path: p,
    baseHash: m.hash,
    rootKey: 'mcpServers',
    servers: [{ name: 'x', arc1: true, entry: { env: { SAP_URL: 'https://nopw', SAP_USER: 'u' } }, inner: ['npx', '-y', 'arc-1'], style: 'plain', mode: 'store' }],
  };
  const r = await call('POST', '/api/file/save', body);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.key, 'msg.pwd.missing');
  const r2 = await call('POST', '/api/file/save', { ...body, allowMissing: true });
  assert.equal(r2.status, 200);
});

test('other MCP servers and other root keys are preserved byte for byte', async () => {
  const p = join(ws, 'mixed.json');
  const original = {
    $schema: 'x',
    mcpServers: {
      github: { type: 'stdio', command: 'docker', args: ['run', 'gh'], env: { TOKEN: 'abc' } },
      'sap-dev': { command: 'npx', args: ['-y', 'arc-1'], env: { SAP_URL: 'https://h', SAP_CLIENT: '100' }, timeout: 30 },
    },
    other: [1, 2, 3],
  };
  writeFileSync(p, `${JSON.stringify(original, null, 4)}\n`);
  const m = (await call('POST', '/api/file/open', { path: p })).json;
  const servers = m.servers.map((s) => ({ ...s, mode: 'file' }));
  servers[1].entry.env.SAP_CLIENT = '200';
  const r = await call('POST', '/api/file/save', { path: p, baseHash: m.hash, rootKey: m.rootKey, format: m.format, servers });
  assert.equal(r.status, 200);
  const text = readFileSync(p, 'utf8');
  const expected = structuredClone(original);
  expected.mcpServers['sap-dev'].env.SAP_CLIENT = '200';
  assert.equal(text, `${JSON.stringify(expected, null, 4)}\n`);
  assert.ok(readFileSync(`${p}.bak`, 'utf8').includes('"SAP_CLIENT": "100"'));
});

test('connection test maps SAP answers', async () => {
  const env = { SAP_URL: `http://127.0.0.1:${sapPort}`, SAP_USER: 'DEV' };
  assert.equal((await call('POST', '/api/test', { env: { ...env, SAP_PASSWORD: 'right' } })).json.kind, 'ok');
  assert.equal((await call('POST', '/api/test', { env: { ...env, SAP_PASSWORD: 'wrong' } })).json.kind, '401');
  assert.equal((await call('POST', '/api/test', { env: { ...env, SAP_CLIENT: '302' } })).json.kind, 'redirect');
  assert.equal((await call('POST', '/api/test', { env: { SAP_URL: 'ftp://x' } })).json.kind, 'badurl');
  assert.equal((await call('POST', '/api/test', { env: { SAP_URL: 'http://127.0.0.1:1' } })).json.kind, 'refused');
  process.env.ARC1CM_TEST_PW = 'right';
  assert.equal((await call('POST', '/api/test', { env: { ...env, SAP_PASSWORD: '${ARC1CM_TEST_PW}' } })).json.kind, 'ok');
});

test('the file browser lists folders and JSON files only', async () => {
  writeFileSync(join(ws, 'notes.txt'), 'x');
  const r = await call('POST', '/api/fs/list', { path: ws });
  assert.equal(r.status, 200);
  const names = r.json.entries.map((e) => e.name);
  assert.ok(names.includes('.mcp.json'));
  assert.ok(!names.includes('notes.txt'));
  assert.equal(r.json.entries.find((e) => e.name === '.mcp.json').mcp, true);
});

test('settings are stored per user', async () => {
  const r = await call('POST', '/api/settings', { theme: 'light', lang: 'tr', bogus: 1 });
  assert.equal(r.json.theme, 'light');
  assert.equal(r.json.lang, 'tr');
  assert.equal(r.json.bogus, undefined);
});
