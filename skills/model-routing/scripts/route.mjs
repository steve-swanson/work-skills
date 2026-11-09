#!/usr/bin/env node
// JSON in, sanitized routing decision out. No agent dispatch or review database.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { routeTask, validateRoute, sanitizeRoute } from '../lib/routing.mjs';

export async function runCli(args, { stdin = process.stdin } = {}) {
  if (args.length === 1 && args[0] === '--help') return { help: 'node route.mjs [--validate] --input <JSON|absolute-file|->' };
  const validate = args[0] === '--validate';
  const rest = validate ? args.slice(1) : args;
  if (rest.length !== 2 || rest[0] !== '--input') throw new Error('Use [--validate] --input <JSON|absolute-file|->.');
  const value = rest[1];
  let raw;
  if (value === '-') { raw = ''; for await (const chunk of stdin) { raw += chunk; if (Buffer.byteLength(raw) > 1048576) throw new Error('Routing input exceeds 1 MiB.'); } }
  else if (path.isAbsolute(value)) raw = await readFile(value, 'utf8');
  else raw = value;
  if (Buffer.byteLength(raw) > 1048576) throw new Error('Routing input exceeds 1 MiB.');
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('Routing input must be valid JSON; contents were not echoed.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Routing input must be an object.');
  return sanitizeRoute(validate ? validateRoute(input) : await routeTask(input), input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`); }
  catch { process.stderr.write('Routing command failed; check input, dependency installation, and configured adapter. Input and credentials were not echoed.\n'); process.exitCode = 1; }
}
