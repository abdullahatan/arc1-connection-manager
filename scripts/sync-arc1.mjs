#!/usr/bin/env node
// Regenerates catalog/arc1.json from ARC-1's own source code and checks the
// curated catalog (catalog/catalog.json) against it.
//
//   node scripts/sync-arc1.mjs --npm latest --write        download ARC-1 from npm, parse dist/
//   node scripts/sync-arc1.mjs --dir ../arc-1 --write      parse a local checkout (src/) or package (dist/)
//   node scripts/sync-arc1.mjs --check                     compare catalog.json with arc1.json
//   ... --report out.md                                    write a Markdown summary (used for PR bodies)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCatalog } from '../src/catalog.js';
import { parseArc1 } from './arc1-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARC1_JSON = join(ROOT, 'catalog', 'arc1.json');
const CATALOG_JSON = join(ROOT, 'catalog', 'catalog.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function walk(dir, ext, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, ext, out);
    } else if (e.name.endsWith(ext) && !e.name.endsWith('.d.ts') && !e.name.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

function loadFromDir(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  let base;
  let ext;
  if (existsSync(join(dir, 'src', 'server', 'config.ts'))) {
    base = join(dir, 'src');
    ext = '.ts';
  } else if (existsSync(join(dir, 'dist', 'server', 'config.js'))) {
    base = join(dir, 'dist');
    ext = '.js';
  } else {
    throw new Error(`No ARC-1 sources found in ${dir} (expected src/server/config.ts or dist/server/config.js)`);
  }
  const config = readFileSync(join(base, 'server', `config${ext}`), 'utf8');
  const types = readFileSync(join(base, 'server', `types${ext}`), 'utf8');
  const files = walk(base, ext).map((p) => ({ path: relative(base, p), text: readFileSync(p, 'utf8') }));
  return { version: pkg.version, from: `${pkg.name}@${pkg.version} (${relative(dir, base)}/)`, config, types, files };
}

function loadFromNpm(spec) {
  const tmp = mkdtempSync(join(tmpdir(), 'arc1-sync-'));
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const out = execFileSync(npm, ['pack', `arc-1@${spec}`, '--silent', '--pack-destination', tmp], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const tgz = out.trim().split('\n').pop();
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
    return loadFromDir(join(tmp, 'package'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function diff(prev, next) {
  const lines = [];
  const keys = (o) => new Set(Object.keys(o || {}));
  const section = (title, a, b) => {
    const added = [...b].filter((k) => !a.has(k));
    const removed = [...a].filter((k) => !b.has(k));
    if (added.length) lines.push(`- **${title} added:** ${added.map((k) => `\`${k}\``).join(', ')}`);
    if (removed.length) lines.push(`- **${title} removed:** ${removed.map((k) => `\`${k}\``).join(', ')}`);
  };
  section('Settings', keys(prev?.env), keys(next.env));
  section('Startup-blocking legacy keys', keys(prev?.legacy), keys(next.legacy));
  section('Startup-blocking retired keys', keys(prev?.retired), keys(next.retired));
  section('Ignored keys', keys(prev?.ignored), keys(next.ignored));
  for (const k of Object.keys(next.env)) {
    const a = prev?.env?.[k];
    const b = next.env[k];
    if (!a) continue;
    if (a.default !== b.default) lines.push(`- \`${k}\` default: \`${a.default}\` → \`${b.default}\``);
    if (JSON.stringify(a.options) !== JSON.stringify(b.options))
      lines.push(`- \`${k}\` options: ${JSON.stringify(a.options)} → ${JSON.stringify(b.options)}`);
  }
  return lines;
}

const npmSpec = arg('--npm');
const dirArg = arg('--dir');
let next = null;
let prev = existsSync(ARC1_JSON) ? JSON.parse(readFileSync(ARC1_JSON, 'utf8')) : null;

if (npmSpec || dirArg) {
  const src = npmSpec ? loadFromNpm(npmSpec === true ? 'latest' : npmSpec) : loadFromDir(dirArg);
  const parsed = parseArc1(src);
  next = { arc1Version: src.version, generatedFrom: src.from, ...parsed };
  console.error(
    `ARC-1 ${src.version}: ${Object.keys(parsed.env).length} settings, ${Object.keys(parsed.legacy).length} legacy, ` +
      `${Object.keys(parsed.retired).length} retired, ${Object.keys(parsed.ignored).length} ignored`,
  );
  if (arg('--write')) {
    writeFileSync(ARC1_JSON, `${JSON.stringify(next, null, 2)}\n`);
    console.error(`Wrote ${relative(ROOT, ARC1_JSON)}`);
  }
}

const current = next || prev;
const report = [];
if (next) {
  const changes = diff(prev, next);
  report.push(`## ARC-1 ${prev?.arc1Version ?? '?'} → ${next.arc1Version}`, '');
  report.push(...(changes.length ? changes : ['No changes in the configuration surface.']), '');
}

let exitCode = 0;
if (arg('--check') || arg('--report')) {
  const catalog = JSON.parse(readFileSync(CATALOG_JSON, 'utf8'));
  const { errors, warnings } = checkCatalog(catalog, current);
  report.push('## Catalog check', '');
  if (!errors.length && !warnings.length) report.push('The curated catalog matches ARC-1. ✔', '');
  for (const e of errors) report.push(`- ❌ ${e}`);
  for (const w of warnings) report.push(`- ⚠️ ${w}`);
  if (errors.length || warnings.length) report.push('');
  if (errors.length) {
    report.push(
      'Add new settings to `catalog/catalog.json` (with a group, type and default) and their labels to',
      '`locales/en.json` (other languages fall back to English), or list server-only ones under `serverOnly`.',
      '',
    );
  }
  for (const e of errors) console.error(`ERROR  ${e}`);
  for (const w of warnings) console.error(`WARN   ${w}`);
  if (arg('--check') && errors.length) exitCode = 1;
}

const reportPath = arg('--report');
if (typeof reportPath === 'string') writeFileSync(reportPath, `${report.join('\n')}\n`);
if (!reportPath && report.length && !arg('--check')) console.log(report.join('\n'));
process.exitCode = exitCode;
