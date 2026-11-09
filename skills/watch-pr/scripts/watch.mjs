#!/usr/bin/env node
// Read-only GitHub observation. No Git writes, comments, pushes, or cleanup.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const good = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'success', 'neutral', 'skipped']);
const bad = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE',
  'failure', 'error', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);

export function parseArgs(args) {
  const o = { phase: 'open', interval: 30, timeout: 3600, expected: [], once: false, allowNoChecks: false };
  const values = new Set(['--repo', '--pr', '--phase', '--interval', '--timeout', '--state-dir', '--expect']);
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
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(o.repo ?? '') ||
      ['.', '..'].includes(o.repo?.split('/')[1]) || !/^[1-9]\d*$/.test(o.pr ?? '')) {
    throw new Error('Provide --repo owner/name and --pr <positive number>. GitHub.com only.');
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

export async function gh(args, execute = exec) {
  try {
    const { stdout } = await execute('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 45000,
      windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    const value = JSON.parse(stdout);
    if (value.errors?.length) {
      const error = new Error('GitHub GraphQL returned errors.');
      error.transient = value.errors.some(e => e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message ?? ''));
      throw error;
    }
    return value;
  } catch (e) {
    // Do not echo remote content, credentials, or complete CLI stderr.
    const message = String(e.stderr ?? e.message);
    const error = new Error('GitHub request failed; inspect authentication, permissions, or API availability.');
    error.notFound = /HTTP 404/.test(message);
    error.transient = e.transient === true || /rate limit|HTTP (429|5\d\d)|ETIMEDOUT|timed? ?out|ECONNRESET|ENOTFOUND/i.test(message) || e.killed === true;
    throw error;
  }
}

async function pages(api, endpoint, field) {
  const chunks = await api(['api', '--hostname', 'github.com', '--paginate', '--slurp', endpoint]);
  return chunks.flatMap(page => field ? page[field] : page);
}

async function feedback(api, repo, number, field) {
  const selection = field === 'reviewThreads'
    ? 'id isResolved isOutdated comments(last:1){nodes{url updatedAt}}'
    : 'id url updatedAt';
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${field}(first:100,after:$after){nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`;
  const result = [];
  let cursor;
  do {
    const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`];
    if (cursor) args.push('-f', `after=${cursor}`);
    const data = await api(args);
    const connection = data.data?.repository?.pullRequest?.[field];
    if (!connection) throw new Error('Incomplete GitHub feedback response.');
    result.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !cursor) throw new Error('Missing GitHub pagination cursor.');
  } while (cursor);
  return result;
}

