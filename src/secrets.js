// SAP passwords in the operating system's credential store:
// Windows Credential Manager, macOS Keychain, or the Secret Service on Linux
// (GNOME Keyring / KWallet). Backed by @napi-rs/keyring (prebuilt binaries, no compiler needed).
import { promises as fsp } from 'node:fs';

export const SERVICE = 'arc1-connection-manager';

/**
 * The credential-store entry a connection's password lives under. It is derived
 * from the connection itself, so the `run` wrapper can find it from the same
 * environment Claude Code passes to ARC-1, and connections to the same system
 * and user share one stored password.
 */
export function accountFor(env) {
  const user = String(env?.SAP_USER ?? '').trim().toUpperCase();
  const rawUrl = String(env?.SAP_URL ?? '').trim();
  if (!user || !rawUrl) return null;
  let url;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    url = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
  const client = String(env?.SAP_CLIENT ?? '').trim() || '100';
  return `${user}@${url}?client=${client}`;
}

export function storeName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

// Test-only backend: a JSON file instead of the OS store (used by the test suite / CI).
const TEST_FILE = process.env.ARC1CM_TEST_KEYRING_FILE;

async function testBackend() {
  const read = async () => {
    try {
      return JSON.parse(await fsp.readFile(TEST_FILE, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (data) => fsp.writeFile(TEST_FILE, JSON.stringify(data, null, 2));
  return {
    async get(account) {
      return (await read())[account] ?? null;
    },
    async set(account, value) {
      const d = await read();
      d[account] = value;
      await write(d);
    },
    async del(account) {
      const d = await read();
      const had = account in d;
      delete d[account];
      await write(d);
      return had;
    },
  };
}

let backendPromise;
function backend() {
  backendPromise ??= (async () => {
    if (TEST_FILE) return testBackend();
    const { AsyncEntry } = await import('@napi-rs/keyring');
    // Linux: require the Secret Service. Without this the binding silently falls back to the
    // kernel keyring, which lives in memory only and is wiped on reboot – the stored password
    // would vanish and ARC-1 would stop starting. Ignored on Windows and macOS.
    const options = process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined;
    const entry = (account) => new AsyncEntry(SERVICE, account, options);
    return {
      get: (account) => entry(account).getPassword(),
      set: (account, value) => entry(account).setPassword(value),
      del: (account) => entry(account).deletePassword(),
    };
  })();
  return backendPromise;
}

let infoPromise;
/** { available, store, reason? } — probes the store once per process. */
export function storeInfo() {
  infoPromise ??= (async () => {
    const store = storeName();
    try {
      const b = await backend();
      await b.get('__probe__');
      return { available: true, store };
    } catch (e) {
      return { available: false, store, reason: String(e?.message || e) };
    }
  })();
  return infoPromise;
}

export async function getSecret(account) {
  return (await backend()).get(account);
}

export async function setSecret(account, value) {
  if (typeof value !== 'string' || value === '') throw new Error('Empty password.');
  await (await backend()).set(account, value);
}

export async function deleteSecret(account) {
  return (await backend()).del(account);
}
