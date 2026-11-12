import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { quoteWin } from '../src/runner.js';
import { accountFor } from '../src/secrets.js';

const BIN = fileURLToPath(new URL('../bin/arc1-connection-manager.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'arc1cm-run-'));
const keyring = join(dir, 'keyring.json');
const fake = join(dir, 'fake-mcp.cjs');
writeFileSync(
  fake,
  `process.stderr.write('pw=' + process.env.SAP_PASSWORD + '\\n');
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); process.stdout.write(JSON.stringify({ echo: JSON.parse(l) }) + '\\n'); } });
process.stdin.on('end', () => process.exit(7));`,
);

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SAP|ARC1)_/.test(k)));

function run(env, input = '') {
  return spawnSync(process.execPath, [BIN, 'run', '--', process.execPath, fake], {
    input,
    encoding: 'utf8',
    env: { ...cleanEnv, ARC1CM_TEST_KEYRING_FILE: keyring, ...env },
  });
}

test('accountFor normalises the connection identity', () => {
  assert.equal(accountFor({ SAP_URL: 'https://Host.Example.com:44300/', SAP_USER: 'dev' }), 'DEV@https://host.example.com:44300?client=100');
  assert.equal(accountFor({ SAP_URL: 'https://h', SAP_USER: 'u', SAP_CLIENT: '200' }), 'U@https://h?client=200');
  assert.equal(accountFor({ SAP_URL: 'https://h/sap/', SAP_USER: 'u' }), 'U@https://h/sap?client=100');
  assert.equal(accountFor({ SAP_URL: 'not a url', SAP_USER: 'u' }), null);
  assert.equal(accountFor({ SAP_URL: 'https://h' }), null);
});

test('run injects the stored password and passes MCP stdio through untouched', () => {
  writeFileSync(keyring, JSON.stringify({ 'DEV@https://h:1?client=100': 'p@ss wört' }));
  const msgs = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';
  const r = run({ SAP_URL: 'https://h:1/', SAP_USER: 'dev' }, msgs);
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stderr, /pw=p@ss wört/);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.echo.id),
    [1, 2],
  );
});

test('run fails clearly when no password is stored', () => {
  writeFileSync(keyring, '{}');
  const r = run({ SAP_URL: 'https://h:1', SAP_USER: 'dev' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No password is stored for DEV@https:\/\/h:1\?client=100/);
  assert.equal(r.stdout, '');
});

test('an explicit SAP_PASSWORD wins over the store', () => {
  writeFileSync(keyring, JSON.stringify({ 'DEV@https://h:1?client=100': 'stored' }));
  const r = run({ SAP_URL: 'https://h:1', SAP_USER: 'dev', SAP_PASSWORD: 'explicit' });
  assert.match(r.stderr, /pw=explicit/);
});

test('quoteWin quotes only when needed', () => {
  assert.equal(quoteWin('npx'), 'npx');
  assert.equal(quoteWin('arc-1@1.10.1'), 'arc-1@1.10.1');
  assert.equal(quoteWin('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  assert.equal(quoteWin('a"b'), '"a""b"');
  assert.equal(quoteWin(''), '""');
});
