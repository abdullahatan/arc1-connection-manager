// Per-user locations: app settings, well-known folders and MCP configuration files.
import { existsSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

export function configDir() {
  const home = homedir();
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'arc1-connection-manager');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'arc1-connection-manager');
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'arc1-connection-manager');
}

/** Claude Desktop's config file (also uses "mcpServers"). */
export function claudeDesktopConfig() {
  const home = homedir();
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** Quick-access places for the file browser. Only existing ones are returned. */
export function places(cwd) {
  const home = homedir();
  const list = [
    { id: 'cwd', path: cwd },
    { id: 'home', path: home },
    { id: 'desktop', path: join(home, 'Desktop') },
    { id: 'documents', path: join(home, 'Documents') },
    { id: 'workspace', path: join(home, 'eclipse-workspace') },
    { id: 'claude', path: claudeDesktopConfig(), file: true },
  ];
  const seen = new Set();
  return list.filter((p) => {
    if (!p.path || seen.has(p.path) || !existsSync(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

const MCP_NAMES = new Set(['.mcp.json', 'mcp.json', 'claude_desktop_config.json', 'cline_mcp_settings.json', 'mcp_config.json']);

/** Windows drive letters that exist (C:\ ...). */
async function drives() {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (l) => {
      try {
        await fsp.access(`${l}:\\`);
        return `${l}:\\`;
      } catch {
        return null;
      }
    }),
  );
  return found.filter(Boolean);
}

/**
 * List folders and JSON files. An empty path on Windows lists the drives.
 * @returns {Promise<{path: string, parent: string|null, entries: Array<{name: string, dir: boolean, mcp?: boolean}>}>}
 */
export async function listDir(path) {
  if (!path && process.platform === 'win32') {
    return { path: '', parent: null, entries: (await drives()).map((d) => ({ name: d, dir: true, drive: true })) };
  }
  const p = resolve(path || homedir());
  const items = await fsp.readdir(p, { withFileTypes: true });
  const entries = [];
  for (const it of items) {
    let dir = it.isDirectory();
    if (it.isSymbolicLink()) {
      try {
        dir = (await fsp.stat(join(p, it.name))).isDirectory();
      } catch {
        continue;
      }
    }
    if (dir) entries.push({ name: it.name, dir: true });
    else if (/\.json$/i.test(it.name)) entries.push({ name: it.name, dir: false, mcp: MCP_NAMES.has(it.name.toLowerCase()) });
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (!a.dir && a.mcp !== b.mcp) return a.mcp ? -1 : 1;
    const ah = a.name.startsWith('.');
    const bh = b.name.startsWith('.');
    if (a.dir && ah !== bh) return ah ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  const root = parse(p).root;
  let parent = p === root ? null : dirname(p);
  if (parent === null && process.platform === 'win32') parent = '';
  return { path: p, parent, entries };
}
