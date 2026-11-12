// `arc1-connection-manager run -- <command...>`
//
// Used inside .mcp.json when a connection keeps its password in the OS
// credential store. Claude Code starts this command with the connection's env
// block (SAP_URL, SAP_USER, ...); we add SAP_PASSWORD from the store and start
// ARC-1 with the same stdin/stdout/stderr. MCP traffic never passes through
// this process, and nothing is ever written to stdout (it belongs to MCP).
import { spawn } from 'node:child_process';
import { accountFor, getSecret } from './secrets.js';

const say = (msg) => process.stderr.write(`[arc1-connection-manager] ${msg}\n`);

/** Quote one argument for cmd.exe. */
export function quoteWin(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export async function run(argv) {
  const sep = argv.indexOf('--');
  const cmd = sep === -1 ? argv : argv.slice(sep + 1);
  if (cmd.length === 0) {
    say('Usage: arc1-connection-manager run -- <command that starts ARC-1>');
    return 2;
  }

  const env = { ...process.env };
  if (!env.SAP_PASSWORD) {
    const account = accountFor(env);
    if (!account) {
      say('SAP_URL and SAP_USER must be set to look up the stored password.');
      return 1;
    }
    let password;
    try {
      password = await getSecret(account);
    } catch (e) {
      say(`Could not read the operating system's credential store: ${e?.message || e}`);
      return 1;
    }
    if (!password) {
      say(`No password is stored for ${account}.`);
      say('Open the manager (npx arc1-connection-manager), enter the password for this connection and save.');
      return 1;
    }
    env.SAP_PASSWORD = password;
  }

  const child =
    process.platform === 'win32'
      ? spawn(cmd.map(quoteWin).join(' '), { shell: true, stdio: 'inherit', env, windowsHide: true })
      : spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env });

  const forward = (sig) => () => {
    if (child.exitCode === null) child.kill(sig);
  };
  const handlers = { SIGINT: forward('SIGINT'), SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP') };
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);

  return new Promise((resolve) => {
    child.on('error', (e) => {
      say(`Could not start "${cmd[0]}": ${e.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
