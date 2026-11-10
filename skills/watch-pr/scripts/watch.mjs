#!/usr/bin/env node
// Read-only cloud provider observation. No Git writes, comments, pushes, or cleanup.
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { parseRepository, requestKey, requestUrl } from '../lib/identity.mjs';
import { getAdapter } from '../lib/providers/index.mjs';
import { gh, collectGitHubSnapshot } from '../lib/providers/github-snapshot.mjs';
import { acquireLock, hash, readState, writeState } from '../lib/state.mjs';
const good = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'success', 'neutral', 'skipped']);
const bad = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE',
  'failure', 'error', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);

export function parseArgs(args) {
  const o = { phase: 'open', interval: 30, timeout: 3600, expected: [], once: false, allowNoChecks: false };
  const values = new Set(['--url', '--repo', '--pr', '--phase', '--interval', '--timeout', '--state-dir', '--expect']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (seen.has(k) && k !== '--expect') throw new Error(`Duplicate option: ${k}`);
    seen.add(k);
    if (k === '--once') o.once = true;
    else if (k === '--allow-no-checks') o.allowNoChecks = true;
    else if (values.has(k) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const v = args[++i];
      if (k === '--expect') o.expected.push(v);
      else o[{ '--state-dir': 'stateDir' }[k] ?? k.slice(2)] = v;
    } else throw new Error(`Unknown option or missing value: ${k}`);
  }
  if (o.url) {
    if (o.repo || o.pr) throw new Error('Use --url or the legacy --repo/--pr pair, not both.');
    o.repository = parseRepository(o.url, { requireRequest: true });
    o.url = requestUrl(o.repository);
    o.pr = o.repository.requestId;
    o.repo = o.repository.repo;
  } else if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(o.repo ?? '') ||
      ['.', '..'].includes(o.repo?.split('/')[1]) || !/^[1-9]\d*$/.test(o.pr ?? '')) {
    throw new Error('Provide --url <cloud PR/MR URL>, or GitHub --repo owner/name --pr <positive number>.');
  }
  if (!['open', 'merged'].includes(o.phase)) throw new Error('--phase must be open or merged.');
  for (const k of ['interval', 'timeout']) {
    o[k] = Number(o[k]);
    if (!Number.isInteger(o[k]) || o[k] < (k === 'interval' ? 10 : 1) || o[k] > 86400) {
      throw new Error(`Invalid --${k}. Interval minimum is 10 seconds; maximum duration is 86400 seconds.`);
    }
  }
  if (o.phase === 'merged' && !o.expected.length && !o.allowNoChecks) {
    throw new Error('Merged phase needs --expect <workflow name> from repository guidance, or explicit --allow-no-checks.');
  }
  if (o.allowNoChecks && o.expected.length) throw new Error('--allow-no-checks and --expect are mutually exclusive.');
  o.stateDir = path.resolve(o.stateDir ?? path.join(homedir(), '.agents', 'state', 'watch-pr'));
  o.pr = Number(o.pr);
  if (!Number.isSafeInteger(o.pr)) throw new Error('PR number exceeds the supported integer range.');
  return o;
}

export { gh } from '../lib/providers/github-snapshot.mjs';
export async function collectSnapshot(options, api = gh) {
  if (!options.url || parseRepository(options.url).provider === 'github') {
    const repository = options.url ? parseRepository(options.url, { requireRequest: true }) : parseRepository(`https://github.com/${options.repo}`);
    return collectGitHubSnapshot({ ...options, repo: repository.repo, pr: repository.requestId ?? options.pr }, api);
  }
  const repository = parseRepository(options.url, { requireRequest: true });
  const adapter = getAdapter(repository, { readOnly: true });
  await adapter.resolveRepository(repository);
  return adapter.collectSnapshot({ ...options, pr: repository.requestId, requestId: repository.requestId });
}

export function assess(s, { allowNoChecks = false } = {}) {
  if (s.phase === 'open' && s.state === 'MERGED') return { status: 'merged', reasons: ['Invoke merged phase to validate the merge commit.'] };
  if (s.state === 'CLOSED') return { status: 'action', reasons: ['PR closed without merging.'] };
  if (s.policyKnown !== true) return { status: 'action', reasons: ['Required-check policy could not be established.'] };
  if (s.gates?.some(g => !['satisfied', 'not_applicable', 'pending'].includes(g.state))) return { status: 'action', reasons: ['Required provider policy failed or could not be verified.'] };
  const failed = s.checks.filter(c => c.required !== false && bad.has(c.state));
  if (failed.length) return { status: 'action', reasons: failed.map(c => `Failed: ${c.name}`) };
  if (s.phase === 'open') {
    if (s.threads.some(t => !t.isResolved) || s.reviewDecision === 'CHANGES_REQUESTED' || ['DIRTY', 'BEHIND'].includes(s.mergeStateStatus)) {
      return { status: 'action', reasons: ['Unresolved feedback, requested changes, conflicts, or branch behind base.'] };
    }
    if (s.isDraft || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(s.mergeStateStatus) ||
      (s.reviewDecision && s.reviewDecision !== 'APPROVED')) return { status: 'waiting', reasons: ['Merge/review requirements pending.'] };
  }
  const missing = s.expected.filter(e => {
    const requirement = typeof e === 'string' ? { name: e } : e;
    const matches = s.checks.filter(c => c.name === requirement.name &&
      (requirement.appId == null || requirement.appId < 0 || c.appId === requirement.appId));
    return !matches.length || matches.some(c => !good.has(c.state));
  });
  if (missing.length || s.gates?.some(g => g.state === 'pending') || s.checks.some(c => c.required !== false && !good.has(c.state)) || (!s.checks.length && !allowNoChecks)) {
    return { status: 'waiting', reasons: ['Expected validation has not passed on this commit.'] };
  }
  return { status: 'ready', reasons: [] };
}

