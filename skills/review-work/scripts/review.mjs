#!/usr/bin/env node
/** Installed entrypoint. Existing reviews always execute their immutable pinned runtime. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function resolvePinnedRuntime(reviewDir) {
  const directory = fs.realpathSync(path.resolve(reviewDir));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')); }
  catch { throw new Error('Cannot read the review manifest; preserve the review directory and repair its manifest.'); }
  const runtime = manifest.runtime;
  if (!runtime || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/.test(runtime.version ?? '') || !/^[a-f0-9]{64}$/.test(runtime.digest ?? '') || !path.isAbsolute(runtime.directory ?? '')) {
    throw new Error('Review manifest does not identify a valid pinned runtime.');
  }
  const stateRoot = path.dirname(path.dirname(path.dirname(directory)));
  const expected = path.join(stateRoot, '_runtime', `${runtime.version}-${runtime.digest.slice(0, 16)}`);
  const resolved = fs.realpathSync(runtime.directory);
  if (resolved !== path.resolve(expected) || fs.lstatSync(runtime.directory).isSymbolicLink()) throw new Error('Pinned runtime must be the review state root versioned runtime directory.');
  const contents = [];
  function visit(root, prefix = '') {
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Pinned runtime contains a symbolic link; preserve it for repair.');
      if (entry.isDirectory()) visit(root, relative);
      else if (entry.isFile()) contents.push(Buffer.from(`${relative}\0`), fs.readFileSync(path.join(root, relative)));
      else throw new Error('Pinned runtime contains an unsupported file type.');
    }
  }
  visit(resolved);
  if (crypto.createHash('sha256').update(Buffer.concat(contents)).digest('hex') !== runtime.digest) throw new Error('Pinned runtime digest changed; preserve the review and repair its modified runtime.');
  const cli = path.join(resolved, 'cli.mjs');
  if (!fs.existsSync(cli)) throw new Error('Pinned runtime has no owner CLI.');
  return cli;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const index = argv.indexOf('--review');
    const existingReview = index >= 0 ? argv[index + 1] : null;
    if (index >= 0 && (!existingReview || existingReview.startsWith('--'))) throw new Error('--review requires a directory.');
    const filename = existingReview
      ? resolvePinnedRuntime(existingReview)
      : fileURLToPath(new URL('../assets/runtime/cli.mjs', import.meta.url));
    const runtime = await import(pathToFileURL(filename).href);
    await runtime.main(argv);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: 'runtime_error', message: error.message } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
