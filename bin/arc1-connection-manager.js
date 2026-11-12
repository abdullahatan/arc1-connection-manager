#!/usr/bin/env node
import { main } from '../src/cli.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`ARC-1 Connection Manager needs Node.js 22 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exit(1);
});
