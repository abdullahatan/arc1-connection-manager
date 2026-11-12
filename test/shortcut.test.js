import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildLnk } from '../src/shortcut.js';

const opts = {
  target: 'C:\\Windows\\System32\\cmd.exe',
  args: '/c npx -y arc1-connection-manager@latest',
  workingDir: 'C:\\Users\\Şükrü',
  icon: 'C:\\Users\\Şükrü\\AppData\\Roaming\\arc1-connection-manager\\app.ico',
  description: 'ARC-1 Connection Manager',
};

test('the .lnk header and strings follow MS-SHLLINK', () => {
  const b = buildLnk(opts);
  assert.equal(b.readUInt32LE(0), 0x4c);
  assert.equal(b.subarray(4, 20).toString('hex'), '0114020000000000c000000000000046');
  assert.equal(b.readUInt32LE(20), 0x01 | 0x02 | 0x04 | 0x10 | 0x20 | 0x40 | 0x80);
  assert.equal(b.readUInt32LE(60), 7);
  // target ID list: This PC, drive, Windows, System32, cmd.exe, terminator
  const idSize = b.readUInt16LE(76);
  const ids = [];
  for (let o = 78; o < 78 + idSize; ) {
    const n = b.readUInt16LE(o);
    if (n === 0) break;
    ids.push(b.subarray(o + 2, o + n));
    o += n;
  }
  assert.equal(ids.length, 5);
  assert.equal(ids[0][0], 0x1f);
  assert.equal(ids[1].toString('latin1', 1, 4), 'C:\\');
  assert.deepEqual(
    ids.slice(2).map((d) => [d[0], d.toString('latin1', 12).split('\0')[0]]),
    [[0x31, 'Windows'], [0x31, 'System32'], [0x32, 'cmd.exe']],
  );
  const infoStart = 78 + idSize;
  const infoSize = b.readUInt32LE(infoStart);
  const info = b.subarray(infoStart, infoStart + infoSize);
  assert.equal(info.toString('latin1', info.readUInt32LE(16)).split('\0')[0], opts.target);
  // string data: count (UTF-16 units) + text, in the documented order
  let off = infoStart + infoSize;
  for (const s of [opts.description, opts.workingDir, opts.args, opts.icon]) {
    const n = b.readUInt16LE(off);
    assert.equal(b.toString('utf16le', off + 2, off + 2 + n * 2), s);
    off += 2 + n * 2;
  }
  assert.equal(b.readUInt32LE(off), 0); // terminal block
  assert.equal(off + 4, b.length);
});

test('Windows reads the shortcut back', { skip: process.platform !== 'win32' }, () => {
  const p = join(mkdtempSync(join(tmpdir(), 'arc1cm-lnk-')), 'test.lnk');
  writeFileSync(p, buildLnk({ ...opts, workingDir: tmpdir(), icon: 'C:\\Windows\\System32\\shell32.dll' }));
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${p.replace(/'/g, "''")}'); "$($s.TargetPath)|$($s.Arguments)|$($s.WindowStyle)"`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [target, args, style] = r.stdout.trim().split('|');
  assert.equal(target.toLowerCase(), opts.target.toLowerCase());
  assert.equal(args, opts.args);
  assert.equal(style, '7');
});
