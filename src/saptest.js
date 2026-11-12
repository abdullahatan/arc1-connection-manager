// "Test Connection": sign in to the ADT discovery service the same way ARC-1 does
// (sap-client / sap-language, optional SAML opt-out, optional TLS skip).
import http from 'node:http';
import https from 'node:https';

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
]);

/**
 * @returns {Promise<{kind: string, status?: number, detail?: string, location?: string}>}
 *   kind: ok | 401 | 403 | 404 | redirect | other | ssl | notfound | refused | timeout | badurl | fail
 */
export function testConnection({ url, user, password, client, language, insecure, disableSaml, timeoutMs = 15000 }) {
  let base;
  try {
    base = new URL(String(url || '').trim());
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('protocol');
  } catch {
    return Promise.resolve({ kind: 'badurl' });
  }
  const target = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/sap/bc/adt/discovery`);
  target.searchParams.set('sap-client', String(client || '').trim() || '100');
  target.searchParams.set('sap-language', String(language || '').trim() || 'EN');
  const headers = {
    Accept: 'application/atomsvc+xml',
    'User-Agent': 'arc1-connection-manager',
    'sap-client': target.searchParams.get('sap-client'),
  };
  if (disableSaml) {
    target.searchParams.set('saml2', 'disabled');
    headers['X-SAP-SAML2'] = 'disabled';
  }
  if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:${password ?? ''}`, 'utf8').toString('base64')}`;

  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = lib.request(
      target,
      { method: 'GET', headers, timeout: timeoutMs, rejectUnauthorized: !insecure },
      (res) => {
        res.resume();
        const status = res.statusCode;
        if (status >= 200 && status < 300) return done({ kind: 'ok', status });
        if (status === 401 || status === 403 || status === 404) return done({ kind: String(status), status });
        if (status >= 300 && status < 400) return done({ kind: 'redirect', status, location: res.headers.location });
        return done({ kind: 'other', status });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ kind: 'timeout' });
    });
    req.on('error', (e) => {
      const code = e.code || '';
      if (TLS_CODES.has(code) || /certificate|SSL|TLS/i.test(e.message)) return done({ kind: 'ssl', detail: e.message });
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return done({ kind: 'notfound', detail: target.hostname });
      if (code === 'ECONNREFUSED') return done({ kind: 'refused', detail: target.host });
      if (code === 'ETIMEDOUT') return done({ kind: 'timeout' });
      done({ kind: 'fail', detail: e.message });
    });
    req.end();
  });
}
