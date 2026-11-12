import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseArc1 } from '../scripts/arc1-parse.mjs';
import { checkCatalog, loadCatalog } from '../src/catalog.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

test('the curated catalog matches the ARC-1 surface it was generated from', () => {
  const c = loadCatalog();
  const { errors } = checkCatalog(c, c.arc1);
  assert.deepEqual(errors, []);
});

test('every curated setting has an English label', () => {
  const c = loadCatalog();
  for (const [k, d] of Object.entries(c.settings)) {
    if (d.type === 'feature') {
      assert.ok(d.label, `${k} needs a fixed label`);
      continue;
    }
    assert.ok(Array.isArray(en.cat[k]) && en.cat[k][0], `locales/en.json is missing cat.${k}`);
  }
  for (const g of c.groups) assert.ok(en.groups[g.id], `missing group label ${g.id}`);
});

test('legacy conversion rules point at real settings', () => {
  const c = loadCatalog();
  for (const [k, r] of Object.entries(c.legacyRules)) {
    assert.ok(k in c.arc1.legacy || k in c.arc1.retired, `${k} is not rejected by ARC-1`);
    if (r.to) assert.ok(c.settings[r.to], `${k} → ${r.to} is not in the catalog`);
    if (r.note) assert.ok(en.ui[r.note], `missing text ${r.note}`);
  }
});

test('the drift check reports new, removed and changed settings', () => {
  const catalog = { connection: [], settings: { A_GONE: { group: 'x', type: 'bool', default: 'false' }, SAP_X: { type: 'int', default: '5' } }, serverOnly: [], legacyRules: {} };
  const arc1 = { arc1Version: '9', env: { SAP_X: { kind: 'int', default: '6' }, SAP_NEW: { kind: 'bool', default: 'false' } }, legacy: {}, retired: {} };
  const { errors } = checkCatalog(catalog, arc1);
  assert.ok(errors.some((e) => e.includes('A_GONE')));
  assert.ok(errors.some((e) => e.includes('SAP_NEW')));
  assert.ok(errors.some((e) => e.includes('SAP_X') && e.includes('default')));
});

test('the ARC-1 parser understands resolver calls, option lists and removed keys', () => {
  const config = `
    export const CLI_CONFIG_OPTION_SPECS: readonly Spec[] = [
      { name: 'allow-writes', valueName: 'boolean', description: 'Enable SAP mutations (true/false)' },
      { name: 'cache', valueName: 'mode', description: 'Cache mode' },
    ];
    const LEGACY_ENV_VARS: Record<string, string> = {
      SAP_READ_ONLY: 'Replaced by SAP_ALLOW_WRITES ' +
        '(inverted).',
    };
    const RETIRED_ENV_VARS: Record<string, string> = { ARC1_CACHE_WARMUP: 'Removed.' };
    function resolveConfig(args) {
      config.allowWrites = resolveBool(
        'allow-writes',
        'SAP_ALLOW_WRITES',
        false,
        'allowWrites',
      );
      config.serverName = resolveStr('server-name', 'ARC1_SERVER_NAME', DEFAULT_CONFIG.serverName, 'serverName');
      config.featureRap = resolveFeature('feature-rap', 'SAP_FEATURE_RAP', 'featureRap');
      const cacheMode = resolveStr('cache', 'ARC1_CACHE', 'auto', 'cacheMode');
      config.cacheMode = (['memory', 'sqlite', 'none'].includes(cacheMode) ? cacheMode : 'auto');
      const ideLinks = resolveStr('ide-links', 'ARC1_IDE_LINKS', 'off', 'ideLinks');
      if (ideLinks !== 'off') throw new Error('ARC1_IDE_LINKS must be off or eclipse. More text.');
      config.max = resolvePositiveSafeInteger('max-x', 'ARC1_MAX_X', 100 * 1024, 'max');
      const raw = getFlag('plugins') ?? process.env.ARC1_PLUGINS;
      if (getFlag('feature-amdp') !== undefined || process.env.SAP_FEATURE_AMDP !== undefined) {
        console.error('[warn] --feature-amdp / SAP_FEATURE_AMDP is ignored; the probe was removed.');
      }
      const home = process.env.HOME;
    }`;
  const types = `export const DEFAULT_CONFIG = {\n  serverName: 'arc-1',\n  uiAddr: '127.0.0.1:8711', // comment\n};`;
  const r = parseArc1({ config, types, files: [{ path: 'x.js', text: 'process.env.SAP_BTP_DESTINATION' }] });
  assert.deepEqual(r.env.SAP_ALLOW_WRITES, { kind: 'bool', default: 'false', flag: 'allow-writes', description: 'Enable SAP mutations (true/false)' });
  assert.equal(r.env.ARC1_SERVER_NAME.default, 'arc-1');
  assert.deepEqual(r.env.SAP_FEATURE_RAP.options, ['auto', 'on', 'off']);
  assert.deepEqual(r.env.ARC1_CACHE.options, ['auto', 'memory', 'sqlite', 'none']);
  assert.deepEqual(r.env.ARC1_IDE_LINKS.options, ['off', 'eclipse']);
  assert.equal(r.env.ARC1_MAX_X.default, '102400');
  assert.equal(r.env.ARC1_PLUGINS.kind, 'raw');
  assert.ok(r.env.SAP_BTP_DESTINATION);
  assert.ok(!r.env.HOME);
  assert.equal(r.legacy.SAP_READ_ONLY, 'Replaced by SAP_ALLOW_WRITES (inverted).');
  assert.equal(r.retired.ARC1_CACHE_WARMUP, 'Removed.');
  assert.match(r.ignored.SAP_FEATURE_AMDP, /is ignored/);
  assert.ok(!r.env.SAP_FEATURE_AMDP);
});
