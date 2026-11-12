// Local HTTP server for the UI. Binds to 127.0.0.1 only; every API call needs the
// per-session token from the URL fragment, a loopback Host header (DNS-rebinding
// guard) and a same-origin request (CSRF guard).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, promises as fsp, readFileSync, readdirSync, unwatchFile, watchFile } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './catalog.js';
import {
  buildCommand,
  describeCommand,
  hashText,
  isArc1Entry,
  mergeEntry,
  parseText,
  readMcpFile,
  sampleDocument,
  serialize,
  writeMcpFile,
} from './mcpfile.js';
import { listDir, places } from './paths.js';
import { testConnection } from './saptest.js';
import { accountFor, getSecret, setSecret, storeInfo } from './secrets.js';
import { loadSettings, rememberFile, saveSettings } from './settings.js';
import { createShortcuts } from './shortcut.js';
import { validateWithArc1 } from './validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const LOCALES = join(ROOT, 'locales');
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const LANG_ORDER = ['en', 'tr', 'de', 'fr', 'es', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'ja', 'zh-CN', 'zh-TW', 'ko'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

class ApiError extends Error {
  constructor(status, key, args = [], extra = {}) {
    super(key);
    this.status = status;
    this.key = key;
    this.args = args;
    this.extra = extra;
  }
}

const REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/;
/** Resolve `${VAR}` / `${VAR:-default}` the way Claude Code does, for connection tests. */
function expandRef(value) {
  const m = REF.exec(String(value ?? ''));
  if (!m) return value;
  return process.env[m[1]] ?? m[2] ?? '';
}

function stringEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [k, v] of Object.entries(env)) {
    if (typeof k !== 'string' || !k) continue;
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

/** Put SAP_PASSWORD right after SAP_USER when it is (re)added. */
function withPassword(env, password) {
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(env)) {
    if (k === 'SAP_PASSWORD') continue;
    out[k] = v;
    if (k === 'SAP_USER') {
      out.SAP_PASSWORD = password;
      placed = true;
    }
  }
  if (!placed) out.SAP_PASSWORD = password;
  return out;
}

function localeList() {
  const files = readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
  const all = files.map((f) => {
    const code = f.slice(0, -5);
    const data = JSON.parse(readFileSync(join(LOCALES, f), 'utf8'));
    return { code, name: data.name || code };
  });
  const rank = (c) => (LANG_ORDER.includes(c) ? LANG_ORDER.indexOf(c) : 100);
  return all.sort((a, b) => rank(a.code) - rank(b.code) || a.name.localeCompare(b.name));
}

/**
 * @param {{port?: number, cwd?: string, initialPath?: string|null, keepAlive?: boolean, idleMs?: number,
 *          log?: (msg: string) => void}} opts
 */
