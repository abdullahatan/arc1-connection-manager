// Command-line entry point.
import { openUi } from './open.js';

const HELP = `ARC-1 Connection Manager — manage ARC-1 (SAP ADT MCP) connections in .mcp.json

Usage:
  npx arc1-connection-manager [file] [options]

  file                 MCP configuration to open. Default: .mcp.json in the current
                       folder if there is one, otherwise the last file you used.

Options:
  --port <number>      Port for the local UI (default: a free random port)
  --no-open            Do not open a window; just print the address
  --browser <mode>     app     = chromeless Edge/Chrome window (default)
                       default = your default browser
  --keep-alive         Keep running after the window is closed
  --shortcut           Create a desktop / Start menu shortcut and exit
  -v, --version        Print the version
  -h, --help           Show this help

Used inside .mcp.json (written by the app when a password is kept in the
operating system's credential store):
  arc1-connection-manager run -- <command that starts ARC-1>
`;

export async function main(argv) {
  if (argv[0] === 'run') {
    const { run } = await import('./runner.js');
    process.exitCode = await run(argv.slice(1));
    return;
  }

  const opts = { open: true, browser: 'app', keepAlive: false, port: 0, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      return;
    }
    if (a === '-v' || a === '--version') {
      const { PKG } = await import('./server.js');
      process.stdout.write(`${PKG.version}\n`);
      return;
    }
    if (a === '--shortcut') {
      const { createShortcuts } = await import('./shortcut.js');
      const paths = createShortcuts();
      for (const p of paths) process.stdout.write(`Created ${p}\n`);
      if (!paths.length) process.stdout.write('No desktop folder found.\n');
      return;
    }
    if (a === '--no-open') opts.open = false;
    else if (a === '--keep-alive') opts.keepAlive = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--browser') opts.browser = argv[++i];
    else if (a.startsWith('--browser=')) opts.browser = a.slice(10);
    else if (a.startsWith('-')) {
      process.stderr.write(`Unknown option: ${a}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    } else opts.file = a;
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    process.stderr.write('--port must be a number between 0 and 65535\n');
    process.exitCode = 2;
    return;
  }

  const { startServer, PKG } = await import('./server.js');
  const srv = await startServer({
    port: opts.port,
    initialPath: opts.file,
    keepAlive: opts.keepAlive || !opts.open,
    log: (m) => process.stderr.write(`${m}\n`),
  });

  const out = (s) => process.stdout.write(`${s}\n`);
  out(`ARC-1 Connection Manager ${PKG.version}`);
  out(`Running at ${srv.url}`);
  if (opts.open) {
    const how = openUi(srv.url, opts.browser === 'default' ? 'default' : 'app');
    out(how === 'app' ? 'Opened in an app window. Close the window to stop.' : 'Opened in your browser. Close the tab to stop.');
  } else {
    out('Open the address above in a browser. Press Ctrl+C to stop.');
  }

  const stop = () => srv.close('signal');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const reason = await srv.closed;
  if (reason === 'window-closed') out('Window closed — stopped.');
  process.exit(0);
}
