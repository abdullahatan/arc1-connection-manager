// ARC-1 MCP Connection Manager — browser UI (no framework, no build step).
import { svg } from './icons.js';

// ===========================================================================
// DOM helpers
// ===========================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Create an element. Text is always set as text (never HTML) except `html` for trusted icon markup. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const icon = (name, size = 20, cls = '') => h('span', { class: `ic ${cls}`.trim(), html: svg(name, size) });
/** replaceChildren() that also accepts nested arrays and skips null/false. */
function setKids(el, ...kids) {
  if (!el) return;
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

// ===========================================================================
// State
// ===========================================================================
const S = {
  token: '',
  boot: null,
  EN: null,
  L: null,
  lang: 'en',
  theme: 'dark',
  file: null, // { path, name, dir, hash, rootKey, format, badRoot }
  conns: [],
  snap: '',
  selId: null,
  status: null,
  results: new Map(),
  banner: null,
  missing: null,
  saving: false,
  advOpen: false,
  jsoncOk: false,
};
let uidSeq = 0;
const uid = () => `c${++uidSeq}`;

// ===========================================================================
// Server API
// ===========================================================================
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'X-ARC1CM-Token': S.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('network');
    err.key = 'msg.lost';
    err.args = [];
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.key || String(res.status));
    err.key = typeof data?.error?.key === 'string' ? data.error.key : null;
    err.args = data?.error?.args || [];
    err.status = res.status;
    throw err;
  }
  return data;
}

// ===========================================================================
// i18n
// ===========================================================================
const BASE_FONT =
  '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
const CJK_FONT = {
  ja: '"Yu Gothic UI", "Meiryo UI", "Hiragino Sans", "Noto Sans JP", ',
  'zh-CN': '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", ',
  'zh-TW': '"Microsoft JhengHei UI", "PingFang TC", "Noto Sans TC", ',
  ko: '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", ',
};

function t(key, ...args) {
  const s = S.L?.ui?.[key] ?? S.EN?.ui?.[key] ?? key;
  const vals = args.map((a) => (typeof a === 'function' ? a() : a));
  return s.replace(/\{(\d+)\}/g, (m, i) => (vals[i] !== undefined && vals[i] !== null ? String(vals[i]) : m));
}

function resolveLang(code) {
  if (!code || !S.boot) return null;
  const codes = S.boot.locales.map((l) => l.code);
  const lower = String(code).toLowerCase();
  const exact = codes.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split(/[-_]/)[0];
  if (base === 'zh') return /hant|tw|hk|mo/.test(lower) ? 'zh-TW' : 'zh-CN';
  return codes.find((c) => c.toLowerCase() === base) || codes.find((c) => c.toLowerCase().startsWith(`${base}-`)) || null;
}

const langName = (code) => S.boot?.locales.find((l) => l.code === code)?.name || code;

async function setLang(code, persist = false) {
  try {
    S.L = code === 'en' ? S.EN : await api('GET', `/api/locale?code=${encodeURIComponent(code)}`);
    S.lang = code;
  } catch {
    S.L = S.EN;
    S.lang = 'en';
  }
  document.documentElement.lang = S.lang;
  document.documentElement.style.setProperty('--font', (CJK_FONT[S.lang] || '') + BASE_FONT);
  applyStatic();
  renderAll();
  if (persist) api('POST', '/api/settings', { lang: S.lang }).catch(() => {});
}

function applyStatic() {
  for (const el of $$('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of $$('[data-tt]')) {
    el.title = t(el.dataset.tt);
    if (!el.querySelector('[data-t], .lbl')) el.setAttribute('aria-label', el.title);
  }
  $('#langName').textContent = langName(S.lang);
  document.title = t('app.title');
}

// ===========================================================================
// Catalog
// ===========================================================================
const CAT = () => S.boot.catalog;
const CONN_KEYS = () => CAT().connection;
const catDef = (k) => CAT().settings[k];
const arc1Info = (k) => CAT().arc1.env[k];

function catLabel(k) {
  const d = catDef(k);
  if (d?.label) return d.label;
  return S.L?.cat?.[k]?.[0] || S.EN?.cat?.[k]?.[0] || k;
}
function catHelp(k) {
  const d = catDef(k);
  if (d?.type === 'feature') return t('feat.help');
  return S.L?.cat?.[k]?.[1] ?? S.EN?.cat?.[k]?.[1] ?? arc1Info(k)?.description ?? '';
}
const groupName = (g) => S.L?.groups?.[g] || S.EN?.groups?.[g] || g;
const groupIcon = (g) => CAT().groups.find((x) => x.id === g)?.icon || 'wrench';

/** conn | legacy | ignored | cat | server | unknown */
function classify(k) {
  const c = CAT();
  if (c.connection.includes(k)) return 'conn';
  if (k in c.arc1.legacy || k in c.arc1.retired) return 'legacy';
  if (c.arc1.ignored && k in c.arc1.ignored) return 'ignored';
  if (c.settings[k]) return 'cat';
  if (c.arc1.env[k]) return 'server';
  return 'unknown';
}

const fatal = (d, msg) => ({ level: d.strict ? 'err' : 'warn', msg: d.strict ? `${msg} ${t('set.fatal')}` : msg });

/** Validate a catalog setting's value the way ARC-1 parses it. */
function checkValue(k, raw) {
  const d = catDef(k);
  if (!d || raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (d.type === 'bool') {
    const ok = d.trueOnly ? /^(true|false)$/.test(s) : /^(true|false|1|0)$/.test(s);
    return ok ? null : { level: 'warn', msg: t('set.invalid.bool', s) };
  }
  if (d.type === 'feature' || d.type === 'enum') {
    const opts = d.type === 'feature' ? ['auto', 'on', 'off'] : [...d.options, ...(d.hiddenOptions || [])];
    return opts.includes(s) ? null : fatal(d, t('set.invalid.enum', s));
  }
  if (s === '') return null;
  if (d.type === 'int') {
    if (!/^\d+$/.test(s)) return fatal(d, t('set.invalid.int', s));
    const n = Number(s);
    if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) {
      return fatal(d, t('set.invalid.range', d.min ?? 0, d.max ?? '∞'));
    }
    return null;
  }
  if (d.pattern && !new RegExp(d.pattern).test(s)) return fatal(d, t('set.invalid.pattern', s));
  if (d.maxLength && s.length > d.maxLength) return fatal(d, t('set.invalid.length', d.maxLength));
  if (d.type === 'list' && /(^|,)\s*(,|$)/.test(s)) return fatal(d, t('set.invalid.list'));
  return null;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Closest real ARC-1 key for an unknown one (typo help). */
function suggestKey(k) {
  const known = [...new Set([...CONN_KEYS(), ...Object.keys(CAT().settings), ...Object.keys(CAT().arc1.env)])];
  const up = k.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (known.includes(up)) return up;
  let best = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const cand of known) {
    const d = levenshtein(up, cand);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return bestD <= Math.max(2, Math.floor(up.length / 6)) ? best : null;
}

// ===========================================================================
// Connections (working copy)
// ===========================================================================
const envOf = (c) => (c.entry.env && typeof c.entry.env === 'object' ? c.entry.env : {});
const envW = (c) => {
  if (!c.entry.env || typeof c.entry.env !== 'object') c.entry.env = {};
  return c.entry.env;
};
const isRef = (v) => /^\$\{[^}]+\}$/.test(String(v ?? ''));
const truthy = (v) => v === 'true' || v === '1';

function makeConn(item) {
  return {
    id: uid(),
    name: item.name,
    arc1: Boolean(item.arc1),
    entry: structuredClone(item.entry || {}),
    inner: item.inner ? [...item.inner] : null,
    style: item.style || 'plain',
    runnerSpec: item.runnerSpec || null,
    wasWrapped: Boolean(item.wrapped),
    mode: item.wrapped ? 'store' : 'file',
    origAccount: item.account || null,
    stored: item.stored ?? null,
    password: '',
    pwdDirty: false,
    revealed: false,
    showPwd: false,
    pending: new Set(),
  };
}

const sel = () => S.conns.find((c) => c.id === S.selId) || null;

function snapshot() {
  return JSON.stringify(
    S.conns.map((c) => [c.name, c.entry, c.inner, c.style, c.mode, c.pwdDirty ? c.password : null]),
  );
}
const isDirty = () => Boolean(S.file) && snapshot() !== S.snap;

/** Rebuild an env object with `oldKey` replaced by `newKey` at the same position. */
function replaceKey(env, oldKey, newKey, value) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === oldKey) {
      if (!(newKey in env) || newKey === oldKey) out[newKey] = value;
    } else out[k] = v;
  }
  return out;
}

function withPasswordFirst(env, pw) {
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(env)) {
    if (k === 'SAP_PASSWORD') continue;
    out[k] = v;
    if (k === 'SAP_USER') {
      out.SAP_PASSWORD = pw;
      placed = true;
    }
  }
  if (!placed) out.SAP_PASSWORD = pw;
  return out;
}

function accountOk(c) {
  const env = envOf(c);
  return /^https?:\/\/[^\s/]+/i.test(env.SAP_URL || '') && String(env.SAP_USER || '').trim() !== '';
}

