#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createReview, createMirror, listReviews, readManifest, ReviewStore, fail, frameRelay, unframeRelay, RELAY_MAX_CHARS } from './store.mjs';
import { startServer, readThreadTexts } from './server.mjs';
import { routeTask, sanitizeRoute } from './routing.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const MAX_INPUT = 1024 * 1024;
const COMMANDS = {
  init: ['--input', '--home'], list: ['--home', '--conversation'],
  state: ['--review'], resume: ['--review'], findings: ['--review', '--input'],
  record: ['--review', '--kind', '--input'], resolve: ['--review', '--id', '--input'],
  'task-reserve': ['--review', '--input'], 'task-update': ['--review', '--id', '--input'],
  route: ['--review', '--input'], readiness: ['--review'], close: ['--review'], reopen: ['--review'],
  start: ['--review'], serve: ['--review'], stop: ['--review'], export: ['--review', '--output'],
  'import-artifact': ['--review', '--source', '--output'],
  'page-bundle': ['--review', '--environment'], 'page-init': ['--input', '--home'],
  'relay-export': ['--review', '--batch'], 'relay-import': ['--review', '--input'],
};

const HELP = `review-work owner CLI (Node 24+)
  init --input JSON_OR_FILE_OR_- [--home PATH]
  list [--home PATH] [--conversation ID]
  state|resume|readiness|close|reopen|start|serve|stop --review DIRECTORY
  findings --review DIRECTORY --input JSON_ARRAY_OR_FILE_OR_-
  record --review DIRECTORY --kind KIND --input JSON_OBJECT_OR_FILE_OR_-
  resolve|task-update --review DIRECTORY --id ID --input JSON_OBJECT_OR_FILE_OR_-
  task-reserve --review DIRECTORY --input JSON_OBJECT_OR_FILE_OR_-
  route [--review DIRECTORY] --input JSON_OBJECT_OR_FILE_OR_-
  export --review DIRECTORY [--output RELATIVE_ARTIFACT_PATH]
  import-artifact --review DIRECTORY --source FILE [--output RELATIVE_ARTIFACT_PATH]
  page-bundle --review DIRECTORY --environment THIS_T3_ENVIRONMENT_ID   (review machine: print the page bundle)
  page-init --input JSON_OR_FILE_OR_- [--home PATH]                    (page machine: make the page-only copy)
  relay-export --review PAGE_COPY_DIRECTORY --batch BATCH_ID           (page machine: print submitted choices)
  relay-import --review DIRECTORY [--input FILE]                       (review machine: apply relayed choices)
JSON may be a literal, a filename, @filename, or - for stdin. Prefer files/stdin for credential configuration.
Existing reviews use the runtime pinned in manifest.json. Exports never write into the reviewed repository.
`;

function parse(argv) {
  if (!argv.length || argv.includes('--help')) return { command: 'help', options: {} };
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command)) fail('invalid_command', 'Unknown owner CLI command. Use --help.');
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (!COMMANDS[command].includes(key) || Object.hasOwn(options, key)) fail('invalid_option', `Unknown or duplicate option for ${command}. Use --help.`);
    const value = rest[++index];
    if (!value || value.startsWith('--')) fail('invalid_option', `${key} requires a value.`);
    options[key] = value;
  }
  if (!['init', 'list', 'route', 'page-init'].includes(command) && !options['--review']) fail('missing_review', '--review DIRECTORY is required.');
  return { command, options };
}

