// Uses the real OS credential store (no test backend): Windows Credential Manager,
// macOS Keychain or the Secret Service. Opt-in, because it writes (and removes) a
// throwaway entry in your own store: ARC1CM_REAL_KEYRING=1 node --test test/keyring-real.test.js
// CI runs it on all three platforms.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const enabled = process.env.ARC1CM_REAL_KEYRING === '1' && !process.env.ARC1CM_TEST_KEYRING_FILE;
const BIN = fileURLToPath(new URL('../bin/arc1-connection-manager.js', import.meta.url));

test('the real credential store saves, reads and deletes a password', { skip: !enabled }, async () => {
  const { accountFor, deleteSecret, getSecret, setSecret, storeInfo } = await import('../src/secrets.js');
  const info = await storeInfo();
  assert.equal(info.available, true, info.reason);
  const user = `CI${randomBytes(4).toString('hex')}`;
  const env = { SAP_URL: 'https://ci.example.com:44300', SAP_USER: user, SAP_CLIENT: '100' };
  const account = accountFor(env);
  try {
    await setSecret(account, 'Ş3cret!');
    assert.equal(await getSecret(account), 'Ş3cret!');

    // the run wrapper finds it, exactly as Claude Code would start it
    const fake = join(mkdtempSync(join(tmpdir(), 'arc1cm-real-')), 'fake.cjs');
    writeFileSync(fake, "process.stdout.write(process.env.SAP_PASSWORD === 'Ş3cret!' ? 'match' : 'mismatch');");
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SAP|ARC1)_/.test(k)));
    const r = spawnSync(process.execPath, [BIN, 'run', '--', process.execPath, fake], { encoding: 'utf8', env: { ...clean, ...env } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'match');
  } finally {
    await deleteSecret(account).catch(() => {});
  }
  assert.equal(await getSecret(account), null);
});
