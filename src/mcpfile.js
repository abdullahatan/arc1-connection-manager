// Reading and writing MCP configuration files (.mcp.json, claude_desktop_config.json,
// VS Code mcp.json, ...) without disturbing anything the app does not manage:
// other root keys, other servers, unknown fields, key order, indentation,
// line endings and a UTF-8 BOM are all preserved.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const RUNNER_PKG = 'arc1-connection-manager';
/** Version range the .mcp.json wrapper asks npx for (major pin). */
export const RUNNER_SPEC = `${RUNNER_PKG}@1`;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Remove // and /* *\/ comments and trailing commas (JSONC → JSON), keeping strings intact. */
export function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) {
      // trailing comma: drop it
    } else {
      out += c;
    }
  }
  return out;
}

/** Parse file text into a document plus the formatting needed to write it back. */
export function parseText(text) {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const format = {
    bom,
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    indent: /\n([ \t]+)\S/.exec(body)?.[1] ?? '  ',
    finalNewline: body.length === 0 || /\n$/.test(body),
    jsonc: false,
  };
  let doc = {};
  if (body.trim()) {
    try {
      doc = JSON.parse(body);
    } catch (strictError) {
      try {
        doc = JSON.parse(stripJsonc(body));
        format.jsonc = true;
      } catch {
        throw strictError;
      }
    }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const e = new Error('The root element is not a JSON object.');
    e.code = 'EROOT';
    throw e;
  }
  const rootKey = 'mcpServers' in doc ? 'mcpServers' : 'servers' in doc ? 'servers' : 'mcpServers';
  return { doc, format, rootKey };
}

export function serialize(doc, format) {
  let text = JSON.stringify(doc, null, format.indent || '  ');
  if (format.finalNewline !== false) text += '\n';
  if (format.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return (format.bom ? '﻿' : '') + text;
}

// ---------------------------------------------------------------------------
// ARC-1 entries and the credential-store wrapper
// ---------------------------------------------------------------------------

const strings = (entry) =>
  [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].filter((x) => typeof x === 'string');

/** Heuristic: is this MCP server entry an ARC-1 server? */
export function isArc1Entry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const env = entry.env && typeof entry.env === 'object' ? entry.env : {};
  if (Object.keys(env).some((k) => /^(SAP|ARC1)_/.test(k))) return true;
  return strings(entry).some((p) => /\barc-?1\b/i.test(p));
}

const isCmd = (s) => typeof s === 'string' && /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(s);
const RUNNER_TOKEN = new RegExp(`^(?:.*[\\\\/])?${RUNNER_PKG}(?:@\\S+)?$`);

/**
 * Split an entry's command into the part that actually starts ARC-1 ("inner")
 * and the way it is launched: style "cmd" (`cmd /c ...`, needed by Claude Code on
 * Windows) or "plain"; `wrapped` = launched through `arc1-connection-manager run`.
 */
export function describeCommand(entry) {
  const all = strings(entry);
  const style = isCmd(all[0]) ? 'cmd' : 'plain';
  const r = all.findIndex((t) => RUNNER_TOKEN.test(t));
  if (r !== -1 && all[r + 1] === 'run') {
    const sep = all.indexOf('--', r + 2);
    const inner = sep === -1 ? all.slice(r + 2) : all.slice(sep + 1);
    return { style, wrapped: true, runnerSpec: all[r], inner };
  }
  if (style === 'cmd') {
    const c = all.findIndex((t, i) => i > 0 && /^\/c$/i.test(t));
    return { style, wrapped: false, inner: c === -1 ? all.slice(1) : all.slice(c + 1) };
  }
  return { style, wrapped: false, inner: all };
}

/** Build `command`/`args` for an inner command, optionally wrapped by the credential-store runner. */
export function buildCommand(inner, style, wrapped, runnerSpec = RUNNER_SPEC) {
  const spec = runnerSpec && RUNNER_TOKEN.test(runnerSpec) ? runnerSpec : RUNNER_SPEC;
  const body = wrapped ? ['npx', '-y', spec, 'run', '--', ...inner] : [...inner];
  if (style === 'cmd') return { command: 'cmd', args: ['/c', ...body] };
  return { command: body[0], args: body.slice(1) };
}

/** The ARC-1 package spec in a command (`arc-1`, `arc-1@1.10.1`), if any. */
export function arc1Spec(inner) {
  return inner.find((t) => /^arc-1(@[\w.\-^~<>=*|]+)?$/.test(t)) || null;
}

/** Replace command/args/env of an entry while keeping its other fields and key order. */
export function mergeEntry(original, updates) {
  const out = {};
  const base = original && typeof original === 'object' ? original : {};
  for (const k of Object.keys(base)) out[k] = k in updates ? updates[k] : base[k];
  for (const k of ['command', 'args', 'env']) if (!(k in out) && k in updates) out[k] = updates[k];
  for (const [k, v] of Object.entries(updates)) if (!(k in out)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export async function readMcpFile(path) {
  const st = await fsp.stat(path);
  if (!st.isFile()) {
    const e = new Error('Not a file.');
    e.code = 'ENOTFILE';
    throw e;
  }
  if (st.size > MAX_FILE_BYTES) {
    const e = new Error('The file is too large to be an MCP configuration.');
    e.code = 'ETOOBIG';
    throw e;
  }
  const text = await fsp.readFile(path, 'utf8');
  return { text, hash: hashText(text), mtimeMs: st.mtimeMs, ...parseText(text) };
}

/** Write via temp file + rename; back the old file up to <file>.bak first. */
export async function writeMcpFile(path, text, { backup = true } = {}) {
  await fsp.mkdir(dirname(path), { recursive: true });
  let mode;
  try {
    const st = await fsp.stat(path);
    mode = st.mode;
    if (backup) await fsp.copyFile(path, `${path}.bak`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, text, { encoding: 'utf8', mode: mode ?? 0o600 });
    if (mode !== undefined) await fsp.chmod(tmp, mode).catch(() => {});
    await fsp.rename(tmp, path);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EXDEV') {
      // Windows refuses to replace a file another program holds open; write in place instead.
      await fsp.writeFile(path, text, 'utf8');
    } else {
      throw e;
    }
  }
  return hashText(text);
}

/** Sample configuration for "Create New File". */
export function sampleDocument(platform = process.platform) {
  const style = platform === 'win32' ? 'cmd' : 'plain';
  return {
    mcpServers: {
      'sap-dev': {
        ...buildCommand(['npx', '-y', 'arc-1'], style, false),
        env: { SAP_URL: 'https://sap-host:44300', SAP_CLIENT: '100', SAP_LANGUAGE: 'EN' },
      },
    },
  };
}