export async function collectSnapshot(options, api = gh) {
  const { repo, pr: number, phase } = options;
  const prArgs = ['pr', 'view', String(number), '--repo', `github.com/${repo}`, '--json',
    'url,state,headRefOid,baseRefName,mergeCommit,reviewDecision,mergeStateStatus,isDraft'];
  const pr = await api(prArgs);
  const sha = phase === 'merged' ? pr.mergeCommit?.oid : pr.headRefOid;
  if (phase === 'merged' && (pr.state !== 'MERGED' || !sha)) throw new Error('Merged phase requires a confirmed merge commit.');
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('Missing full commit SHA.');
  if (phase === 'open' && pr.state !== 'OPEN') return { ...pr, sha, phase, checks: [], feedback: [], threads: [], expected: [], policyKnown: true };

  let checks, expected = [...options.expected], policyKnown = true;
  let threads = [], notices = [];
  if (phase === 'merged') {
    const runs = await pages(api, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, 'workflow_runs');
    // A rebase/fast-forward merge may share the PR head SHA. Exclude PR events.
    const latest = new Map();
    for (const r of runs.filter(r => r.head_sha === sha && r.head_branch === pr.baseRefName &&
      !['pull_request', 'pull_request_target', 'merge_group'].includes(r.event))) {
      const key = r.workflow_id;
      if (!latest.has(key) || r.run_number > latest.get(key).run_number ||
        (r.run_number === latest.get(key).run_number && r.run_attempt > latest.get(key).run_attempt)) latest.set(key, r);
    }
    checks = [...latest.values()].map(r => ({ name: r.name, state: r.status === 'completed' ? r.conclusion : 'pending', url: r.html_url }));
  } else {
    const branch = encodeURIComponent(pr.baseRefName);
    const [runs, statuses, branchInfo] = await Promise.all([
      pages(api, `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, 'check_runs'),
      pages(api, `repos/${repo}/commits/${sha}/statuses?per_page=100`),
      api(['api', '--hostname', 'github.com', `repos/${repo}/branches/${branch}`]),
    ]);
    checks = runs.map(r => ({ name: r.name, appId: r.app?.id, state: r.status === 'completed' ? r.conclusion : 'pending', url: r.html_url }));
    const contexts = new Set();
    for (const s of statuses) {
      if (contexts.has(s.context)) continue; // REST returns newest statuses first.
      contexts.add(s.context); checks.push({ name: s.context, state: s.state, url: s.target_url });
    }
    const rules = await api(['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/${repo}/rules/branches/${branch}`]);
    expected.push(...rules.flat().filter(r => r.type === 'required_status_checks')
      .flatMap(r => r.parameters.required_status_checks.map(c => ({ name: c.context, appId: c.integration_id }))));
    try {
      const protection = await api(['api', '--hostname', 'github.com', `repos/${repo}/branches/${branch}/protection`]);
      const required = protection.required_status_checks;
      expected.push(...(required?.checks?.length ? required.checks.map(c => ({ name: c.context, appId: c.app_id })) : required?.contexts ?? []));
    } catch (e) {
      if (!e.notFound) throw e;
      // Protected branch plus no visible rules cannot prove a usable policy.
      if (branchInfo.protected && !rules.flat().length) policyKnown = false;
    }
    [threads, ...notices] = await Promise.all([
      feedback(api, repo, number, 'reviewThreads'), feedback(api, repo, number, 'comments'), feedback(api, repo, number, 'reviews'),
    ]);
    notices = notices.flat();
  }
  const current = await api(prArgs);
  if (current.headRefOid !== pr.headRefOid || current.state !== pr.state || current.baseRefName !== pr.baseRefName ||
      current.mergeCommit?.oid !== pr.mergeCommit?.oid) throw new Error('PR moved during observation; take a fresh snapshot.');
  return { ...current, sha, phase, checks, expected, policyKnown, threads, feedback: notices };
}

export function assess(s, { allowNoChecks = false } = {}) {
  if (s.phase === 'open' && s.state === 'MERGED') return { status: 'merged', reasons: ['Invoke merged phase to validate the merge commit.'] };
  if (s.state === 'CLOSED') return { status: 'action', reasons: ['PR closed without merging.'] };
  if (s.policyKnown !== true) return { status: 'action', reasons: ['Required-check policy could not be established.'] };
  const failed = s.checks.filter(c => bad.has(c.state));
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
  if (missing.length || s.checks.some(c => !good.has(c.state)) || (!s.checks.length && !allowNoChecks)) {
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
  return { events, verdict, state: { version: 1, sha: snapshot.sha, feedback: fingerprints, checkHash, status: verdict.status } };
}

export function backoff(attempt) { return Math.min(300, 30 * 2 ** attempt); }

export async function acquireLock(directory, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${key}.lock`), token = randomUUID();
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error(`Watcher lock exists: ${filename}. Check its PID and remove only this lock if its owner has stopped.`);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
  await handle.close();
  return async () => {
    if (JSON.parse(await readFile(filename, 'utf8')).token === token) await unlink(filename);
  };
}

export async function run(options, { api = gh, sleep = delay, emit = e => process.stdout.write(`${JSON.stringify(e)}\n`), signal } = {}) {
  const key = hash({ repo: options.repo.toLowerCase(), pr: options.pr });
  const release = await acquireLock(options.stateDir, key); // Shared by both phases.
  const filename = path.join(options.stateDir, `${key}-${options.phase}.json`);
  let state = {}, failures = 0;
  try {
    try { state = JSON.parse(await readFile(filename, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('Unreadable watcher state; inspect it before restarting.'); }
    const until = Date.now() + options.timeout * 1000;
    while (!signal?.aborted && Date.now() < until) {
      try {
        const snapshot = await collectSnapshot(options, api);
        const update = transition(state, snapshot, options);
        const temporary = `${filename}.${randomUUID()}.tmp`;
        update.events.forEach(emit);
        await writeFile(temporary, JSON.stringify(update.state), { mode: 0o600 });
        await rename(temporary, filename);
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
        emit({ type: 'retry', seconds, reason: 'GitHub temporarily unavailable or rate limited.' });
        if (options.once) return 3;
        await sleep(Math.min(seconds * 1000, Math.max(0, until - Date.now())), undefined, { signal });
      }
    }
    emit({ type: 'paused', reason: 'Time limit or interruption; not approval.' });
    return 3;
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try { process.exitCode = await run(parseArgs(process.argv.slice(2)), { signal: controller.signal }); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