async function jsonInput(value, array = false) {
  if (typeof value !== 'string' || !value) fail('missing_input', '--input JSON, filename, or - is required.');
  let raw;
  if (value === '-') {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT) fail('input_too_large', 'JSON input exceeds 1 MiB.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else if (/^\s*[\[{]/.test(value)) raw = value;
  else {
    const filename = value.startsWith('@') ? value.slice(1) : value;
    const info = fs.statSync(filename);
    if (!info.isFile() || info.size > MAX_INPUT) fail('invalid_input', 'Input must be a JSON file of at most 1 MiB.');
    raw = fs.readFileSync(filename, 'utf8');
  }
  if (Buffer.byteLength(raw) > MAX_INPUT) fail('input_too_large', 'JSON input exceeds 1 MiB.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('invalid_json', 'Input is not valid JSON. Input contents are not echoed.'); }
  if (array ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_input', array ? 'Input must be an array.' : 'Input must be an object.');
  return parsed;
}

function withStore(directory, fn) {
  const store = new ReviewStore(directory);
  try { return fn(store); } finally { store.close(); }
}

export function handoff(manifest) {
  if (manifest.deliveryMode === 't3') return {
    mode: 't3', automatic: true, conversationId: manifest.conversationId,
    instructions: 'Submit saves decisions and automatically notifies the original T3 conversation. If notification fails, return to that conversation and type "resume the review"; the saved decisions remain available.',
  };
  return {
    mode: 'terminal', automatic: false,
    steps: [
      'Open the review page.',
      'Pick a choice for each finding, add notes if you want, and click Submit.',
      'Return to this conversation and type "resume the review".',
    ],
  };
}

function reviewDirectory(value) {
  const directory = fs.realpathSync(path.resolve(value));
  readManifest(directory);
  return directory;
}

function metadata(directory) {
  const filename = path.join(directory, 'server.json');
  if (!fs.existsSync(filename)) return null;
  let info;
  try { info = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { fail('invalid_service_metadata', 'The saved service metadata is unreadable. Inspect it before restarting.'); }
  const manifest = readManifest(directory);
  let parsed;
  try { parsed = new URL(info.url); } catch { fail('invalid_service_metadata', 'Saved service URL is invalid.'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || !Number.isSafeInteger(info.pid) || info.pid < 1 || typeof info.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(info.nonce)
      || info.reviewId !== manifest.id) fail('service_identity_mismatch', 'Saved service identity does not match this review or a loopback service.');
  return info;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function verifyService(directory) {
  const info = metadata(directory);
  if (!info) {
    const lock = path.join(directory, 'service.lock');
    if (fs.existsSync(lock)) {
      let owner; try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { fail('invalid_service_metadata', 'Unreadable service lock; inspect it before restarting.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || pidAlive(owner.pid)) fail('service_identity_unverified', 'A live or invalid service lock has no verifiable health identity. No process was signaled.');
    }
    return null;
  }
  let response;
  try {
    response = await fetch(`${new URL(info.url).origin}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch {
    if (!pidAlive(info.pid)) return null;
    fail('service_identity_unverified', 'Service health identity cannot be verified. No process was reused or signaled.');
  }
  let health;
  try {
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) throw new Error();
    const raw = await response.text();
    if (raw.length > 4096) throw new Error();
    health = JSON.parse(raw);
  } catch { fail('service_identity_mismatch', 'Service health response does not match the expected identity. No process was signaled.'); }
  if (health.reviewId !== info.reviewId || health.pid !== info.pid || health.nonce !== info.nonce) fail('service_identity_mismatch', 'Service health identity does not match this review, PID, and service nonce. No process was reused or signaled.');
  const current = metadata(directory);
  if (!current || current.pid !== info.pid || current.nonce !== info.nonce || current.url !== info.url) fail('service_changed', 'Service identity changed during verification. Retry without signaling a process.');
  return info;
}

function serviceResult(status, directory, info) {
  const manifest = readManifest(directory);
  return { status, reviewDir: directory, reviewId: manifest.id, host: manifest.host ?? os.hostname(), pageUrl: info.url, pid: info.pid, handoff: handoff(manifest) };
}

/** Every exported/imported artifact stays below the review's existing artifacts directory. */
function artifactPath(directory, name, { existing = false } = {}) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || /[\x00-\x1f<>:"|?*]/.test(p))) fail('invalid_artifact_path', 'Artifact output must be a safe relative path inside artifacts.');
  const root = path.join(directory, 'artifacts');
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) fail('invalid_artifact_path', 'Artifacts must be a real directory, not a symlink.');
  let cursor = root;
  const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    let info; try { info = fs.lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) fail('invalid_artifact_path', 'Artifact paths cannot pass through a symbolic link.');
    if (index < parts.length - 1 && info && !info.isDirectory()) fail('invalid_artifact_path', 'Artifact parent is not a directory.');
    if (index === parts.length - 1 && info && !existing) fail('artifact_exists', 'Artifact output already exists; choose a new name instead of overwriting.');
  }
  return cursor;
}

export async function startService(directory) {
  const previous = await verifyService(directory);
  if (previous) return serviceResult('reused', directory, previous);
  const log = artifactPath(directory, 'service.log', { existing: true });
  const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  let child;
  try { child = fork(THIS_FILE, ['serve', '--review', directory], { detached: true, stdio: ['ignore', fd, fd, 'ipc'], windowsHide: true, execArgv: [] }); }
  finally { fs.closeSync(fd); }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Review service did not report ready within 10 seconds. Inspect artifacts/service.log.')), 10000);
      const onMessage = value => {
        if (value?.type === 'ready') finish();
        else if (value?.type === 'startup-error') finish(new Error(value.message ?? 'Review service startup failed. Inspect artifacts/service.log.'));
      };
      const onExit = () => finish(new Error('Review service exited before readiness. Inspect artifacts/service.log.'));
      const onError = () => finish(new Error('Could not start the review service. Inspect artifacts/service.log.'));
      function finish(error) {
        clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
        error ? reject(error) : resolve();
      }
      child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
    });
    const info = await verifyService(directory);
    if (!info || info.pid !== child.pid) fail('service_identity_mismatch', 'Started service identity does not match the spawned process.');
    return serviceResult('started', directory, info);
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

export async function stopService(directory) {
  const info = await verifyService(directory);
  if (!info) return { status: 'not_running', reviewDir: directory, reviewPreserved: true };
  // Windows SIGTERM forcibly terminates Node. Use the same graceful protocol on
  // every host, after matching this review, PID, and service instance.
  const page = await fetch(info.url, {signal:AbortSignal.timeout(2000),redirect:'error'});
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  await page.body?.cancel();
  if (!page.ok || !cookie) fail('shutdown_unavailable', 'Cannot establish this review service session; no process was signaled.');
  const shutdown = await fetch(`${new URL(info.url).origin}/api/shutdown`, {
    method:'POST',signal:AbortSignal.timeout(3000),redirect:'error',
    headers:{Cookie:cookie,Origin:new URL(info.url).origin,'Content-Type':'application/json',Connection:'close'},
    body:JSON.stringify({reviewId:info.reviewId,pid:info.pid,nonce:info.nonce}),
  });
  await shutdown.body?.cancel();
  if (!shutdown.ok) fail('shutdown_unavailable', 'The verified service rejected graceful shutdown; no process was signaled.');
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = metadata(directory);
    if (!current || current.nonce !== info.nonce || !pidAlive(info.pid)) return { status: 'stopped', reviewDir: directory, reviewPreserved: true };
    await delay(50);
  }
  fail('stop_pending', 'The verified service was asked to stop, but shutdown is still pending. Saved review data remains intact; retry stop after checking its log.');
}

async function serve(directory) {
  const service = await startServer({ reviewDir: directory });
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await service.close();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    if (process.connected) process.disconnect();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  const info = metadata(directory);
  const result = serviceResult('serving', directory, info);
  if (process.send) process.send({ type: 'ready', reviewId: info.reviewId, pid: process.pid, nonce: info.nonce });
  return result;
}

export async function runCli(argv) {
  const { command, options } = parse(argv);
  if (command === 'help') return { help: HELP };
  if (command === 'init') {
    const input = await jsonInput(options['--input']);
    if (options['--home']) input.home = options['--home'];
    // CLI-created reviews always pin the complete runtime shipping this entrypoint.
    input.runtimeSource = path.dirname(THIS_FILE);
    const result = createReview(input);
    return { ...result, handoff: handoff(result.manifest) };
  }
  if (command === 'page-init') {
    const input = await jsonInput(options['--input']);
    if (options['--home']) input.home = options['--home'];
    const texts = input.bundleFile ? [fs.readFileSync(path.resolve(input.bundleFile), 'utf8')] : readThreadTexts(input, input.conversationId);
    const bundle = unframeRelay('page', texts);
    if (!bundle) fail('no_bundle', 'No REVIEW-WORK-PAGE bundle was found in this thread.');
    const result = createMirror({ ...input, bundle, runtimeSource: path.dirname(THIS_FILE) });
    return { reviewDir: result.reviewDir, reviewId: result.manifest.id, source: result.manifest.mirror, findings: bundle.findings.length, next: 'Run start --review with this reviewDir, then open pageUrl in the user\'s browser.' };
  }
  if (command === 'list') return { reviews: listReviews({ home: options['--home'], conversationId: options['--conversation'] }) };
  const directory = options['--review'] ? reviewDirectory(options['--review']) : null;
  if (command === 'route') {
    const input = await jsonInput(options['--input']);
    const result = sanitizeRoute(await routeTask(input), input);
    if (directory) withStore(directory, store => store.record('routing', result));
    return result;
  }
  if (command === 'start') return startService(directory);
  if (command === 'stop') return stopService(directory);
  if (command === 'serve') return serve(directory);
  if (command === 'state' || command === 'resume') return withStore(directory, store => ({ ...store.state(), reviewDir: directory, readiness: store.readiness(), handoff: handoff(store.manifest) }));
  if (command === 'readiness') return withStore(directory, store => store.readiness());
  if (command === 'close' || command === 'reopen') return withStore(directory, store => { const closed = command === 'close'; store.setClosed(closed); return { reviewDir: directory, closed }; });
  if (command === 'export') {
    const destination = artifactPath(directory, options['--output'] ?? `review-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`);
    const state = withStore(directory, store => store.state());
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, `${JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { status: 'exported', path: destination, reviewId: state.review.id };
  }
  if (command === 'import-artifact') {
    if (!options['--source']) fail('missing_source', '--source FILE is required.');
    const source = fs.realpathSync(options['--source']);
    const info = fs.statSync(source);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) fail('invalid_artifact', 'Artifact source must be a regular file of at most 20 MiB.');
    const destination = artifactPath(directory, options['--output'] ?? path.basename(source));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(source), { flag: 'wx', mode: 0o600 });
    return { status: 'imported', path: destination, bytes: info.size };
  }
  if (command === 'page-bundle') {
    if (!options['--environment']) fail('missing_environment', '--environment THIS_T3_ENVIRONMENT_ID is required.');
    const body = withStore(directory, store => store.pageBundle({ environmentId: options['--environment'] }));
    const text = frameRelay('page', body);
    if (text.length > RELAY_MAX_CHARS) fail('bundle_too_large', `The page bundle is ${text.length} characters; the limit is ${RELAY_MAX_CHARS}. Show the page on this machine instead.`, 413);
    return { text };
  }
  if (command === 'relay-export') {
    if (!options['--batch']) fail('missing_batch', '--batch BATCH_ID is required.');
    return { text: frameRelay('decisions', withStore(directory, store => store.relayExport(options['--batch']))) };
  }
  if (command === 'relay-import') {
    const manifest = readManifest(directory);
    const texts = options['--input'] ? [fs.readFileSync(path.resolve(options['--input']), 'utf8')] : readThreadTexts(manifest, manifest.conversationId);
    const body = unframeRelay('decisions', texts);
    if (!body) fail('no_decisions', 'No REVIEW-WORK-DECISIONS message was found in this chat.');
    return { reviewDir: directory, ...withStore(directory, store => store.relayImport(body)) };
  }
  const input = await jsonInput(options['--input'], command === 'findings');
  if (command === 'findings') return withStore(directory, store => ({ findings: store.addFindings(input) }));
  if (command === 'record') return withStore(directory, store => ({ record: store.record(options['--kind'], input) }));
  if (command === 'resolve') return withStore(directory, store => ({ batch: store.resolve(options['--id'], input) }));
  if (command === 'task-reserve') return withStore(directory, store => ({ task: store.reserveTask(input) }));
  if (command === 'task-update') return withStore(directory, store => ({ task: store.updateTask(options['--id'], input) }));
  fail('invalid_command', 'Unsupported owner command.');
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runCli(argv);
    process.stdout.write(result.help ?? (typeof result.text === 'string' ? `${result.text}\n` : `${JSON.stringify(result, null, 2)}\n`));
  } catch (error) {
    // JSON parse errors and routing inputs are never echoed. Filesystem errors contain only paths.
    const message = error.status || error.code?.startsWith('E') ? error.message : 'Owner command failed. Check arguments and the review service log; saved review data is retained.';
    if (process.send) process.send({ type: 'startup-error', message });
    process.stderr.write(`${JSON.stringify({ error: { code: error.status ? error.code : 'owner_error', message } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(THIS_FILE)) await main();
