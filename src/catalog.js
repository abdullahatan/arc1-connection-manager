// Setting catalog: the curated UI catalog (catalog/catalog.json) plus the
// surface extracted from ARC-1's own source (catalog/arc1.json).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;

/** Load and combine both catalog files (cached). */
export function loadCatalog() {
  if (cached) return cached;
  const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
  const arc1 = JSON.parse(readFileSync(join(ROOT, 'catalog', 'arc1.json'), 'utf8'));
  cached = { ...catalog, arc1 };
  return cached;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Compare the curated catalog with ARC-1's real configuration surface.
 * Errors mean the app would show something ARC-1 does not do (or miss a new setting).
 */
export function checkCatalog(catalog, arc1) {
  const errors = [];
  const warnings = [];
  const env = arc1.env || {};
  const v = arc1.arc1Version;
  const curated = new Set([...catalog.connection, ...Object.keys(catalog.settings)]);
  const serverOnly = new Set(catalog.serverOnly || []);

  for (const key of curated) {
    if (!env[key]) errors.push(`\`${key}\` is in the catalog but ARC-1 ${v} does not read it (removed or renamed?).`);
  }
  for (const key of serverOnly) {
    if (!env[key]) warnings.push(`\`${key}\` is listed as server-only but ARC-1 ${v} does not read it any more.`);
    if (curated.has(key)) errors.push(`\`${key}\` is both curated and server-only.`);
  }
  for (const [key, info] of Object.entries(env)) {
    if (curated.has(key) || serverOnly.has(key)) continue;
    const bits = [info.kind];
    if (info.default !== null && info.default !== undefined) bits.push(`default \`${info.default}\``);
    if (info.options) bits.push(`options ${info.options.join('/')}`);
    errors.push(
      `ARC-1 ${v} has a setting the catalog does not know: \`${key}\` (${bits.join(', ')})` +
        (info.description ? ` — "${info.description}"` : ''),
    );
  }

  for (const [key, def] of Object.entries(catalog.settings)) {
    const info = env[key];
    if (!info) continue;
    const expectKind = { bool: ['bool', 'raw'], feature: ['feature'], int: ['int', 'raw', 'string'] }[def.type];
    if (expectKind && !expectKind.includes(info.kind)) {
      errors.push(`\`${key}\`: catalog type is ${def.type} but ARC-1 parses it as ${info.kind}.`);
    }
    if (info.default !== null && info.default !== undefined && def.default !== undefined && def.default !== info.default) {
      errors.push(`\`${key}\`: catalog default \`${def.default}\` differs from ARC-1's \`${info.default}\`.`);
    }
    if (def.type === 'enum' && info.options) {
      const missing = def.options.filter((o) => !info.options.includes(o));
      if (missing.length) errors.push(`\`${key}\`: ARC-1 no longer accepts ${missing.join(', ')}.`);
      const extra = info.options.filter((o) => !def.options.includes(o) && !(def.hiddenOptions || []).includes(o));
      if (extra.length) warnings.push(`\`${key}\`: ARC-1 also accepts ${extra.join(', ')} (not offered in the app).`);
    }
    if (def.type === 'feature' && info.options && !sameSet(info.options, ['auto', 'on', 'off'])) {
      errors.push(`\`${key}\`: feature options changed to ${info.options.join('/')}.`);
    }
  }

  const blocking = { ...(arc1.legacy || {}), ...(arc1.retired || {}) };
  for (const [key, rule] of Object.entries(catalog.legacyRules || {})) {
    if (!blocking[key]) warnings.push(`Legacy rule for \`${key}\` exists but ARC-1 ${v} no longer rejects that key.`);
    if (rule.to && !env[rule.to]) errors.push(`Legacy rule \`${key}\` → \`${rule.to}\` targets a key ARC-1 does not read.`);
  }
  return { errors, warnings };
}
