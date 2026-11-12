// "Check with ARC-1": let ARC-1 itself resolve the connection's configuration
// (`arc1-cli config show --format json`). Whatever would stop ARC-1 from starting
// is reported with ARC-1's own message, using the ARC-1 version the connection runs.
import { spawn } from 'node:child_process';
import { arc1Spec } from './mcpfile.js';
import { quoteWin } from './runner.js';

function npx(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn(['npx', ...args].map(quoteWin).join(' '), { shell: true, cwd, env, windowsHide: true })
        : spawn('npx', args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message, spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const tail = (text, lines = 25) =>
  text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^npm (warn|notice)/i.test(l))
    .slice(-lines)
    .join('\n');

/**
 * @param {{ env: Record<string,string>, inner: string[], cwd?: string, timeoutMs?: number }} opts
 */
export async function validateWithArc1({ env, inner, cwd, timeoutMs = 180000 }) {
  const spec = arc1Spec(inner || []) || 'arc-1';
  const childEnv = { ...process.env, ...env, npm_config_yes: 'true' };
  delete childEnv.SAP_PASSWORD; // not needed to resolve the configuration
  const base = ['-y', '-p', spec, 'arc1-cli'];
  const opts = { cwd, env: childEnv, timeoutMs };

  const ver = await npx([...base, 'version'], opts);
  if (ver.spawnError) return { ok: false, kind: 'nonpx', message: ver.stderr };
  if (ver.timedOut) return { ok: false, kind: 'timeout', spec };
  const version = /ARC-1 v?([\w.\-+]+)/.exec(ver.stdout)?.[1] || null;
  if (ver.code !== 0 && !version) {
    // `version` itself never fails on a good install, so this is an npx/npm/ARC-1 startup error.
    return { ok: false, kind: 'error', spec, message: tail(`${ver.stderr}\n${ver.stdout}`) };
  }

  const res = await npx([...base, 'config', 'show', '--format', 'json'], opts);
  if (res.timedOut) return { ok: false, kind: 'timeout', spec, version };
  if (res.code === 0) {
    try {
      const json = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
      return { ok: true, spec, version, policy: json.effectivePolicy, warnings: tail(res.stderr, 10) };
    } catch {
      return { ok: false, kind: 'error', spec, version, message: tail(res.stdout) };
    }
  }
  return { ok: false, kind: 'rejected', spec, version, message: tail(`${res.stderr}\n${res.stdout}`) };
}
