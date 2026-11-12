#!/usr/bin/env node
// Checks every locales/*.json against locales/en.json: same keys, same {n} placeholders.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const placeholders = (s) => [...String(s).matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

export function checkLocales() {
  const errors = [];
  const en = JSON.parse(readFileSync(join(DIR, 'en.json'), 'utf8'));
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const code = file.slice(0, -5);
    let data;
    try {
      data = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: invalid JSON (${e.message})`);
      continue;
    }
    if (!data.name) errors.push(`${file}: missing "name"`);
    for (const section of ['ui', 'groups']) {
      for (const [k, v] of Object.entries(en[section])) {
        const t = data[section]?.[k];
        if (typeof t !== 'string') errors.push(`${code}: missing ${section}.${k}`);
        else if (placeholders(t) !== placeholders(v)) errors.push(`${code}: ${section}.${k} placeholders differ (${placeholders(v)} vs ${placeholders(t)})`);
      }
      for (const k of Object.keys(data[section] || {})) if (!(k in en[section])) errors.push(`${code}: unknown ${section}.${k}`);
    }
    for (const [k, v] of Object.entries(en.cat)) {
      const t = data.cat?.[k];
      if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== 'string' || typeof t[1] !== 'string') errors.push(`${code}: missing cat.${k}`);
      else if (v[1] === '' !== (t[1] === '')) errors.push(`${code}: cat.${k} help should ${v[1] === '' ? '' : 'not '}be empty`);
    }
    for (const k of Object.keys(data.cat || {})) if (!(k in en.cat)) errors.push(`${code}: unknown cat.${k}`);
    const f = data.ui?.['dlg.filter'];
    if (f !== undefined) errors.push(`${code}: obsolete ui.dlg.filter`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkLocales();
  for (const e of errors) console.error(e);
  console.error(errors.length ? `${errors.length} problem(s)` : 'All locales complete.');
  process.exitCode = errors.length ? 1 : 0;
}
