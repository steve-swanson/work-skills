#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { runRequest } from '../lib/requests.mjs';

export async function runCli(args, { stdin = process.stdin, ...options } = {}) {
  if (args.length === 1 && args[0] === '--help') return { help: 'request.mjs discover|inspect|create|update|reply|resolve-thread|merge --input <JSON|absolute-file|->' };
  if (args.length !== 3 || args[1] !== '--input') throw new Error('Use <operation> --input <JSON|absolute-file|->.');
  let raw = '';
  if (args[2] === '-') { for await (const chunk of stdin) { raw += chunk; if (Buffer.byteLength(raw) > 1048576) throw new Error('Input exceeds 1 MiB.'); } }
  else raw = path.isAbsolute(args[2]) ? await readFile(args[2], 'utf8') : args[2];
  if (Buffer.byteLength(raw) > 1048576) throw new Error('Input exceeds 1 MiB.');
  return runRequest(args[0], JSON.parse(raw), options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Error messages from this module/adapters are fixed diagnostics, but CLI
    // failures must never echo JSON, remote bodies, auth headers, or secrets.
    process.stderr.write('Request operation failed. Check input, authentication, permissions, validation, and saved write journals before retrying.\n');
    process.exitCode = 2;
  }
}