function cmdWinIssue(c) {
  if (S.boot.platform !== 'win32' || !c.arc1 || c.style === 'cmd') return false;
  return c.mode === 'store' || /^npx(\.cmd)?$/i.test(c.inner?.[0] || '');
}

function connIssues(c) {
  const out = { errors: 0, warns: 0 };
  if (!c.arc1) return out;
  for (const [k, v] of Object.entries(envOf(c))) {
    const kind = classify(k);
    if (kind === 'legacy') out.errors++;
    else if (kind === 'unknown' || kind === 'ignored') out.warns++;
    else if (kind === 'cat') {
      const r = checkValue(k, v);
      if (r?.level === 'err') out.errors++;
      else if (r) out.warns++;
    }
  }
  if (cmdWinIssue(c)) out.warns++;
  return out;
}

function joinCmd(arr) {
  return (arr || []).map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}
function splitCmd(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function writtenCommand(c) {
  const inner = c.inner?.length ? c.inner : S.boot.defaults.inner;
  const body = c.mode === 'store' ? ['npx', '-y', c.runnerSpec || 'arc1-connection-manager@1', 'run', '--', ...inner] : inner;
  return joinCmd(c.style === 'cmd' ? ['cmd', '/c', ...body] : body);
}

const storeLabel = () => t(`store.${S.boot.store.store}`);

// ===========================================================================
// Status, errors, dialogs
// ===========================================================================
function setStatus(key, args = [], tone = '') {
  S.status = key ? { key, args, tone } : null;
  renderStatus();
}
function renderStatus() {
  const el = $('#status');
  el.className = `status ${S.status?.tone || ''}`;
  el.textContent = S.status ? (S.status.tone === 'ok' ? '✓ ' : S.status.tone === 'warn' ? '⚠ ' : '') + t(S.status.key, ...S.status.args) : '';
}

const errorText = (e, fallback = 'msg.unexpected') =>
  e?.key && (S.L?.ui?.[e.key] || S.EN?.ui?.[e.key]) ? t(e.key, ...(e.args || [])) : t(fallback, e?.message || String(e));

let dialogDepth = 0;
/**
 * Generic modal. Resolves with the value passed to close().
 * `content`, `footExtra` and `buttons` may be functions receiving `close`.
 * A button may be a ready-made element (`{ node }`).
 */
function openDialog({ title, cls = '', content, buttons = [], onKey, initialFocus, footExtra }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    dialogDepth++;
    let done = false;
    let scrim = null;
    let keyHandler = null;
    const close = (value) => {
      if (done) return;
      done = true;
      dialogDepth--;
      scrim?.remove();
      document.removeEventListener('keydown', keyHandler, true);
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
      resolve(value);
    };
    const body = typeof content === 'function' ? content(close) : content;
    const extra = typeof footExtra === 'function' ? footExtra(close) : footExtra;
    const btns = typeof buttons === 'function' ? buttons(close) : buttons;
    const foot = btns.length
      ? h(
          'div',
          { class: 'd-foot' },
          extra || null,
          btns.map((b) =>
            b.node ||
            h(
              'button',
              {
                type: 'button',
                class: `btn${b.accent ? ' accent' : ''}`,
                disabled: b.disabled,
                onClick: () => (b.onClick ? b.onClick(close) : close(b.value)),
              },
              b.label,
            ),
          ),
        )
      : null;
    const dialog = h(
      'div',
      { class: `dialog ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h(
        'div',
        { class: 'd-head' },
        h('h2', { text: title }),
        h('button', { type: 'button', class: 'btn subtle icon-only', title: t('dlg.close.tt'), 'aria-label': t('dlg.close.tt'), onClick: () => close(null) }, icon('close', 16)),
      ),
      body,
      foot,
    );
    scrim = h('div', { class: 'scrim', onMousedown: (e) => e.target === scrim && close(null) }, dialog);
    keyHandler = (e) => {
      if (!document.contains(scrim) || scrim !== $('#layers').lastElementChild) return;
      if (onKey && onKey(e, close) === true) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Tab') {
        const f = $$('button:not(:disabled), input:not(:disabled), [tabindex="0"], select, textarea', dialog).filter((x) => x.offsetParent);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', keyHandler, true);
    $('#layers').append(scrim);
    const focusEl = initialFocus?.(dialog) || dialog.querySelector('.d-foot .btn.accent') || dialog.querySelector('.d-foot .btn') || dialog.querySelector('button');
    focusEl?.focus();
  });
}

const TONE_ICON = { ok: 'checkFilled', warn: 'warningFilled', err: 'errorFilled', info: 'infoFilled' };
function message({ title, text, tone = 'info', buttons, body }) {
  return openDialog({
    title: title || t('app.title'),
    content: h('div', { class: 'd-body' }, h('div', { class: 'd-msg' }, icon(TONE_ICON[tone], 28, tone), h('div', {}, h('p', { text }), body || null))),
    buttons: buttons || [{ label: t('dlg.ok'), value: true, accent: true }],
  });
}
const showError = (e, fallback) => message({ tone: 'err', text: errorText(e, fallback) });

function busyButton(btn, on) {
  if (!btn) return;
  btn.classList.toggle('busy', on);
  btn.disabled = on;
  const ic = btn.querySelector('.ic');
  if (on && ic) {
    ic.dataset.prev = ic.innerHTML;
    setKids(ic, h('span', { class: 'spinner' }));
  } else if (!on && ic?.dataset.prev) {
    ic.innerHTML = ic.dataset.prev;
    delete ic.dataset.prev;
  }
}

// ===========================================================================
// Rendering
// ===========================================================================
function renderAll() {
  if (!S.boot) return;
  renderTop();
  renderSidebar();
  renderMain();
  renderFooter();
  renderBanner();
  renderStatus();
}

function renderTop() {
  const p = $('#filePath');
  p.textContent = S.file ? S.file.path : t('top.nofile');
  p.title = S.file ? S.file.path : '';
  $('#btnReload').disabled = !S.file;
}

function renderFooter() {
  $('#btnSave').disabled = !S.file || S.saving;
  $('#dirty').hidden = !isDirty();
}

function renderBanner() {
  const el = $('#banner');
  if (!S.banner) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  setKids(el, 
    icon('warningFilled'),
    h('div', { class: 'b-text', text: t(S.banner === 'missing' ? 'ban.missing' : 'ban.changed') }),
    S.banner === 'changed'
      ? [
          h('button', { type: 'button', class: 'btn small', onClick: () => { S.banner = null; renderBanner(); } }, t('ban.keep')),
          h('button', { type: 'button', class: 'btn small accent', onClick: () => reloadFile(true) }, t('ban.reload')),
        ]
      : h('button', { type: 'button', class: 'btn subtle icon-only', 'aria-label': t('dlg.close.tt'), onClick: () => { S.banner = null; renderBanner(); } }, icon('close', 16)),
  );
}

function renderSidebar() {
  const list = $('#connList');
  setKids(list);
  const arc = S.conns.filter((c) => c.arc1);
  const others = S.conns.filter((c) => !c.arc1);
  for (const c of arc) list.append(connItem(c));
  if (others.length) {
    list.append(h('li', { class: 'conn-group', role: 'presentation', title: t('side.other.tt'), text: t('side.other') }));
    for (const c of others) list.append(connItem(c));
  }
  $('#connCount').textContent = S.file ? String(arc.length) : '';
  const cur = sel();
  $('#btnAddConn').disabled = !S.file;
  $('#btnDup').disabled = !cur || !cur.arc1;
  $('#btnDel').disabled = !cur;
}

function connItem(c) {
  const env = envOf(c);
  let sub;
  if (c.arc1) {
    sub = env.SAP_URL ? String(env.SAP_URL).replace(/^https?:\/\//i, '').replace(/\/+$/, '') : t('side.noaddr');
    if (env.SAP_CLIENT) sub += `  ·  ${env.SAP_CLIENT}`;
  } else {
    sub = joinCmd([c.entry.command, ...(Array.isArray(c.entry.args) ? c.entry.args : [])].filter((x) => typeof x === 'string')) || c.entry.url || '';
  }
  const iss = connIssues(c);
  return h(
    'li',
    {
      class: `conn-item${c.arc1 ? '' : ' other'}`,
      role: 'option',
      tabindex: '0',
      'data-id': c.id,
      'aria-selected': c.id === S.selId ? 'true' : 'false',
      title: c.arc1 ? null : t('side.other.tt'),
      onClick: () => select(c.id),
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(c.id);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = $$('.conn-item');
          const i = items.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1);
          if (items[i]) {
            items[i].focus();
            select(items[i].dataset.id, true);
          }
        }
      },
    },
    icon(c.arc1 ? 'laptop' : 'server', 18),
    h('div', { class: 'txt' }, h('div', { class: 'nm', text: c.name }), h('div', { class: 'sub', text: sub })),
    h(
      'div',
      { class: 'badges' },
      c.arc1 && c.mode === 'store' ? h('span', { class: 'badge-lock', title: t('side.stored.tt') }, icon('lockFilled', 14)) : null,
      iss.errors
        ? h('span', { class: 'badge-err', title: t('side.legacy.tt') }, icon('errorFilled', 16))
        : iss.warns
          ? h('span', { class: 'badge-warn' }, icon('warningFilled', 16))
          : null,
    ),
  );
}

function renderMain(keepScroll = false) {
  const main = $('#main');
  const top = main.scrollTop;
  if (!S.file) setKids(main, welcomeView());
  else {
    const c = sel();
    if (!c) setKids(main, emptyView());
    else if (!c.arc1) setKids(main, otherView(c));
    else setKids(main, editorView(c));
  }
  main.scrollTop = keepScroll ? top : 0;
}

function welcomeView() {
  const recent = (S.boot.recent || []).slice(0, 5);
  return h(
    'div',
    { class: 'center' },
    h('img', { class: 'welcome-logo', src: 'logo.png', alt: '' }),
    h('h1', { text: t('welcome.title') }),
    h('p', { text: t('welcome.text') }),
    h(
      'div',
      { class: 'welcome-cards' },
      h('button', { type: 'button', class: 'wcard', id: 'wOpen', onClick: () => openFileFlow() }, icon('folderOpen', 32), h('div', { class: 'w-title', text: t('welcome.open') }), h('div', { class: 'w-desc', text: t('welcome.open.desc') })),
      h('button', { type: 'button', class: 'wcard', id: 'wNew', onClick: () => newFileFlow() }, icon('docAdd', 32), h('div', { class: 'w-title', text: t('welcome.new') }), h('div', { class: 'w-desc', text: t('welcome.new.desc') })),
    ),
    h('p', { class: 'hint', text: t('welcome.hint') }),
    S.missing ? h('p', { class: 'missing', text: t('welcome.missing', S.missing) }) : null,
    h(
      'button',
      { type: 'button', class: 'btn subtle small shortcut-btn', title: t('welcome.shortcut.tt'), onClick: (e) => makeShortcut(e.currentTarget) },
      icon('window', 16),
      t('welcome.shortcut'),
    ),
    recent.length
      ? h(
          'div',
          { class: 'recent' },
          h('h2', { text: t('welcome.recent') }),
          recent.map((p) => h('button', { type: 'button', title: p, onClick: () => openPath(p) }, icon('docText', 18), h('span', { class: 'rp', text: p }))),
        )
      : null,
  );
}

function emptyView() {
  return h('div', { class: 'center' }, icon('laptop', 48, 'empty-ic'), h('h1', { text: t('empty.title') }), h('p', { text: t('empty.text') }));
}

function otherView(c) {
  const cmd = joinCmd([c.entry.command, ...(Array.isArray(c.entry.args) ? c.entry.args : [])].filter((x) => typeof x === 'string'));
  return h(
    'div',
    { class: 'page' },
    h('div', { class: 'ed-head' }, h('div', { class: 'ed-title' }, h('div', { class: 'name-input', style: null, text: c.name }))),
    h(
      'div',
      { class: 'cards' },
      card({ icon: 'infoFilled', label: t('other.title'), help: t('other.text') }),
      card({ icon: 'code', label: t('other.cmd'), help: cmd || c.entry.url || '—', mono: true }),
    ),
  );
}

/** Generic setting card. */
function card({ icon: ic, label, help, helpNode, key, editor, wide, trail, tone, arc1Line, mono }) {
  return h(
    'div',
    { class: `card${tone ? ` ${tone}` : ''}` },
    h('div', { class: 'c-icon' }, icon(ic, 20)),
    h(
      'div',
      { class: 'c-text' },
      h('div', { class: 'c-label', text: label }),
      help || helpNode ? h('div', { class: `c-help${mono ? ' mono' : ''}` }, help || null, helpNode || null) : null,
      arc1Line ? h('div', { class: 'c-arc1', text: arc1Line }) : null,
      key ? h('div', { class: 'c-key', text: key }) : null,
    ),
    editor ? h('div', { class: `c-editor${wide ? ' wide' : ''}` }, editor) : h('div'),
    h('div', { class: 'c-trail' }, trail || null),
  );
}

function removeButton(c, k) {
  return h(
    'button',
    { type: 'button', class: 'btn subtle icon-only', title: t('set.remove.tt'), 'aria-label': t('set.remove.tt'), onClick: () => removeSetting(c, k) },
    icon('trash', 16),
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function afterChange(c, { side = true } = {}) {
  if (S.results.has(c.id)) {
    S.results.delete(c.id);
    setKids($('#valResult'));
  }
  const sub = $('#edSub');
  if (sub) {
    const url = envOf(c).SAP_URL;
    sub.textContent = url ? t('ed.system', url) : t('ed.noaddr');
  }
  const prev = $('#cmdPreview');
  if (prev) prev.textContent = writtenCommand(c);
  if (side) renderSidebar();
  renderFooter();
}

function setEnv(c, k, v) {
  const env = envW(c);
  if (v === null || v === undefined) delete env[k];
  else env[k] = v;
  afterChange(c);
}

function textInput(c, k, { cls = '', placeholder = '', check, type = 'text', narrow = false, upper = false, maxLength } = {}) {
  const env = envOf(c);
  const inp = h('input', {
    class: `input ${cls}${narrow ? ' narrow' : ''}${upper ? ' upper' : ''}`.trim(),
    type,
    value: env[k] ?? '',
    placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
    maxlength: maxLength,
    'data-key': k,
  });
  const validate = () => {
    const bad = check ? check(inp.value.trim()) : false;
    inp.classList.toggle('bad', Boolean(bad));
  };
  inp.addEventListener('input', () => {
    let v = inp.value;
    if (upper) v = v.toUpperCase();
    setEnv(c, k, v.trim() === '' ? null : v.trim());
    validate();
  });
  validate();
  return inp;
}

function editorView(c) {
  const env = envOf(c);
  const store = S.boot.store;
  const page = h('div', { class: 'page' });

  // header
  const nameInput = h('input', {
    class: 'name-input',
    id: 'nameInput',
    value: c.name,
    title: t('ed.name.tt'),
    'aria-label': t('ed.name.tt'),
    spellcheck: 'false',
    onKeydown: (e) => {
      if (e.key === 'Enter') e.currentTarget.blur();
      if (e.key === 'Escape') {
        e.currentTarget.value = c.name;
        e.currentTarget.blur();
      }
    },
    onChange: (e) => commitName(c, e.currentTarget.value),
  });
  page.append(
    h(
      'div',
      { class: 'ed-head' },
      h('div', { class: 'ed-title' }, nameInput, h('div', { class: 'ed-sub', id: 'edSub', text: env.SAP_URL ? t('ed.system', env.SAP_URL) : t('ed.noaddr') })),
      h(
        'div',
        { class: 'ed-actions' },
        h('button', { type: 'button', class: 'btn', id: 'btnValidate', title: t('ed.validate.tt'), onClick: (e) => validateConn(c, e.currentTarget) }, icon('shieldCheck'), t('ed.validate')),
        h('button', { type: 'button', class: 'btn', id: 'btnTest', title: t('ed.test.tt'), onClick: (e) => testConn(c, e.currentTarget) }, icon('plug'), t('ed.test')),
      ),
    ),
  );

  if (cmdWinIssue(c)) {
    page.append(
      h(
        'div',
        { class: 'issue' },
        icon('warningFilled'),
        h('div', { text: t('issue.cmdwin') }),
        h('button', { type: 'button', class: 'btn small', onClick: () => { c.style = 'cmd'; afterChange(c); renderMain(true); } }, t('issue.fix')),
      ),
    );
  }

  page.append(h('div', { id: 'valResult' }, resultView(c)));

  // SAP connection
  const urlOk = (v) => v !== '' && !/^https?:\/\/[^\s/]+/i.test(v);
  page.append(h('div', { class: 'section', text: t('ed.conn') }));
  page.append(
    h(
      'div',
      { class: 'cards' },
      card({ icon: 'globe', label: t('f.url'), help: t('f.url.help'), key: 'SAP_URL', wide: true, editor: textInput(c, 'SAP_URL', { placeholder: 'https://sap-host:44300', check: urlOk }) }),
      card({ icon: 'user', label: t('f.user'), help: t('f.user.help'), key: 'SAP_USER', wide: true, editor: textInput(c, 'SAP_USER') }),
      passwordCard(c, store),
      card({ icon: 'client', label: t('f.client'), help: t('f.client.help'), key: 'SAP_CLIENT', editor: textInput(c, 'SAP_CLIENT', { narrow: true, placeholder: '100', maxLength: 3, check: (v) => v !== '' && !/^\d{3}$/.test(v) }) }),
      card({ icon: 'language', label: t('f.lang'), help: t('f.lang.help'), key: 'SAP_LANGUAGE', editor: textInput(c, 'SAP_LANGUAGE', { narrow: true, upper: true, placeholder: 'EN', maxLength: 2, check: (v) => v !== '' && !/^[A-Za-z0-9]{2}$/.test(v) }) }),
    ),
  );

  // settings
  page.append(
    h(
      'div',
      { class: 'section-row' },
      h('div', {}, h('div', { class: 'section', text: t('ed.settings') }), h('div', { class: 'section-desc', text: t('ed.settings.desc') })),
      h('button', { type: 'button', class: 'btn accent', id: 'btnAddSetting', onClick: () => openAddSetting(c) }, icon('add'), t('ed.add')),
    ),
  );
  page.append(settingsView(c));

  // advanced
  const cmdInput = h('input', {
    class: 'input mono',
    value: joinCmd(c.inner?.length ? c.inner : S.boot.defaults.inner),
    spellcheck: 'false',
    onChange: (e) => {
      const parts = splitCmd(e.currentTarget.value);
      c.inner = parts.length ? parts : [...S.boot.defaults.inner];
      e.currentTarget.value = joinCmd(c.inner);
      afterChange(c);
    },
  });
  const adv = h(
    'details',
    { class: 'adv', open: S.advOpen, onToggle: (e) => { S.advOpen = e.currentTarget.open; } },
    h('summary', {}, icon('chevronRight', 16, 'chev'), t('ed.advanced')),
    h(
      'div',
      { class: 'cards' },
      card({
        icon: 'code',
        label: t('ed.cmd'),
        helpNode: h('span', {}, t('ed.cmd.help'), h('div', { class: 'cmd-preview' }, `${t('ed.cmd.written')} `, h('span', { id: 'cmdPreview', text: writtenCommand(c) }))),
        wide: true,
        editor: cmdInput,
      }),
    ),
  );
  page.append(adv);
  return page;
}

function passwordCard(c, store) {
  const env = envOf(c);
  const isStore = c.mode === 'store';
  const value = isStore ? (c.pwdDirty || c.revealed ? c.password : '') : (env.SAP_PASSWORD ?? '');
  const placeholder = isStore ? (c.stored ? t('pwd.ph.stored') : t('pwd.ph.none')) : '';
  const inp = h('input', {
    class: 'input',
    type: c.showPwd ? 'text' : 'password',
    value,
    placeholder,
    autocomplete: 'new-password',
    spellcheck: 'false',
    'data-key': 'SAP_PASSWORD',
    onInput: (e) => {
      const v = e.currentTarget.value;
      if (c.mode === 'store') {
        c.password = v;
        c.pwdDirty = v !== '';
        if (v === '') c.revealed = false;
        afterChange(c, { side: false });
      } else setEnv(c, 'SAP_PASSWORD', v === '' ? null : v);
    },
  });
  const eye = h(
    'button',
    {
      type: 'button',
      class: 'in-btn',
      title: t(c.showPwd ? 'pwd.hide' : 'pwd.show'),
      'aria-label': t(c.showPwd ? 'pwd.hide' : 'pwd.show'),
      onClick: async () => {
        if (!c.showPwd && c.mode === 'store' && !c.pwdDirty && !c.revealed && c.stored && c.origAccount) {
          try {
            const r = await api('POST', '/api/secret/reveal', { account: c.origAccount });
            c.password = r.password || '';
            c.revealed = true;
          } catch (e) {
            showError(e);
            return;
          }
        }
        c.showPwd = !c.showPwd;
        renderMain(true);
        $('input[data-key="SAP_PASSWORD"]')?.focus();
      },
    },
    icon(c.showPwd ? 'eyeOff' : 'eye', 16),
  );
  const seg = h(
    'div',
    { class: 'seg', role: 'group' },
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': isStore ? 'true' : 'false',
        title: store.available ? t('pwd.mode.store.tt') : t('pwd.na', store.reason || ''),
        disabled: !store.available && !isStore,
        onClick: () => switchMode(c, 'store'),
      },
      icon('lock', 16),
      t('pwd.mode.store'),
    ),
    h('button', { type: 'button', 'aria-pressed': isStore ? 'false' : 'true', title: t('pwd.mode.file.tt'), onClick: () => switchMode(c, 'file') }, icon('document', 16), t('pwd.mode.file')),
  );
  let help = isStore ? t('f.pwd.help.store', storeLabel()) : t('f.pwd.help');
  if (!store.available) help += `  ${t('pwd.na', store.reason || '')}`;
  return h(
    'div',
    { class: `card${!isStore && env.SAP_PASSWORD && !isRef(env.SAP_PASSWORD) && store.available ? '' : ''}` },
    h('div', { class: 'c-icon' }, icon(isStore ? 'lock' : 'lockOpen', 20)),
    h('div', { class: 'c-text' }, h('div', { class: 'c-label', text: t('f.pwd') }), h('div', { class: 'c-help', text: help }), h('div', { class: 'c-key', text: 'SAP_PASSWORD' })),
    h('div', { class: 'pwd-editor' }, h('div', { class: 'input-wrap' }, inp, eye), seg),
    h('div', { class: 'c-trail' }),
  );
}

async function switchMode(c, mode) {
  if (mode === c.mode) return;
  const env = envW(c);
  if (mode === 'store') {
    if (!S.boot.store.available) return;
    const pw = env.SAP_PASSWORD;
    if (pw && !isRef(pw)) {
      c.password = pw;
      c.pwdDirty = true;
    }
    delete env.SAP_PASSWORD;
    c.mode = 'store';
  } else {
    let pw = c.pwdDirty || c.revealed ? c.password : null;
    if (!pw && c.stored && c.origAccount) {
      try {
        pw = (await api('POST', '/api/secret/reveal', { account: c.origAccount })).password;
      } catch {
        pw = null;
      }
    }
    c.entry.env = pw ? withPasswordFirst(env, pw) : env;
    c.mode = 'file';
    c.password = '';
    c.pwdDirty = false;
    c.revealed = false;
  }
  afterChange(c);
  renderMain(true);
}

function settingsView(c) {
  const env = envOf(c);
  const conn = CONN_KEYS();
  const keys = [...new Set([...Object.keys(env).filter((k) => !conn.includes(k)), ...c.pending])];
  const wrap = h('div', {});
  const byKind = { legacy: [], ignored: [], cat: [], server: [], unknown: [] };
  for (const k of keys) {
    const kind = classify(k);
    if (byKind[kind]) byKind[kind].push(k);
  }
  if (byKind.legacy.length) {
    wrap.append(h('div', { class: 'section danger' }, icon('warningFilled', 16), t('grp.legacy')));
    wrap.append(h('div', { class: 'cards' }, byKind.legacy.map((k) => legacyCard(c, k))));
  }
  const order = Object.keys(CAT().settings);
  for (const g of CAT().groups) {
    const inGroup = order.filter((k) => catDef(k).group === g.id && byKind.cat.includes(k));
    if (!inGroup.length) continue;
    wrap.append(h('div', { class: 'section' }, icon(g.icon, 16), groupName(g.id)));
    wrap.append(h('div', { class: 'cards' }, inGroup.map((k) => settingCard(c, k))));
  }
  const rest = [...byKind.server, ...byKind.ignored, ...byKind.unknown];
  if (rest.length) {
    wrap.append(h('div', { class: 'section' }, icon('question', 16), t('grp.other')));
    wrap.append(
      h(
        'div',
        { class: 'cards' },
        rest.map((k) => (byKind.server.includes(k) ? serverCard(c, k) : byKind.ignored.includes(k) ? ignoredCard(c, k) : unknownCard(c, k))),
      ),
    );
  }
  if (!wrap.children.length) {
    wrap.append(h('div', { class: 'cards' }, h('div', { class: 'card note' }, icon('info', 20), h('div', { class: 'c-help', text: t('set.none') }), h('div'))));
  }
  return wrap;
}

function defaultText(d) {
  if (d.type === 'feature') return 'auto';
  if (d.type === 'bool') return d.default === 'true' ? t('set.on') : t('set.off');
  if (d.defaultText) return d.defaultText;
  return d.default === undefined || d.default === '' ? t('set.empty') : d.default;
}

function toggle(checked, onChange) {
  const label = h('span', { class: 'tlabel', text: checked ? t('set.on') : t('set.off') });
  const inp = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked,
    onChange: (e) => {
      label.textContent = e.currentTarget.checked ? t('set.on') : t('set.off');
      onChange(e.currentTarget.checked);
    },
  });
  return h('label', { class: 'toggle' }, inp, h('span', { class: 'track' }), label);
}

function segChoice(options, current, def, onPick) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  const all = current !== undefined && current !== null && !options.includes(current) && String(current).trim() !== '' ? options : options;
  for (const o of all) {
    wrap.append(
      h(
        'button',
        {
          type: 'button',
          class: o === def ? 'is-default' : null,
          title: o === def ? t('set.default.tt') : null,
          'aria-pressed': o === current ? 'true' : 'false',
          onClick: (e) => {
            for (const b of $$('button', wrap)) b.setAttribute('aria-pressed', 'false');
            e.currentTarget.setAttribute('aria-pressed', 'true');
            onPick(o);
          },
        },
        o,
      ),
    );
  }
  return wrap;
}

function helpWithCheck(base, res) {
  return h('span', {}, base, res ? h('span', { class: res.level === 'err' ? 'err-text' : 'warn-text', text: `  ⚠ ${res.msg}` }) : null);
}

function settingCard(c, k) {
  const d = catDef(k);
  const env = envOf(c);
  const v = env[k];
  let editor;
  let wide = false;
  const base = [catHelp(k), t('set.default', defaultText(d))].filter(Boolean).join('  ');
  const res = checkValue(k, v);
  const helpNode = h('span', {}, helpWithCheck(base, res));
  const refreshHelp = () => {
    setKids(helpNode, helpWithCheck(base, checkValue(k, envOf(c)[k])));
  };
  if (d.type === 'bool') {
    editor = toggle(truthy(v), (on) => {
      setEnv(c, k, on ? 'true' : 'false');
      refreshHelp();
    });
  } else if (d.type === 'feature' || d.type === 'enum') {
    const opts = d.type === 'feature' ? ['auto', 'on', 'off'] : [...d.options];
    if (v !== undefined && (d.hiddenOptions || []).includes(v) && !opts.includes(v)) opts.push(v);
    editor = segChoice(opts, v, d.type === 'feature' ? 'auto' : d.default, (o) => {
      setEnv(c, k, o);
      refreshHelp();
    });
  } else {
    const isPath = d.type === 'path';
    const inp = h('input', {
      class: `input${d.type === 'int' ? ' narrow' : ''}${isPath || d.type === 'list' ? ' mono' : ''}`,
      type: d.secret && !c[`show_${k}`] ? 'password' : 'text',
      value: v ?? '',
      placeholder: d.type === 'int' ? d.default ?? '' : '',
      inputmode: d.type === 'int' ? 'numeric' : null,
      spellcheck: 'false',
      autocomplete: 'off',
      'data-key': k,
    });
    const validate = () => inp.classList.toggle('bad', Boolean(checkValue(k, inp.value.trim() === '' ? undefined : inp.value.trim())));
    inp.addEventListener('input', () => {
      const s = inp.value.trim();
      if (s === '') c.pending.add(k);
      setEnv(c, k, s === '' ? null : s);
      validate();
      refreshHelp();
    });
    validate();
    if (isPath || d.secret) {
      const btn = isPath
        ? h('button', {
            type: 'button',
            class: 'in-btn',
            title: t('set.browse.tt'),
            'aria-label': t('set.browse.tt'),
            onClick: async () => {
              const p = await fileBrowser({ mode: 'pick', start: inp.value.trim() ? parentOf(inp.value.trim()) : S.file?.dir, any: true });
              if (p) {
                inp.value = p;
                inp.dispatchEvent(new Event('input'));
              }
            },
          }, icon('folderOpen', 16))
        : h('button', {
            type: 'button',
            class: 'in-btn',
            title: t(c[`show_${k}`] ? 'pwd.hide' : 'pwd.show'),
            onClick: () => {
              c[`show_${k}`] = !c[`show_${k}`];
              renderMain(true);
            },
          }, icon(c[`show_${k}`] ? 'eyeOff' : 'eye', 16));
      editor = h('div', { class: 'input-wrap' }, inp, btn);
    } else editor = inp;
    wide = d.type !== 'int';
  }
  return card({ icon: groupIcon(d.group), label: catLabel(k), helpNode, key: k, editor, wide, trail: removeButton(c, k) });
}

function legacyCard(c, k) {
  const env = envOf(c);
  const rule = CAT().legacyRules[k];
  const arcMsg = CAT().arc1.legacy[k] ?? CAT().arc1.retired[k];
  let help = `${t('set.legacy.help')} `;
  if (rule?.to) help += t('set.legacy.use', catLabel(rule.to), rule.to) + (rule.invert ? ` ${t('set.legacy.inverted')}` : '');
  else help += t(rule?.note || 'legacy.removed');
  help += `  ${t('set.legacy.current', env[k])}`;
  const editor = rule?.to
    ? h('button', { type: 'button', class: 'btn accent', onClick: () => convertLegacy(c, k) }, icon('convert', 16), t('set.legacy.convert', catLabel(rule.to)))
    : null;
  return card({ icon: 'warningFilled', label: t('set.legacy.title'), help, key: k, arc1Line: arcMsg ? t('set.arc1says', arcMsg) : null, editor, tone: 'danger', trail: removeButton(c, k) });
}

function ignoredCard(c, k) {
  const arcMsg = CAT().arc1.ignored[k];
  return card({
    icon: 'warningFilled',
    label: t('set.ignored.title'),
    help: t('set.ignored.help'),
    key: k,
    arc1Line: arcMsg ? t('set.arc1says', arcMsg) : null,
    editor: textInput(c, k),
    wide: true,
    tone: 'warn',
    trail: removeButton(c, k),
  });
}

function unknownCard(c, k) {
  const sug = suggestKey(k);
  const help = sug ? `${t('set.unknown.help')} ${t('set.unknown.typo', sug)}` : t('set.unknown.help');
  const editor = h(
    'div',
    { class: 'c-editor-row', style: null },
    textInput(c, k),
    sug && !(sug in envOf(c)) ? h('button', { type: 'button', class: 'btn accent', onClick: () => renameKey(c, k, sug) }, icon('arrowRight', 16), t('set.unknown.rename', sug)) : null,
  );
  editor.style.display = 'flex';
  editor.style.gap = '8px';
  editor.style.width = '100%';
  return card({ icon: 'question', label: t('set.unknown.title'), help, key: k, editor, wide: true, tone: 'warn', trail: removeButton(c, k) });
}

function serverCard(c, k) {
  const info = arc1Info(k);
  const env = envOf(c);
  const v = env[k];
  let editor;
  let wide = false;
  if (info.kind === 'bool') editor = toggle(truthy(v), (on) => setEnv(c, k, on ? 'true' : 'false'));
  else if (info.kind === 'feature' || info.options) {
    const opts = info.options || ['auto', 'on', 'off'];
    editor = segChoice(opts, v, info.default, (o) => setEnv(c, k, o));
  } else {
    editor = textInput(c, k, { cls: 'mono' });
    wide = true;
  }
  const help = [info.description, t('set.server.help')].filter(Boolean).join(' · ');
  return card({ icon: 'server', label: t('set.server.title'), help, key: k, editor, wide, trail: removeButton(c, k) });
}

function resultView(c) {
  const r = S.results.get(c.id);
  if (!r) return null;
  if (r.busy) {
    return h('div', { class: 'result busy' }, h('span', { class: 'ic' }, h('span', { class: 'spinner' })), h('div', { class: 'r-title', text: t('val.running') }), h('div'));
  }
  const closeBtn = h('button', { type: 'button', class: 'btn subtle icon-only', 'aria-label': t('dlg.close.tt'), title: t('dlg.close.tt'), onClick: () => { S.results.delete(c.id); setKids($('#valResult')); } }, icon('close', 16));
  if (r.ok) {
    const p = r.policy || {};
    const yes = (b) => h('span', { class: `p-v ${b ? 'yes' : 'no'}`, text: b ? t('val.allowed') : t('val.blocked') });
    const listText = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => (typeof x === 'string' ? x : x?.pattern || x?.raw || JSON.stringify(x))).join(', ') : t('val.none'));
    const row = (k, vNode) => h('div', { class: 'p-row' }, h('span', { class: 'p-k', text: t(k) }), vNode);
    return h(
      'div',
      { class: 'result ok' },
      icon('checkFilled', 22),
      h('div', { class: 'r-title', text: t('val.ok', r.version || '') }),
      closeBtn,
      h(
        'div',
        { class: 'r-body' },
        h('div', { class: 'section-desc', text: t('val.policy') }),
        h(
          'div',
          { class: 'policy' },
          row('val.writes', yes(p.allowWrites)),
          row('val.packages', h('span', { class: 'p-v', text: listText(p.allowedPackages) })),
          row('val.transports', yes(p.allowTransportWrites)),
          row('val.git', yes(p.allowGitWrites)),
          row('val.data', yes(p.allowDataPreview)),
          row('val.sql', yes(p.allowFreeSQL)),
          row('val.deny', h('span', { class: 'p-v', text: listText(p.denyActions) })),
          row('val.sources', h('span', { class: 'p-v', text: listText(p.blockedDataSources) })),
        ),
        r.warnings ? h('div', {}, h('div', { class: 'section-desc', style: null, text: t('val.warnings') }), h('pre', { text: r.warnings })) : null,
      ),
    );
  }
  const title =
    r.kind === 'rejected'
      ? t('val.fail', r.version || '')
      : r.kind === 'timeout'
        ? t('val.timeout')
        : r.kind === 'nonpx'
          ? t('val.nonpx')
          : t('val.error');
  return h('div', { class: 'result err' }, icon('errorFilled', 22), h('div', { class: 'r-title', text: title }), closeBtn, r.message ? h('div', { class: 'r-body' }, h('pre', { text: r.message })) : null);
}

// ===========================================================================
// Actions
// ===========================================================================
function select(id, keepFocus = false) {
  const cur = sel();
  if (cur && cur.id !== id) commitNameFromInput();
  S.selId = id;
  const c = sel();
  if (c) api('POST', '/api/settings', { lastConnection: c.name }).catch(() => {});
  renderSidebar();
  renderMain();
  if (keepFocus) $(`.conn-item[data-id="${id}"]`)?.focus();
}

function commitNameFromInput() {
  const inp = $('#nameInput');
  const c = sel();
  if (inp && c && inp.value !== c.name) commitName(c, inp.value);
}

function commitName(c, raw) {
  const name = raw.trim();
  if (name === c.name) return true;
  const inp = $('#nameInput');
  if (!name) {
    message({ tone: 'warn', text: t('msg.name.empty') });
    if (inp) inp.value = c.name;
    return false;
  }
  if (S.conns.some((o) => o !== c && o.name === name)) {
    message({ tone: 'warn', text: t('msg.name.exists', name) });
    if (inp) inp.value = c.name;
    return false;
  }
  const old = c.name;
  c.name = name;
  setStatus('st.renamed', [old, name]);
  renderSidebar();
  renderFooter();
  return true;
}

function uniqueName(base) {
  let n = base;
  let i = 2;
  while (S.conns.some((c) => c.name === n)) n = `${base}-${i++}`;
  return n;
}

function addConnection() {
  if (!S.file) return;
  const c = makeConn({ name: uniqueName('sap-new'), entry: { env: {} }, arc1: true, inner: S.boot.defaults.inner, style: S.boot.defaults.style });
  c.mode = S.boot.store.available ? 'store' : 'file';
  S.conns.push(c);
  select(c.id);
  setStatus('st.newconn', [c.name]);
  $('input[data-key="SAP_URL"]')?.focus();
}

function duplicateConnection() {
  const src = sel();
  if (!src?.arc1) return;
  commitNameFromInput();
  const c = { ...src, id: uid(), name: uniqueName(`${src.name}-copy`), entry: structuredClone(src.entry), inner: [...(src.inner || [])], pending: new Set(src.pending), showPwd: false };
  S.conns.splice(S.conns.indexOf(src) + 1, 0, c);
  select(c.id);
  setStatus('st.copied', [src.name, c.name]);
}

async function deleteConnection() {
  const c = sel();
  if (!c) return;
  const ok = await message({ tone: 'warn', text: t('msg.delete', c.name), buttons: [{ label: t('dlg.no'), value: false }, { label: t('dlg.yes'), value: true, accent: true }] });
  if (!ok) return;
  const i = S.conns.indexOf(c);
  S.conns.splice(i, 1);
  S.results.delete(c.id);
  const next = S.conns[i] || S.conns[i - 1];
  S.selId = next?.id || null;
  renderAll();
  setStatus('st.deleted', [c.name]);
}

function removeSetting(c, k) {
  c.pending.delete(k);
  const env = envW(c);
  delete env[k];
  afterChange(c);
  renderMain(true);
  setStatus('st.removed', [k]);
}

function convertLegacy(c, k) {
  const rule = CAT().legacyRules[k];
  if (!rule?.to) return;
  const env = envW(c);
  const old = truthy(String(env[k] ?? '').trim());
  const nv = (rule.invert ? !old : old) ? 'true' : 'false';
  if (rule.to in env) delete env[k];
  else c.entry.env = replaceKey(env, k, rule.to, nv);
  afterChange(c);
  renderMain(true);
  setStatus('st.converted', [k, rule.to, nv]);
}

function renameKey(c, from, to) {
  const env = envW(c);
  c.entry.env = replaceKey(env, from, to, env[from]);
  afterChange(c);
  renderMain(true);
  setStatus('st.renamed', [from, to]);
}

async function testConn(c, btn) {
  commitNameFromInput();
  const env = envOf(c);
  if (!env.SAP_URL) return message({ tone: 'warn', title: t('test.title'), text: t('msg.url.first') });
  busyButton(btn, true);
  try {
    const r = await api('POST', '/api/test', {
      env,
      mode: c.mode,
      password: c.mode === 'store' && (c.pwdDirty || c.revealed) ? c.password : undefined,
      originalAccount: c.origAccount,
    });
    const map = {
      ok: ['ok', t('test.ok', r.status)],
      401: ['warn', t('test.401')],
      403: ['warn', t('test.403')],
      404: ['warn', t('test.404')],
      redirect: ['warn', t('test.redirect', r.status)],
      other: ['warn', t('test.other', r.status)],
      ssl: ['err', t('test.ssl', r.detail || '')],
      notfound: ['err', t('test.notfound', r.detail || '')],
      refused: ['err', t('test.refused', r.detail || '')],
      timeout: ['err', t('test.timeout')],
      badurl: ['warn', t('test.badurl')],
      fail: ['err', t('test.fail', r.detail || '')],
    };
    const [tone, text] = map[r.kind] || ['err', t('test.fail', r.kind)];
    await message({ title: t('test.title'), tone, text });
  } catch (e) {
    showError(e);
  } finally {
    busyButton(btn, false);
  }
}

async function validateConn(c, btn) {
  commitNameFromInput();
  const env = { ...envOf(c) };
  delete env.SAP_PASSWORD;
  S.results.set(c.id, { busy: true });
  setKids($('#valResult'), resultView(c));
  busyButton(btn, true);
  try {
    const r = await api('POST', '/api/validate', { env, inner: c.inner?.length ? c.inner : S.boot.defaults.inner, path: S.file?.path });
    S.results.set(c.id, r);
  } catch (e) {
    S.results.set(c.id, { ok: false, kind: 'error', message: errorText(e) });
  } finally {
    busyButton(btn, false);
  }
  if (sel()?.id === c.id) setKids($('#valResult'), resultView(c));
}

async function makeShortcut(btn) {
  busyButton(btn, true);
  try {
    const r = await api('POST', '/api/shortcut');
    setStatus('st.shortcut', [r.paths.join(', ') || '—'], 'ok');
  } catch (e) {
    showError(e);
  } finally {
    busyButton(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function loadModel(m, { keepSel = false } = {}) {
  const prev = keepSel ? sel()?.name : null;
  S.file = { path: m.path, name: m.name, dir: m.dir, hash: m.hash, rootKey: m.rootKey, format: m.format, badRoot: m.badRoot };
  S.conns = m.servers.map(makeConn);
  S.snap = snapshot();
  S.results.clear();
  S.banner = null;
  S.missing = null;
  S.jsoncOk = false;
  const pick = (name) => S.conns.find((c) => c.name === name);
  const target = pick(prev) || pick(S.boot.settings.lastConnection) || S.conns.find((c) => c.arc1) || S.conns[0];
  S.selId = target?.id || null;
  renderAll();
  const bad = S.conns.filter((c) => connIssues(c).errors > 0).map((c) => c.name);
  if (bad.length) setStatus('st.legacy', [bad.join(', ')], 'warn');
  else setStatus('st.loaded', [S.conns.filter((c) => c.arc1).length]);
}

async function confirmDiscard() {
  commitNameFromInput();
  if (!isDirty()) return true;
  const v = await message({
    tone: 'warn',
    text: t('msg.unsaved'),
    buttons: [
      { label: t('dlg.cancel'), value: null },
      { label: t('dlg.dontsave'), value: 'discard' },
      { label: t('dlg.save'), value: 'save', accent: true },
    ],
  });
  if (v === 'save') {
    await save();
    return !isDirty();
  }
  return v === 'discard';
}

async function openPath(path, { skipConfirm = false } = {}) {
  if (!skipConfirm && !(await confirmDiscard())) return false;
  try {
    const m = await api('POST', '/api/file/open', { path });
    loadModel(m);
    return true;
  } catch (e) {
    showError(e);
    return false;
  }
}

async function openFileFlow() {
  if (!(await confirmDiscard())) return;
  const p = await fileBrowser({ mode: 'open', start: S.file?.dir });
  if (p) await openPath(p, { skipConfirm: true });
}

async function newFileFlow() {
  if (!(await confirmDiscard())) return;
  const r = await fileBrowser({ mode: 'new', start: S.file?.dir });
  if (!r) return;
  try {
    let res = await api('POST', '/api/file/create', { dir: r.dir, name: r.name });
    if (res.exists) {
      const v = await message({
        tone: 'warn',
        text: t('msg.exists', res.path),
        buttons: [
          { label: t('dlg.cancel'), value: null },
          { label: t('dlg.replace'), value: 'replace' },
          { label: t('dlg.openit'), value: 'open', accent: true },
        ],
      });
      if (v === 'open') return openPath(res.path, { skipConfirm: true });
      if (v !== 'replace') return;
      res = await api('POST', '/api/file/create', { dir: r.dir, name: r.name, overwrite: true });
    }
    loadModel(res);
    setStatus('st.created', [res.path], 'ok');
    const url = $('input[data-key="SAP_URL"]');
    url?.focus();
    url?.select();
  } catch (e) {
    showError(e);
  }
}

async function reloadFile(skipConfirm = false) {
  if (!S.file) return;
  if (!skipConfirm && !(await confirmDiscard())) return;
  try {
    const m = await api('POST', '/api/file/open', { path: S.file.path });
    loadModel(m, { keepSel: true });
    setStatus('st.reloaded', [], 'ok');
  } catch (e) {
    showError(e);
  }
}

async function save({ force = false, allowMissing = false, confirmed = false } = {}) {
  if (!S.file || S.saving) return;
  commitNameFromInput();
  const arc = S.conns.filter((c) => c.arc1);

  const need = arc.filter((c) => c.mode === 'store' && !accountOk(c));
  if (need.length) return message({ tone: 'warn', text: need.map((c) => t('msg.store.need', c.name)).join('\n\n') });

  if (!confirmed) {
    const bad = arc.filter((c) => connIssues(c).errors > 0);
    if (bad.length) {
      const ok = await message({ tone: 'warn', text: t('msg.legacy.save', bad.map((c) => `  ${c.name}`).join('\n')), buttons: [{ label: t('dlg.cancel'), value: false }, { label: t('dlg.saveanyway'), value: true, accent: true }] });
      if (!ok) return;
    }
    const nopw = arc.filter((c) => c.mode === 'store' && !(c.pwdDirty && c.password) && !(c.stored && c.origAccount));
    if (nopw.length) {
      const ok = await message({ tone: 'warn', text: t('msg.pwd.confirm', nopw.map((c) => c.name).join(', ')), buttons: [{ label: t('dlg.cancel'), value: false }, { label: t('dlg.saveanyway'), value: true, accent: true }] });
      if (!ok) return;
      allowMissing = true;
    }
    if (S.file.format?.jsonc && !S.jsoncOk) {
      const ok = await message({ tone: 'warn', text: t('msg.jsonc'), buttons: [{ label: t('dlg.cancel'), value: false }, { label: t('dlg.save'), value: true, accent: true }] });
      if (!ok) return;
      S.jsoncOk = true;
    }
  }

  const body = {
    path: S.file.path,
    baseHash: S.file.hash,
    force,
    allowMissing,
    rootKey: S.file.rootKey,
    format: S.file.format,
    servers: S.conns.map((c) => ({
      name: c.name,
      arc1: c.arc1,
      entry: c.entry,
      inner: c.inner?.length ? c.inner : S.boot.defaults.inner,
      style: c.style,
      runnerSpec: c.runnerSpec,
      mode: c.mode,
      password: c.mode === 'store' && c.pwdDirty ? c.password : undefined,
      originalAccount: c.origAccount,
      wasWrapped: c.wasWrapped,
    })),
  };
  S.saving = true;
  busyButton($('#btnSave'), true);
  try {
    const r = await api('POST', '/api/file/save', body);
    if (r.conflict) {
      S.saving = false;
      busyButton($('#btnSave'), false);
      const v = await message({
        tone: 'warn',
        text: t('msg.conflict'),
        buttons: [
          { label: t('dlg.cancel'), value: null },
          { label: t('dlg.reload'), value: 'reload' },
          { label: t('dlg.overwrite'), value: 'overwrite', accent: true },
        ],
      });
      if (v === 'overwrite') return save({ force: true, allowMissing, confirmed: true });
      if (v === 'reload') return reloadFile(true);
      return;
    }
    loadModel(r.model, { keepSel: true });
    const time = new Date().toLocaleTimeString(S.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setStatus('st.saved', [time, `${S.file.name}.bak`], 'ok');
  } catch (e) {
    showError(e, 'msg.save.fail');
  } finally {
    S.saving = false;
    busyButton($('#btnSave'), false);
    renderFooter();
  }
}

// ===========================================================================
// Dialogs: add setting, language, file browser
// ===========================================================================
const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');

function openAddSetting(c) {
  const env = envOf(c);
  const order = Object.keys(CAT().settings);
  const all = [];
  for (const g of CAT().groups) for (const k of order) if (catDef(k).group === g.id && !(k in env) && !c.pending.has(k)) all.push(k);
  let shown = [];
  let index = 0;
  const input = h('input', { class: 'input', type: 'search', 'aria-label': t('add.title'), autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { class: 'list', role: 'listbox' });

  openDialog({
    title: t('add.title'),
    cls: 'mid',
    content: (close) => {
      const paint = () => {
        const q = norm(input.value.trim());
        shown = all.filter((k) => {
          if (!q) return true;
          const hay = norm([k, catLabel(k), catHelp(k), groupName(catDef(k).group), S.EN.cat?.[k]?.[0] || ''].join(' '));
          return q.split(/\s+/).every((w) => hay.includes(w));
        });
        index = Math.min(index, Math.max(0, shown.length - 1));
        setKids(list, 
          ...(shown.length
            ? shown.map((k, i) =>
                h(
                  'li',
                  {
                    role: 'option',
                    'aria-selected': i === index ? 'true' : 'false',
                    onClick: () => {
                      index = i;
                      paint();
                    },
                    onDblclick: () => close(k),
                  },
                  icon(groupIcon(catDef(k).group), 18),
                  h('span', { class: 'l-title', text: catLabel(k) }),
                  h('span', { class: 'l-grp', text: groupName(catDef(k).group) }),
                  catHelp(k) ? h('span', { class: 'l-help', text: catHelp(k) }) : null,
                  h('span', { class: 'l-key', text: k }),
                ),
              )
            : [h('li', { class: 'nomatch', text: t('add.nomatch') })]),
        );
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      };
      input.addEventListener('input', () => {
        index = 0;
        paint();
      });
      list.paint = paint;
      paint();
      const body = h('div', { class: 'd-body' }, h('div', { class: 'search-row' }, input, h('div', { class: 'hint', text: t('add.hint') })), list);
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.padding = '0';
      return body;
    },
    initialFocus: () => input,
    onKey: (e, close) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        index = Math.max(0, Math.min(shown.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
        list.paint();
        return true;
      }
      if (e.key === 'Enter' && shown[index]) {
        e.preventDefault();
        close(shown[index]);
        return true;
      }
      return false;
    },
  }).then((k) => {
    if (k) addSetting(c, k);
  });
}

function addSetting(c, k) {
  const d = catDef(k);
  const env = envW(c);
  if (d.type === 'bool') env[k] = d.default === 'true' ? 'false' : 'true';
  else if (d.type === 'enum') env[k] = d.options.find((o) => o !== d.default) ?? d.options[0];
  else if (d.type === 'feature') env[k] = 'on';
  else c.pending.add(k);
  afterChange(c);
  renderMain(true);
  setStatus('st.added', [() => catLabel(k)]);
  const keyEl = $$('.c-key').find((x) => x.textContent === k);
  keyEl?.closest('.card')?.scrollIntoView({ block: 'center' });
  const inp = $(`input[data-key="${k}"]`);
  if (inp) inp.focus();
}

function openLanguage() {
  const locales = S.boot.locales;
  let index = Math.max(0, locales.findIndex((l) => l.code === S.lang));
  const list = h('ul', { class: 'list lang-list', role: 'listbox' });
  openDialog({
    title: t('lang.title'),
    content: (close) => {
      list.paint = () => {
        setKids(list, 
          ...locales.map((l, i) =>
            h(
              'li',
              { role: 'option', tabindex: i === index ? '0' : '-1', 'aria-selected': i === index ? 'true' : 'false', lang: l.code, onClick: () => close(l.code) },
              h('span', { class: 'l-title', text: l.name }),
              h('span', { class: 'code', text: l.code }),
            ),
          ),
        );
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      };
      list.paint();
      const body = h('div', { class: 'd-body' }, list);
      body.style.padding = '0 0 8px';
      return body;
    },
    initialFocus: () => list.querySelector('[aria-selected="true"]'),
    onKey: (e, close) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        index = Math.max(0, Math.min(locales.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
        list.paint();
        list.querySelector('[aria-selected="true"]')?.focus();
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        close(locales[index].code);
        return true;
      }
      return false;
    },
  }).then((code) => {
    if (code && code !== S.lang) setLang(code, true);
  });
}

function parentOf(p) {
  const sep = S.boot.sep;
  const i = p.lastIndexOf(sep);
  if (i < 0) return p;
  if (i === 0) return sep;
  const d = p.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? `${d}\\` : d;
}
function joinPath(dir, name) {
  if (!dir) return name;
  const sep = S.boot.sep;
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/**
 * In-app file browser (a web page cannot get a real file path from the OS dialog).
 * mode: open (a .json file) | new (a folder + file name) | pick (any file, for path settings)
 */
function fileBrowser({ mode, start, any = false }) {
  const st = { path: null, parent: null, entries: [], selected: -1, places: [], recent: [], error: null };
  const pathInput = h('input', { class: 'input', spellcheck: 'false', 'aria-label': t('fb.path') });
  const list = h('ul', { class: 'fb-list', role: 'listbox', tabindex: '0' });
  const placesEl = h('div', { class: 'fb-places' });
  const nameInput = mode === 'new' ? h('input', { class: 'input mono fname', value: '.mcp.json', 'aria-label': t('fb.filename'), spellcheck: 'false' }) : null;
  const primary = h('button', { type: 'button', class: 'btn accent', id: 'fbPrimary' }, t(mode === 'new' ? 'fb.create' : mode === 'pick' ? 'fb.select' : 'fb.open'));
  const placeLabel = { cwd: 'fb.cwd', home: 'fb.home', desktop: 'fb.desktop', documents: 'fb.documents', workspace: 'fb.workspace', claude: 'fb.claude' };
  const placeIcon = { cwd: 'folderOpen', home: 'home', desktop: 'desktop', documents: 'document', workspace: 'folder', claude: 'docText' };
  const fileOk = (name) => any || /\.json$/i.test(name);
  let close = () => {};

  const current = () => st.entries[st.selected];
  const updatePrimary = () => {
    if (mode === 'new') primary.disabled = !st.path || !/^[^\\/]+\.json$/i.test(nameInput.value.trim());
    else primary.disabled = !(current() && !current().dir);
  };
  const activate = (e) => {
    if (!e) return;
    const full = e.drive ? e.name : joinPath(st.path, e.name);
    if (e.dir) go(full);
    else if (mode === 'new') nameInput.value = e.name;
    else close(full);
  };
  const paintList = () => {
    if (st.error) {
      setKids(list, h('li', { class: 'empty fb-err', text: st.error }));
      return;
    }
    setKids(list, 
      ...(st.entries.length
        ? st.entries.map((e, i) =>
            h(
              'li',
              {
                class: `${e.dir ? 'dir' : 'file'}${e.mcp ? ' mcp' : ''}`,
                role: 'option',
                'aria-selected': i === st.selected ? 'true' : 'false',
                title: e.name,
                onClick: () => {
                  st.selected = i;
                  if (mode === 'new' && !e.dir) nameInput.value = e.name;
                  paintList();
                  updatePrimary();
                },
                onDblclick: () => activate(e),
              },
              icon(e.drive ? 'drive' : e.dir ? 'folder' : e.mcp ? 'docText' : 'document', 18),
              h('span', { class: 'nm', text: e.name }),
            ),
          )
        : [h('li', { class: 'empty', text: t('fb.empty') })]),
    );
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const paintPlaces = () => {
    setKids(placesEl, 
      h('h3', { text: t('fb.places') }),
      st.places
        .filter((p) => !p.file || mode === 'open')
        .map((p) =>
          h(
            'button',
            { type: 'button', title: p.path, onClick: () => (p.file ? close(p.path) : go(p.path)) },
            icon(placeIcon[p.id] || 'folder', 18),
            h('span', { text: t(placeLabel[p.id] || 'fb.home') }),
          ),
        ),
      S.boot.platform === 'win32' ? h('button', { type: 'button', onClick: () => go('') }, icon('drive', 18), h('span', { text: t('fb.drives') })) : null,
      st.recent.length && mode === 'open'
        ? [
            h('h3', { text: t('fb.recent') }),
            st.recent.slice(0, 6).map((p) =>
              h('button', { type: 'button', title: p, onClick: () => close(p) }, icon('recent', 18), h('span', { text: p.split(/[\\/]/).slice(-2).join(S.boot.sep) })),
            ),
          ]
        : null,
    );
  };
  async function go(path) {
    try {
      const r = await api('POST', '/api/fs/list', { path });
      st.path = r.path;
      st.parent = r.parent;
      st.entries = r.entries.filter((e) => e.dir || fileOk(e.name));
      st.places = r.places;
      st.recent = r.recent;
      st.error = null;
      st.selected = mode === 'open' ? st.entries.findIndex((e) => e.mcp && e.name === '.mcp.json') : -1;
      if (st.selected < 0 && mode === 'open') st.selected = st.entries.findIndex((e) => e.mcp);
      pathInput.value = r.path || '';
      pathInput.placeholder = r.path ? '' : t('fb.drives');
    } catch (e) {
      st.error = errorText(e);
    }
    paintList();
    paintPlaces();
    updatePrimary();
  }

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      go(pathInput.value.trim());
    }
  });
  nameInput?.addEventListener('input', updatePrimary);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !primary.disabled) {
      e.preventDefault();
      primary.click();
    }
  });

  const promise = openDialog({
    title: t(mode === 'new' ? 'fb.new.title' : mode === 'pick' ? 'fb.pick.title' : 'fb.open.title'),
    cls: 'wide',
    content: (c) => {
      close = c;
      primary.addEventListener('click', () => {
        if (mode === 'new') close({ dir: st.path, name: nameInput.value.trim() });
        else activate(current());
      });
      const bar = h(
        'div',
        { class: 'fb-bar' },
        h('button', { type: 'button', class: 'btn icon-only', title: t('fb.up'), 'aria-label': t('fb.up'), onClick: () => st.parent !== null && st.parent !== undefined && go(st.parent) }, icon('up', 16)),
        pathInput,
        h('button', { type: 'button', class: 'btn', onClick: () => go(pathInput.value.trim()) }, t('fb.go')),
      );
      return h('div', { class: 'fb' }, placesEl, h('div', { class: 'fb-main' }, bar, list));
    },
    footExtra: h('div', { class: 'fb-foot grow' }, nameInput, h('span', { class: 'hint', text: t(mode === 'new' ? 'fb.hint.new' : 'fb.hint.open') })),
    buttons: [{ label: t('dlg.cancel'), value: null }, { node: primary }],
    initialFocus: () => (mode === 'new' ? nameInput : list),
    onKey: (e) => {
      const a = document.activeElement;
      if (a === pathInput || a === nameInput) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!st.entries.length) return true;
        st.selected = Math.max(0, Math.min(st.entries.length - 1, st.selected + (e.key === 'ArrowDown' ? 1 : -1)));
        paintList();
        updatePrimary();
        return true;
      }
      if (e.key === 'Enter' && current() && a?.tagName !== 'BUTTON') {
        e.preventDefault();
        activate(current());
        return true;
      }
      if (e.key === 'Backspace' && st.parent !== null && st.parent !== undefined) {
        e.preventDefault();
        go(st.parent);
        return true;
      }
      return false;
    },
  });
  go(start || S.file?.dir || S.boot.cwd);
  return promise;
}

// ===========================================================================
// Server events (file changes, shutdown)
// ===========================================================================
function showGone(key) {
  if ($('.gone')) return;
  document.body.append(h('div', { class: 'gone' }, h('div', {}, h('img', { src: 'logo.png', alt: '', width: 72, height: 72 }), h('p', { text: t(key) }))));
}

function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(S.token)}`);
  let failures = 0;
  es.onopen = () => {
    failures = 0;
    $('.gone')?.remove();
  };
  es.onmessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'bye') {
      es.close();
      showGone('msg.bye');
    } else if (m.type === 'file-changed' && S.file && m.path === S.file.path) {
      if (m.missing) S.banner = 'missing';
      else if (!isDirty()) {
        await reloadFile(true);
        return;
      } else S.banner = 'changed';
      renderBanner();
    }
  };
  es.onerror = () => {
    failures++;
    if (failures >= 3) showGone('msg.lost');
  };
}

