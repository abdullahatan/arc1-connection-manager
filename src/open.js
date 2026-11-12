// Open the UI: preferably as a chromeless app window (Edge / Chrome --app),
// otherwise in the default browser.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

function onPath(names) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function appBrowser() {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
        const p = join(r, rel);
        if (existsSync(p)) return { cmd: p };
      }
    }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']) {
      for (const base of ['/Applications', join(homedir(), 'Applications')]) {
        if (existsSync(join(base, `${app}.app`))) return { mac: app };
      }
    }
    return null;
  }
  const p = onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']);
  return p ? { cmd: p } : null;
}

function detached(cmd, args, verbatim = false) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim });
  child.on('error', () => {});
  child.unref();
}

/** @param {string} url  @param {'app'|'default'} mode */
export function openUi(url, mode = 'app') {
  const app = mode === 'app' ? appBrowser() : null;
  if (app?.cmd) {
    detached(app.cmd, [`--app=${url}`, '--window-size=1320,880']);
    return 'app';
  }
  if (app?.mac) {
    detached('open', ['-na', app.mac, '--args', `--app=${url}`, '--window-size=1320,880']);
    return 'app';
  }
  if (process.platform === 'win32') detached('cmd', ['/d', '/c', 'start', '""', `"${url}"`], true);
  else if (process.platform === 'darwin') detached('open', [url]);
  else detached('xdg-open', [url]);
  return 'browser';
}
