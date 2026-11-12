import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  arc1Spec,
  buildCommand,
  describeCommand,
  isArc1Entry,
  mergeEntry,
  parseText,
  RUNNER_SPEC,
  sampleDocument,
  serialize,
  stripJsonc,
  writeMcpFile,
} from '../src/mcpfile.js';

test('round-trips formatting: BOM, CRLF, tabs, no final newline', () => {
  const samples = [
    '{\n  "mcpServers": {\n    "a": {\n      "command": "npx"\n    }\n  }\n}\n',
    '﻿{\r\n\t"mcpServers": {\r\n\t\t"a": {\r\n\t\t\t"command": "npx"\r\n\t\t}\r\n\t}\r\n}',
    '{\n    "other": 1,\n    "mcpServers": {}\n}\n',
  ];
  for (const text of samples) {
    const { doc, format } = parseText(text);
    assert.equal(serialize(doc, format), text);
  }
});

test('detects root key for Claude (mcpServers) and VS Code (servers)', () => {
  assert.equal(parseText('{"servers":{}}').rootKey, 'servers');
  assert.equal(parseText('{"mcpServers":{}}').rootKey, 'mcpServers');
  assert.equal(parseText('').rootKey, 'mcpServers');
});

test('accepts JSONC but keeps strings intact', () => {
  const text = '{\n  // comment\n  "mcpServers": { "a": { "command": "x // not a comment", "args": ["a,}"], }, },\n}';
  const { doc, format } = parseText(text);
  assert.equal(format.jsonc, true);
  assert.equal(doc.mcpServers.a.command, 'x // not a comment');
  assert.deepEqual(doc.mcpServers.a.args, ['a,}']);
  assert.equal(stripJsonc('{"a": "/* keep */"}'), '{"a": "/* keep */"}');
});

test('rejects a non-object root', () => {
  assert.throws(() => parseText('[1,2]'), /root element/i);
  assert.throws(() => parseText('{"a":'), SyntaxError);
});

test('recognises ARC-1 entries', () => {
  assert.ok(isArc1Entry({ command: 'npx', args: ['-y', 'arc-1'] }));
  assert.ok(isArc1Entry({ command: 'cmd', args: ['/c', 'npx', '-y', 'arc-1@1.10.1'] }));
  assert.ok(isArc1Entry({ command: 'docker', args: ['run', 'ghcr.io/arc-mcp/arc-1:latest'] }));
  assert.ok(isArc1Entry({ command: 'node', args: ['x.js'], env: { SAP_URL: 'https://h' } }));
  assert.ok(!isArc1Entry({ command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] }));
  assert.ok(!isArc1Entry({ type: 'http', url: 'https://example.com/mcp' }));
});

test('describes and rebuilds commands (cmd and plain, wrapped and not)', () => {
  const plain = describeCommand({ command: 'npx', args: ['-y', 'arc-1'] });
  assert.deepEqual(plain, { style: 'plain', wrapped: false, inner: ['npx', '-y', 'arc-1'] });
  const win = describeCommand({ command: 'cmd', args: ['/c', 'npx', '-y', 'arc-1'] });
  assert.deepEqual(win, { style: 'cmd', wrapped: false, inner: ['npx', '-y', 'arc-1'] });

  const wrapped = buildCommand(['npx', '-y', 'arc-1@1.10.1'], 'cmd', true);
  assert.deepEqual(wrapped, { command: 'cmd', args: ['/c', 'npx', '-y', RUNNER_SPEC, 'run', '--', 'npx', '-y', 'arc-1@1.10.1'] });
  const back = describeCommand(wrapped);
  assert.equal(back.wrapped, true);
  assert.equal(back.style, 'cmd');
  assert.equal(back.runnerSpec, RUNNER_SPEC);
  assert.deepEqual(back.inner, ['npx', '-y', 'arc-1@1.10.1']);
  assert.deepEqual(buildCommand(back.inner, back.style, false), { command: 'cmd', args: ['/c', 'npx', '-y', 'arc-1@1.10.1'] });

  const posix = buildCommand(['npx', '-y', 'arc-1'], 'plain', true, 'arc1-connection-manager@1.2.0');
  assert.deepEqual(posix, { command: 'npx', args: ['-y', 'arc1-connection-manager@1.2.0', 'run', '--', 'npx', '-y', 'arc-1'] });
  // a bogus runner spec is replaced by the default one
  assert.equal(buildCommand(['x'], 'plain', true, 'evil-package').args[1], RUNNER_SPEC);
});

test('finds the ARC-1 version a command runs', () => {
  assert.equal(arc1Spec(['npx', '-y', 'arc-1@1.10.1']), 'arc-1@1.10.1');
  assert.equal(arc1Spec(['npx', '-y', 'arc-1']), 'arc-1');
  assert.equal(arc1Spec(['node', 'dist/index.js']), null);
});

test('mergeEntry keeps unknown fields and key order', () => {
  const merged = mergeEntry({ type: 'stdio', command: 'a', args: [], env: {}, timeout: 5 }, { command: 'b', args: ['x'], env: { A: '1' } });
  assert.deepEqual(Object.keys(merged), ['type', 'command', 'args', 'env', 'timeout']);
  assert.equal(merged.command, 'b');
  assert.equal(merged.timeout, 5);
});

test('sample document matches the platform', () => {
  assert.equal(sampleDocument('win32').mcpServers['sap-dev'].command, 'cmd');
  assert.equal(sampleDocument('linux').mcpServers['sap-dev'].command, 'npx');
});

test('writeMcpFile keeps a .bak copy and the file mode', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc1cm-'));
  const p = join(dir, '.mcp.json');
  writeFileSync(p, '{"old":true}', { mode: 0o640 });
  await writeMcpFile(p, '{"new":true}\n');
  assert.equal(readFileSync(p, 'utf8'), '{"new":true}\n');
  assert.equal(readFileSync(`${p}.bak`, 'utf8'), '{"old":true}');
  assert.equal(statSync(p).mode & 0o777, 0o640);
});