export function transition(previous = {}, snapshot, options = {}) {
  const verdict = assess(snapshot, options);
  const fingerprints = Object.fromEntries([
    ...snapshot.feedback.map(f => [f.id, hash(f)]), ...snapshot.threads.map(f => [f.id, hash(f)]),
  ]);
  const events = [];
  if (previous.sha !== snapshot.sha) events.push({ type: 'head', sha: snapshot.sha });
  for (const [id, digest] of Object.entries(fingerprints)) if (previous.feedback?.[id] !== digest) events.push({ type: 'feedback', id });
  const checkHash = hash(snapshot.checks);
  if (previous.checkHash !== checkHash) events.push({ type: 'checks', sha: snapshot.sha, checks: snapshot.checks });
  if (previous.status !== verdict.status) events.push({ type: 'status', ...verdict, sha: snapshot.sha });
  return { events, verdict, state: { version: 2, sha: snapshot.sha, feedback: fingerprints, checkHash, status: verdict.status } };
}

export function backoff(attempt) { return Math.min(300, 30 * 2 ** attempt); }

export { acquireLock } from '../lib/state.mjs';

export async function run(options, { api = gh, adapterFactory = getAdapter, sleep = delay, emit = e => process.stdout.write(`${JSON.stringify(e)}\n`), signal } = {}) {
  const repository = options.repository ?? (options.url ? parseRepository(options.url, { requireRequest: true }) : parseRepository(`https://github.com/${options.repo}`));
  const legacyClient = repository.provider === 'github' && api !== gh ? {
    async request(method, endpoint) {
      if (method !== 'GET') throw new Error('Watcher refuses writes.');
      return api(['api', '--hostname', 'github.com', endpoint.replace(/^\//, '')]);
    },
  } : undefined;
  const adapter = adapterFactory(repository, { readOnly: true, ...(legacyClient ? { client: legacyClient, githubApi: api } : {}) });
  let resolved;
  try { resolved = await adapter.resolveRepository(repository); }
  catch (error) {
    if (error.transient && options.once) { emit({ type: 'retry', seconds: backoff(0), reason: 'Provider temporarily unavailable or rate limited.' }); return 3; }
    throw error;
  }
  const identity = { ...resolved, requestId: repository.requestId ?? options.pr };
  const key = hash(requestKey(identity));
  const legacyKeys = repository.provider === 'github' ? [...new Set([repository.repo, resolved.repo].map(repo => hash({ repo: repo.toLowerCase(), pr: Number(identity.requestId) })))] : [];
  const releases = [];
  try {
    for (const lock of [...new Set([...legacyKeys, key])].sort()) releases.push(await acquireLock(options.stateDir, lock));
  } catch (error) { for (const release of releases.reverse()) await release(); throw error; }
  const filename = path.join(options.stateDir, `${key}-${options.phase}.json`);
  let state = {}, failures = 0;
  try {
    state = await readState(filename);
    if (!state) {
      for (const legacy of legacyKeys) { state = await readState(path.join(options.stateDir, `${legacy}-${options.phase}.json`)); if (state) break; }
    }
    state ??= {};
    const until = Date.now() + options.timeout * 1000;
    while (!signal?.aborted && Date.now() < until) {
      try {
        const snapshot = await adapter.collectSnapshot({ ...options, pr: identity.requestId, requestId: identity.requestId });
        const update = transition(state, snapshot, options);
        update.events.forEach(emit);
        update.state.identity = requestKey(identity);
        await writeState(filename, update.state);
        state = update.state; failures = 0;
        const { status } = update.verdict;
        // Feedback must be evaluated by the agent before reporting readiness.
        if (update.events.some(e => e.type === 'feedback')) return 1;
        if (status === 'ready') return 0;
        if (status === 'action' || status === 'merged') return 1;
        if (options.once) return 3;
        await sleep(Math.min(options.interval * 1000, Math.max(0, until - Date.now())), undefined, { signal });
      } catch (e) {
        if (signal?.aborted) return 3;
        if (!e.transient || ++failures > 5) throw e;
        const seconds = backoff(failures - 1);
        emit({ type: 'retry', seconds, reason: 'Provider temporarily unavailable or rate limited.' });
        if (options.once) return 3;
        await sleep(Math.min(seconds * 1000, Math.max(0, until - Date.now())), undefined, { signal });
      }
    }
    emit({ type: 'paused', reason: 'Time limit or interruption; not approval.' });
    return 3;
  } finally { for (const release of releases.reverse()) await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try { process.exitCode = await run(parseArgs(process.argv.slice(2)), { signal: controller.signal }); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