export async function startServer(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const log = opts.log || (() => {});
  const token = randomBytes(24).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const state = { path: null, hash: null, accounts: new Set(), watched: null };
  const clients = new Set();
  let everConnected = false;
  let idleTimer = null;
  let closing = false;
  let resolveClosed;
  const closed = new Promise((r) => {
    resolveClosed = r;
  });

  // ---- initial file ---------------------------------------------------------
  const settings0 = loadSettings();
  let initial = { path: null, missing: null };
  const pick = (p) => (p && existsSync(p) ? { path: p, missing: null } : { path: null, missing: p || null });
  if (opts.initialPath) initial = pick(resolve(cwd, opts.initialPath));
  else if (existsSync(join(cwd, '.mcp.json'))) initial = { path: join(cwd, '.mcp.json'), missing: null };
  else if (settings0.recent[0]) initial = pick(settings0.recent[0]);

  // ---- model ---------------------------------------------------------------
  async function model(path, r) {
    const servers = r.doc[r.rootKey];
    const valid = servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
    const store = await storeInfo();
    const list = [];
    state.accounts = new Set();
    for (const [name, entry] of Object.entries(valid)) {
      const arc1 = isArc1Entry(entry);
      const item = { name, entry: entry && typeof entry === 'object' ? entry : {}, arc1 };
      if (arc1) {
        Object.assign(item, describeCommand(item.entry));
        item.account = accountFor(item.entry.env || {});
        item.stored = null;
        if (item.wrapped && item.account) {
          state.accounts.add(item.account);
          if (store.available) {
            try {
              item.stored = (await getSecret(item.account)) != null;
            } catch {
              item.stored = null;
            }
          }
        }
      }
      list.push(item);
    }
    return {
      path,
      name: basename(path),
      dir: dirname(path),
      hash: r.hash,
      rootKey: r.rootKey,
      format: r.format,
      badRoot: servers !== undefined && valid !== servers,
      servers: list,
    };
  }

  function watch(path) {
    if (state.watched) unwatchFile(state.watched);
    state.watched = path;
    watchFile(path, { interval: 1500 }, async (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      let hash = null;
      try {
        hash = hashText(await fsp.readFile(path, 'utf8'));
      } catch {
        hash = null;
      }
      if (hash !== state.hash && path === state.path) {
        state.hash = hash;
        broadcast({ type: 'file-changed', path, missing: hash === null });
      }
    });
  }

  async function openFile(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new ApiError(400, 'msg.notjson');
    const path = resolve(cwd, rawPath.trim());
    if (extname(path).toLowerCase() !== '.json') throw new ApiError(400, 'msg.notjson');
    let r;
    try {
      r = await readMcpFile(path);
    } catch (e) {
      if (e.code === 'ENOENT') throw new ApiError(404, 'welcome.missing', [path]);
      throw new ApiError(422, 'msg.read.fail', [e.message]);
    }
    state.path = path;
    state.hash = r.hash;
    watch(path);
    rememberFile(path);
    return model(path, r);
  }

  // ---- API -----------------------------------------------------------------
  const api = {
    'GET /api/bootstrap': async () => ({
      version: PKG.version,
      platform: process.platform,
      settings: loadSettings(),
      recent: loadSettings().recent.filter((p) => existsSync(p)),
      locales: localeList(),
      catalog: loadCatalog(),
      store: await storeInfo(),
      defaults: { style: process.platform === 'win32' ? 'cmd' : 'plain', inner: ['npx', '-y', 'arc-1'] },
      initial,
      cwd,
      home: homedir(),
      sep,
    }),

    'GET /api/locale': async (_b, url) => {
      const code = url.searchParams.get('code') || '';
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(code)) throw new ApiError(400, 'bad');
      const p = join(LOCALES, `${code}.json`);
      if (!existsSync(p)) throw new ApiError(404, 'bad');
      return JSON.parse(await fsp.readFile(p, 'utf8'));
    },

    'POST /api/settings': async (b) => {
      const patch = {};
      if (b.theme === 'light' || b.theme === 'dark') patch.theme = b.theme;
      if (typeof b.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(b.lang)) patch.lang = b.lang;
      if (typeof b.lastConnection === 'string') patch.lastConnection = b.lastConnection.slice(0, 200);
      return saveSettings(patch);
    },

    'POST /api/file/open': async (b) => openFile(b.path),

    'POST /api/file/create': async (b) => {
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : '.mcp.json';
      if (/[\\/]/.test(name) || extname(name).toLowerCase() !== '.json') throw new ApiError(400, 'msg.notjson');
      if (typeof b.dir !== 'string' || !b.dir) throw new ApiError(400, 'fb.err', ['']);
      const path = join(resolve(cwd, b.dir), name);
      if (existsSync(path) && !b.overwrite) return { exists: true, path };
      const text = serialize(sampleDocument(), { indent: '  ', eol: '\n', bom: false, finalNewline: true });
      try {
        await writeMcpFile(path, text);
      } catch (e) {
        throw new ApiError(500, 'msg.save.fail', [e.message]);
      }
      return openFile(path);
    },

    'POST /api/file/save': async (b) => {
      if (typeof b.path !== 'string' || !isAbsolute(b.path) || extname(b.path).toLowerCase() !== '.json') {
        throw new ApiError(400, 'msg.notjson');
      }
      const path = b.path;
      let current = null;
      let diskHash = null;
      try {
        const text = await fsp.readFile(path, 'utf8');
        diskHash = hashText(text);
        try {
          current = parseText(text);
        } catch {
          current = null; // unreadable now: only overwritten after the user confirms (force)
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw new ApiError(500, 'msg.save.fail', [e.message]);
      }
      if (!b.force) {
        if (diskHash !== null && diskHash !== b.baseHash) return { conflict: true };
        if (diskHash === null && b.baseHash) return { conflict: true, missing: true };
      }
      const rootKey = b.rootKey === 'servers' ? 'servers' : 'mcpServers';
      const doc = current ? current.doc : {};
      const format = { indent: '  ', eol: '\n', bom: false, finalNewline: true, ...(b.format || {}), jsonc: false };

      if (!Array.isArray(b.servers)) throw new ApiError(400, 'bad');
      const out = {};
      const secrets = [];
      for (const s of b.servers) {
        const name = typeof s?.name === 'string' ? s.name.trim() : '';
        if (!name) throw new ApiError(400, 'msg.name.empty');
        if (Object.hasOwn(out, name)) throw new ApiError(400, 'msg.name.exists', [name]);
        const entry = s.entry && typeof s.entry === 'object' && !Array.isArray(s.entry) ? s.entry : {};
        if (!s.arc1) {
          out[name] = entry;
          continue;
        }
        let env = stringEnv(entry.env);
        const inner =
          Array.isArray(s.inner) && s.inner.length && s.inner.every((t) => typeof t === 'string' && t !== '')
            ? s.inner
            : ['npx', '-y', 'arc-1'];
        const style = s.style === 'cmd' ? 'cmd' : 'plain';
        let wrapped = false;
        if (s.mode === 'store') {
          const account = accountFor(env);
          if (!account) throw new ApiError(400, 'msg.store.need', [name]);
          let pw = typeof s.password === 'string' && s.password !== '' ? s.password : null;
          if (pw === null && env.SAP_PASSWORD && !REF.test(env.SAP_PASSWORD)) pw = env.SAP_PASSWORD;
          try {
            if (pw === null && s.originalAccount && s.originalAccount !== account) pw = await getSecret(s.originalAccount);
            if (pw === null && !b.allowMissing && (await getSecret(account)) == null) {
              throw new ApiError(400, 'msg.pwd.missing', [name]);
            }
          } catch (e) {
            if (e instanceof ApiError) throw e;
            throw new ApiError(500, 'msg.store.fail', [e.message]);
          }
          if (pw !== null) secrets.push([account, pw]);
          delete env.SAP_PASSWORD;
          wrapped = true;
        } else {
          if (typeof s.password === 'string' && s.password !== '') env = withPassword(env, s.password);
          if (s.wasWrapped && !env.SAP_PASSWORD && s.originalAccount) {
            const pw = await getSecret(s.originalAccount).catch(() => null);
            if (pw) env = withPassword(env, pw);
          }
        }
        out[name] = mergeEntry(entry, { ...buildCommand(inner, style, wrapped, s.runnerSpec), env });
      }

      for (const [account, pw] of secrets) {
        try {
          await setSecret(account, pw);
        } catch (e) {
          throw new ApiError(500, 'msg.store.fail', [e.message]);
        }
      }
      doc[rootKey] = out;
      const text = serialize(doc, format);
      try {
        await writeMcpFile(path, text);
      } catch (e) {
        throw new ApiError(500, 'msg.save.fail', [e.message]);
      }
      state.path = path;
      state.hash = hashText(text);
      watch(path);
      rememberFile(path);
      return { ok: true, model: await model(path, { ...parseText(text), hash: state.hash }) };
    },

    'POST /api/fs/list': async (b) => {
      try {
        const listing = await listDir(typeof b.path === 'string' ? b.path : '');
        const recent = loadSettings().recent.filter((p) => existsSync(p));
        return { ...listing, places: places(cwd), recent, sep };
      } catch (e) {
        throw new ApiError(400, 'fb.err', [e.message]);
      }
    },

    'POST /api/secret/reveal': async (b) => {
      if (typeof b.account !== 'string' || !state.accounts.has(b.account)) throw new ApiError(403, 'bad');
      try {
        return { password: await getSecret(b.account) };
      } catch (e) {
        throw new ApiError(500, 'msg.store.fail', [e.message]);
      }
    },

    'POST /api/test': async (b) => {
      const env = stringEnv(b.env);
      let password = typeof b.password === 'string' && b.password !== '' ? b.password : null;
      if (password === null && b.mode === 'store') {
        const account = accountFor(env);
        if (account) {
          try {
            password = await getSecret(account);
          } catch (e) {
            throw new ApiError(500, 'msg.store.fail', [e.message]);
          }
          if (password === null && b.originalAccount && state.accounts.has(b.originalAccount)) {
            password = await getSecret(b.originalAccount).catch(() => null);
          }
        }
      }
      if (password === null) password = expandRef(env.SAP_PASSWORD ?? '');
      const truthy = (v) => v === 'true' || v === '1';
      return testConnection({
        url: expandRef(env.SAP_URL),
        user: expandRef(env.SAP_USER),
        password,
        client: expandRef(env.SAP_CLIENT),
        language: expandRef(env.SAP_LANGUAGE),
        insecure: truthy(env.SAP_INSECURE),
        disableSaml: truthy(env.SAP_DISABLE_SAML),
      });
    },

    'POST /api/shortcut': async () => {
      try {
        return { paths: createShortcuts() };
      } catch (e) {
        throw new ApiError(500, 'msg.shortcut.fail', [e.message]);
      }
    },

    'POST /api/validate': async (b) => {
      const env = stringEnv(b.env);
      const inner = Array.isArray(b.inner) ? b.inner.filter((t) => typeof t === 'string') : [];
      const dir = typeof b.path === 'string' && existsSync(dirname(b.path)) ? dirname(b.path) : cwd;
      return validateWithArc1({ env, inner, cwd: dir });
    },
  };

  // ---- HTTP plumbing ---------------------------------------------------------
  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(data);
  }

  function tokenOk(value) {
    if (typeof value !== 'string') return false;
    const v = Buffer.from(value);
    return v.length === tokenBuf.length && timingSafeEqual(v, tokenBuf);
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 2 * 1024 * 1024) throw new ApiError(413, 'bad');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ApiError(400, 'bad');
    }
  }

  function broadcast(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) c.write(line);
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (clients.size === 0 && everConnected && !opts.keepAlive && !closing) {
      idleTimer = setTimeout(() => close('window-closed'), opts.idleMs ?? 15000);
    }
  }

  function events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    everConnected = true;
    scheduleIdle();
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      scheduleIdle();
    });
  }

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + sep) || !existsSync(file)) return send(res, 404, { error: 'not found' });
    const type = MIME[extname(file).toLowerCase()];
    if (!type) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts().has(req.headers.host || '')) return send(res, 403, { error: 'host' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
        return await serveStatic(req, res, url.pathname);
      }
      const origin = req.headers.origin;
      if (origin && !allowedOrigins().has(origin)) return send(res, 403, { error: 'origin' });
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'site' });
      if (url.pathname === '/api/events') {
        if (!tokenOk(url.searchParams.get('token'))) return send(res, 401, { error: 'token' });
        return events(req, res);
      }
      if (!tokenOk(req.headers['x-arc1cm-token'])) return send(res, 401, { error: 'token' });
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler(body, url);
      return send(res, 200, result ?? {});
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: { key: e.key, args: e.args, ...e.extra } });
      log(`Unexpected error: ${e?.stack || e}`);
      return send(res, 500, { error: { key: 'msg.unexpected', args: [String(e?.message || e)] } });
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  port = server.address().port;

  function close(reason = 'closed') {
    if (closing) return closed;
    closing = true;
    clearTimeout(idleTimer);
    if (state.watched) unwatchFile(state.watched);
    broadcast({ type: 'bye', reason });
    for (const c of clients) c.end();
    server.close(() => resolveClosed(reason));
    server.closeAllConnections?.();
    return closed;
  }

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close,
    closed,
  };
}
