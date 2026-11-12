// Desktop / Start menu shortcut that starts the app with `npx`.
// Windows: a .lnk written directly (MS-SHLLINK), no PowerShell or COM needed.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './paths.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_NAME = 'ARC-1 Connection Manager';
const LAUNCH_SPEC = 'arc1-connection-manager@latest';

/** GUID string → 16 bytes in Windows (mixed-endian) layout. */
function guidBytes(guid) {
  const h = guid.replace(/[{}-]/g, '');
  const le = (hex) => Buffer.from(hex, 'hex').reverse();
  return Buffer.concat([le(h.slice(0, 8)), le(h.slice(8, 12)), le(h.slice(12, 16)), Buffer.from(h.slice(16), 'hex')]);
}

/**
 * LinkTargetIDList for a local path: This PC → drive → one file-entry shell item per
 * path component (0x31 folder, 0x32 file). Explorer resolves the target from this list.
 */
export function targetIdList(target) {
  const m = /^([A-Za-z]:\\)(.*)$/.exec(target);
  if (!m) throw new Error(`Not a local Windows path: ${target}`);
  const items = [Buffer.concat([Buffer.from([0x1f, 0x50]), guidBytes('20D04FE0-3AEA-1069-A2D8-08002B30309D')])];
  const drive = Buffer.alloc(23);
  drive[0] = 0x2f;
  drive.write(m[1], 1, 'latin1');
  items.push(drive);
  const parts = m[2].split('\\').filter(Boolean);
  parts.forEach((name, i) => {
    const isFile = i === parts.length - 1;
    const head = Buffer.alloc(12);
    head[0] = isFile ? 0x32 : 0x31;
    head.writeUInt16LE(isFile ? 0x20 : 0x10, 10); // FILE_ATTRIBUTE_ARCHIVE / _DIRECTORY
    let name8 = Buffer.from(`${name}\0`, 'latin1');
    if (name8.length % 2) name8 = Buffer.concat([name8, Buffer.alloc(1)]);
    items.push(Buffer.concat([head, name8]));
  });
  const encoded = items.map((data) => {
    const b = Buffer.alloc(2 + data.length);
    b.writeUInt16LE(b.length, 0);
    data.copy(b, 2);
    return b;
  });
  const list = Buffer.concat([...encoded, Buffer.alloc(2)]);
  const out = Buffer.alloc(2 + list.length);
  out.writeUInt16LE(list.length, 0);
  list.copy(out, 2);
  return out;
}

/**
 * Build a Windows shell link: target ID list + LinkInfo (local base path) + name,
 * working directory, arguments and icon location.
 */
export function buildLnk({ target, args = '', workingDir = '', icon = '', description = '', showCommand = 7 }) {
  const str = (s) => {
    const b = Buffer.alloc(2 + s.length * 2);
    b.writeUInt16LE(s.length, 0);
    b.write(s, 2, 'utf16le');
    return b;
  };
  const HAS_TARGET_ID_LIST = 0x01;
  const HAS_LINK_INFO = 0x02;
  const HAS_NAME = 0x04;
  const HAS_WORKING_DIR = 0x10;
  const HAS_ARGUMENTS = 0x20;
  const HAS_ICON_LOCATION = 0x40;
  const IS_UNICODE = 0x80;
  const flags =
    HAS_TARGET_ID_LIST | HAS_LINK_INFO | HAS_NAME | HAS_WORKING_DIR | HAS_ARGUMENTS | HAS_ICON_LOCATION | IS_UNICODE;

  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(header, 4); // CLSID 00021401-0000-0000-C000-000000000046
  header.writeUInt32LE(flags, 20);
  header.writeUInt32LE(0x20, 24); // FILE_ATTRIBUTE_ARCHIVE
  header.writeUInt32LE(showCommand, 60); // 1 normal, 3 maximized, 7 minimized (no activate)

  const base = Buffer.from(`${target}\0`, 'latin1');
  const label = Buffer.from('\0', 'latin1');
  const volume = Buffer.alloc(16 + label.length);
  volume.writeUInt32LE(volume.length, 0);
  volume.writeUInt32LE(3, 4); // DRIVE_FIXED
  volume.writeUInt32LE(0, 8);
  volume.writeUInt32LE(0x10, 12);
  label.copy(volume, 16);
  const suffix = Buffer.from('\0', 'latin1');
  const headerSize = 0x1c;
  const volOff = headerSize;
  const baseOff = volOff + volume.length;
  const sufOff = baseOff + base.length;
  const info = Buffer.alloc(sufOff + suffix.length);
  info.writeUInt32LE(info.length, 0);
  info.writeUInt32LE(headerSize, 4);
  info.writeUInt32LE(0x1, 8); // VolumeIDAndLocalBasePath
  info.writeUInt32LE(volOff, 12);
  info.writeUInt32LE(baseOff, 16);
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(sufOff, 24);
  volume.copy(info, volOff);
  base.copy(info, baseOff);
  suffix.copy(info, sufOff);

  return Buffer.concat([header, targetIdList(target), info, str(description), str(workingDir), str(args), str(icon), Buffer.alloc(4)]);
}

function windowsDesktop() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = /Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out);
    if (m) {
      const p = m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
      if (existsSync(p)) return p;
    }
  } catch {
    // fall through
  }
  return join(process.env.USERPROFILE || homedir(), 'Desktop');
}

/** Create the shortcuts for this platform. Returns the paths written. */
export function createShortcuts() {
  const written = [];
  const dir = configDir();
  mkdirSync(dir, { recursive: true });

  if (process.platform === 'win32') {
    const icon = join(dir, 'app.ico');
    copyFileSync(join(ROOT, 'public', 'app.ico'), icon);
    const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const data = buildLnk({
      target: cmd,
      args: `/c npx -y ${LAUNCH_SPEC}`,
      workingDir: process.env.USERPROFILE || homedir(),
      icon,
      description: APP_NAME,
      showCommand: 7,
    });
    const startMenu = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    for (const folder of [windowsDesktop(), startMenu]) {
      if (!existsSync(folder)) continue;
      const p = join(folder, `${APP_NAME}.lnk`);
      writeFileSync(p, data);
      written.push(p);
    }
    return written;
  }

  if (process.platform === 'darwin') {
    const p = join(homedir(), 'Desktop', `${APP_NAME}.command`);
    writeFileSync(p, `#!/bin/sh\n# ${APP_NAME}\nexec npx -y ${LAUNCH_SPEC}\n`);
    chmodSync(p, 0o755);
    written.push(p);
    return written;
  }

  const icon = join(dir, 'app.png');
  copyFileSync(join(ROOT, 'public', 'app.png'), icon);
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Manage ARC-1 (SAP ADT MCP) connections in .mcp.json',
    `Exec=sh -c "npx -y ${LAUNCH_SPEC}"`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;',
    '',
  ].join('\n');
  const apps = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
  mkdirSync(apps, { recursive: true });
  for (const p of [join(apps, 'arc1-connection-manager.desktop'), join(homedir(), 'Desktop', 'arc1-connection-manager.desktop')]) {
    if (!existsSync(dirname(p))) continue;
    writeFileSync(p, desktopEntry);
    chmodSync(p, 0o755);
    written.push(p);
  }
  return written;
}