// ===========================================================================
// Startup
// ===========================================================================
function setTheme(theme, persist = false) {
  S.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = S.theme;
  $('#btnLight').setAttribute('aria-pressed', String(S.theme === 'light'));
  $('#btnDark').setAttribute('aria-pressed', String(S.theme === 'dark'));
  if (persist) api('POST', '/api/settings', { theme: S.theme }).catch(() => {});
}

async function init() {
  const m = /token=([^&]+)/.exec(location.hash);
  if (m) {
    S.token = decodeURIComponent(m[1]);
    try {
      sessionStorage.setItem('arc1cm-token', S.token);
    } catch {}
    history.replaceState(null, '', location.pathname);
  } else {
    try {
      S.token = sessionStorage.getItem('arc1cm-token') || '';
    } catch {}
  }
  for (const el of $$('[data-icon]')) el.innerHTML = svg(el.dataset.icon, 20);

  try {
    S.boot = await api('GET', '/api/bootstrap');
    S.EN = await api('GET', '/api/locale?code=en');
  } catch {
    showGone('msg.lost');
    return;
  }
  S.L = S.EN;
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  setTheme(S.boot.settings.theme || (prefersLight ? 'light' : 'dark'));
  const lang =
    resolveLang(S.boot.settings.lang) ||
    [...(navigator.languages || []), navigator.language].map(resolveLang).find(Boolean) ||
    'en';
  await setLang(lang);

  $('#btnOpen').addEventListener('click', openFileFlow);
  $('#fileBox').addEventListener('click', openFileFlow);
  $('#btnNew').addEventListener('click', newFileFlow);
  $('#btnReload').addEventListener('click', () => reloadFile());
  $('#btnLang').addEventListener('click', openLanguage);
  $('#btnLight').addEventListener('click', () => setTheme('light', true));
  $('#btnDark').addEventListener('click', () => setTheme('dark', true));
  $('#btnAddConn').addEventListener('click', addConnection);
  $('#btnDup').addEventListener('click', duplicateConnection);
  $('#btnDel').addEventListener('click', deleteConnection);
  $('#btnSave').addEventListener('click', () => save());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!dialogDepth) save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  S.missing = S.boot.initial.missing;
  if (S.boot.initial.path) {
    const ok = await openPath(S.boot.initial.path, { skipConfirm: true });
    if (!ok) renderAll();
  } else renderAll();
  connectEvents();
  $('#app').removeAttribute('aria-busy');
}

init();
