// Extracts ARC-1's environment-variable surface from its own source code.
//
// Works on both the TypeScript sources (src/**/*.ts in the ARC-1 repo) and the
// compiled JavaScript shipped on npm (dist/**/*.js), because tsc keeps the
// resolver calls and object literals this parser relies on.
//
// The result is written to catalog/arc1.json by scripts/sync-arc1.mjs and is
// the single source of truth for "does ARC-1 know this key?", "does it refuse
// to start with it?" (legacy / retired) and "does it silently ignore it?".

const ENV_NAME = /^(?:SAP|ARC1)_[A-Z0-9_]+$/;

/** Read one quoted JS string literal starting at `i` (which must be a quote). */
function readString(src, i) {
  const q = src[i];
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j += 2;
      continue;
    }
    if (c === q) return { value: out, end: j + 1 };
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      // Template expression: keep a placeholder, skip to the closing brace.
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      out += '…';
      continue;
    }
    out += c;
    j++;
  }
  return { value: out, end: j };
}

/** Collect every string literal in `src` (used for error-message scanning). */
function stringLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(src, i);
      out.push(s.value);
      i = s.end - 1;
    }
  }
  return out;
}

/** Concatenate adjacent string literals joined by `+` (multi-line messages). */
function readStringExpr(src, i) {
  let { value, end } = readString(src, i);
  for (;;) {
    const m = /^\s*\+\s*(['"`])/.exec(src.slice(end, end + 200));
    if (!m) break;
    const next = readString(src, end + m[0].length - 1);
    value += next.value;
    end = next.end;
  }
  return { value, end };
}

/** Find `NAME = {` (optionally with a type annotation) and return the object body. */
function objectBody(src, name) {
  const re = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = readString(src, i).end;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/** Parse `KEY: 'message' (+ 'more')` pairs from an object literal body. */
function stringMap(body) {
  const map = {};
  if (!body) return map;
  const re = /\b([A-Z][A-Z0-9_]+)\s*:\s*(?=['"`])/g;
  let m;
  while ((m = re.exec(body))) {
    const s = readStringExpr(body, m.index + m[0].length);
    map[m[1]] = s.value.replace(/\s+/g, ' ').trim();
    re.lastIndex = s.end;
  }
  return map;
}

/** Split a call's argument list on top-level commas. */
function splitArgs(argText) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(argText, i);
      cur += argText.slice(i, s.end);
      i = s.end - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** Turn a literal default (`'x'`, `false`, `10`, `100 * 1024`, `['$TMP']`) into a string; null if unknown. */
function literalValue(expr, defaults) {
  if (expr === undefined) return null;
  const e = expr.trim().replace(/\s+as\s+[\w.[\]'"]+$/, '');
  if (/^(['"`])/.test(e)) return readString(e, 0).value;
  if (e === 'true' || e === 'false') return e;
  if (/^[\d\s*+\-()._]+$/.test(e)) {
    try {
      // Only digits and arithmetic operators reach this point.
      const v = Function(`"use strict"; return (${e.replace(/_/g, '')});`)();
      return Number.isFinite(v) ? String(v) : null;
    } catch {
      return null;
    }
  }
  const dc = /^DEFAULT_CONFIG\.(\w+)$/.exec(e);
  if (dc && defaults && dc[1] in defaults) return defaults[dc[1]];
  if (/^\[(.*)\]$/s.test(e)) {
    const items = splitArgs(e.slice(1, -1)).map((x) => literalValue(x, defaults));
    return items.every((x) => x !== null) ? items.join(',') : null;
  }
  return null;
}

/** Parse ARC-1's DEFAULT_CONFIG object (server/types) into { field: 'string value' }. */
export function parseDefaults(typesSrc) {
  const body = objectBody(typesSrc || '', 'DEFAULT_CONFIG');
  const out = {};
  if (!body) return out;
  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\s+\/\/\s.*$/, '').trim();
    const m = /^(\w+)\s*:\s*(.+?),?$/.exec(line);
    if (!m) continue;
    const v = literalValue(m[2], null);
    if (v !== null) out[m[1]] = v;
  }
  return out;
}

const RESOLVERS = {
  resolveBool: 'bool',
  resolveFeature: 'feature',
  resolveStr: 'string',
  resolveOptionalStr: 'string',
  resolvePositiveSafeInteger: 'int',
};

/** Find "expected a, b, or c" / "must be a or b" option lists for `name` in error strings. */
function optionsFromMessages(literals, name) {
  for (const s of literals) {
    if (!s.includes(name)) continue;
    const m = /(?:must be|expected)\s+([^.;:\n]+)/.exec(s.slice(s.indexOf(name)));
    if (!m) continue;
    const parts = m[1]
      .split(/\s*,\s*|\s+or\s+/)
      .map((p) => p.replace(/^or\s+/, '').trim())
      .filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => /^[a-z0-9][a-z0-9-]*$/.test(p))) return parts;
  }
  return null;
}

/**
 * Parse ARC-1 sources.
 * @param {{ config: string, types?: string, files?: Array<{path: string, text: string}> }} input
 *   config = server/config.(ts|js), types = server/types.(ts|js), files = every other source file to scan for env reads.
 */
export function parseArc1(input) {
  const config = input.config;
  const defaults = parseDefaults(input.types || '');
  const literals = stringLiterals(config);
  const env = {};
  const add = (name, info) => {
    if (!ENV_NAME.test(name)) return;
    env[name] = { ...(env[name] || {}), ...info };
  };

  // 1) Resolver calls: resolveBool('flag', 'ENV', default, 'field') and friends.
  const callRe = /\b(resolveBool|resolveFeature|resolveStr|resolveOptionalStr|resolvePositiveSafeInteger)\(([^()]*)\)/g;
  let m;
  while ((m = callRe.exec(config))) {
    const args = splitArgs(m[2]);
    const flag = literalValue(args[0], null);
    const name = literalValue(args[1], null);
    if (!name || !ENV_NAME.test(name)) continue;
    const kind = RESOLVERS[m[1]];
    let def = null;
    if (kind === 'feature') def = 'auto';
    else if (m[1] === 'resolveOptionalStr') def = '';
    else def = literalValue(args[2], defaults);
    const info = { kind, default: def };
    if (flag) info.flag = flag;
    if (kind === 'feature') info.options = ['auto', 'on', 'off'];
    add(name, info);
  }

  // 2) Direct reads: process.env.ENV / process.env['ENV'] (all scanned files).
  const sources = [{ path: 'config', text: config }, ...(input.files || [])];
  const direct = /process\.env(?:\.([A-Z][A-Z0-9_]+)|\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\])/g;
  for (const f of sources) {
    let d;
    while ((d = direct.exec(f.text))) {
      const name = d[1] || d[2];
      if (!ENV_NAME.test(name) || env[name]) continue;
      add(name, { kind: 'raw', default: null });
    }
  }

  // 3) Flags for direct reads: getFlag('flag') ?? process.env.ENV
  const flagRe = /getFlag\(\s*'([a-z0-9-]+)'\s*\)\s*\?\?\s*process\.env\.([A-Z][A-Z0-9_]+)/g;
  while ((m = flagRe.exec(config))) {
    if (env[m[2]] && !env[m[2]].flag) env[m[2]].flag = m[1];
  }

  // 4) Option lists for string settings.
  const varRe =
    /const\s+(\w+)\s*=\s*resolveStr\(\s*'[^']*'\s*,\s*'([A-Z][A-Z0-9_]+)'\s*,\s*([^,]+?)\s*,/g;
  while ((m = varRe.exec(config))) {
    const [, v, name] = m;
    const def = env[name]?.default;
    const after = config.slice(m.index, m.index + 600);
    const inc = new RegExp(`\\[([^\\]]*)\\]\\s*\\.includes\\(\\s*${v}\\s*\\)\\s*\\?\\s*${v}\\s*:\\s*'([^']+)'`).exec(after);
    if (inc) {
      const list = splitArgs(inc[1]).map((x) => literalValue(x, null));
      env[name].options = [...new Set([inc[2], ...list])];
      continue;
    }
    const tern = new RegExp(`${v}\\s*===\\s*'([^']+)'\\s*\\?\\s*'\\1'\\s*:\\s*'([^']+)'`).exec(after);
    if (tern) {
      env[name].options = [tern[2], tern[1]];
      continue;
    }
    if (def !== undefined) {
      const opts = optionsFromMessages(literals, name);
      if (opts) env[name].options = opts;
    }
  }
  for (const name of Object.keys(env)) {
    if (env[name].options) continue;
    const opts = optionsFromMessages(literals, name);
    if (opts) env[name].options = opts;
  }

  // 5) Descriptions from the CLI option table (flag → description).
  const specs = {};
  const specBody = (() => {
    const sm = /CLI_CONFIG_OPTION_SPECS\b[^=]*=\s*\[/.exec(config);
    if (!sm) return '';
    const start = sm.index + sm[0].length - 1;
    let depth = 0;
    for (let j = start; j < config.length; j++) {
      const c = config[j];
      if (c === "'" || c === '"' || c === '`') {
        j = readString(config, j).end - 1;
        continue;
      }
      if (c === '[') depth++;
      if (c === ']' && --depth === 0) return config.slice(start + 1, j);
    }
    return '';
  })();
  const specRe = /name:\s*'([^']+)'[\s\S]*?description:\s*(?=['"`])/g;
  while ((m = specRe.exec(specBody))) {
    const s = readStringExpr(specBody, m.index + m[0].length);
    specs[m[1]] = s.value.replace(/\s+/g, ' ').trim();
    specRe.lastIndex = s.end;
  }
  for (const info of Object.values(env)) {
    if (info.flag && specs[info.flag]) info.description = specs[info.flag];
  }

  // 6) Removed settings ARC-1 refuses to start with, and settings it ignores.
  const legacy = stringMap(objectBody(config, 'LEGACY_ENV_VARS'));
  const retired = stringMap(objectBody(config, 'RETIRED_ENV_VARS'));
  const ignored = {};
  for (const s of literals) {
    if (!/\bis ignored\b/.test(s)) continue;
    for (const name of s.match(/\b(?:SAP|ARC1)_[A-Z0-9_]+\b/g) || []) {
      ignored[name] = s.replace(/^\[warn\]\s*/, '').replace(/\s+/g, ' ').trim();
    }
  }
  for (const name of [...Object.keys(legacy), ...Object.keys(retired), ...Object.keys(ignored)]) delete env[name];

  const sorted = Object.fromEntries(Object.keys(env).sort().map((k) => [k, env[k]]));
  return { env: sorted, legacy, retired, ignored };
}
