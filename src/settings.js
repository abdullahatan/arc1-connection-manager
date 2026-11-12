// App preferences (theme, language, recent files) in the per-user config folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.js';

const FILE = () => join(configDir(), 'settings.json');
const DEFAULTS = { theme: null, lang: null, recent: [], lastConnection: null };
const MAX_RECENT = 8;

export function loadSettings() {
  try {
    const data = JSON.parse(readFileSync(FILE(), 'utf8'));
    return { ...DEFAULTS, ...data, recent: Array.isArray(data.recent) ? data.recent.filter((p) => typeof p === 'string') : [] };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  next.recent = (next.recent || []).slice(0, MAX_RECENT);
  try {
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(FILE(), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Preferences are a convenience; never fail an operation because of them.
  }
  return next;
}

export function rememberFile(path) {
  const s = loadSettings();
  const recent = [path, ...s.recent.filter((p) => p !== path)];
  return saveSettings({ recent });
}
