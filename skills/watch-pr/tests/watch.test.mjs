import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, assess, backoff, collectSnapshot, gh, parseArgs, run, transition } from '../scripts/watch.mjs';

const sha = 'a'.repeat(40), mergedSha = 'b'.repeat(40);
const options = () => parseArgs(['--repo', 'test/project', '--pr', '42', '--once']);
const snapshot = (overrides = {}) => ({ state: 'OPEN', phase: 'open', sha, checks: [{ name: 'CI', state: 'success' }],
  expected: ['CI'], policyKnown: true, threads: [], feedback: [], reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', ...overrides });

function apiFixture(overrides = {}) {
  const pr = { state: 'OPEN', headRefOid: sha, baseRefName: 'main', mergeCommit: null,
    reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', isDraft: false, ...overrides.pr };
  const calls = [];
  const api = async args => {
    calls.push(args);
    if (args[0] === 'pr') return { ...pr, ...(calls.filter(c => c[0] === 'pr').length > 1 ? overrides.finalPr : {}) };
    const endpoint = args.at(-1);
    if (endpoint === 'repos/test/project') return { id: 7, full_name: 'test/project', html_url: 'https://github.com/test/project', default_branch: 'main' };
    if (endpoint === 'repos/test/project/pulls/42') return { number: 42, html_url: 'https://github.com/test/project/pull/42', state: pr.state === 'OPEN' ? 'open' : 'closed',
      merged_at: pr.state === 'MERGED' ? 'now' : null, merge_commit_sha: pr.mergeCommit?.oid,
      head: { ref: 'feature', sha: pr.headRefOid, repo: { id: 7 } }, base: { ref: pr.baseRefName, sha, repo: { id: 7 } }, draft: pr.isDraft };
    if (args.includes('graphql')) {
      const query = args.find(x => x.startsWith('query='));
      const field = ['reviewThreads', 'comments', 'reviews'].find(x => query.includes(`${x}(`));
      const after = args.find(x => x.startsWith('after='));
      const page = overrides.feedbackPages?.[field]?.[after ? 1 : 0];
      return { data: { repository: { pullRequest: { [field]: page ?? { nodes: [], pageInfo: { hasNextPage: false } } } } } };
    }
    if (endpoint.includes('/check-runs?')) return [{ check_runs: overrides.checks ?? [{ name: 'CI', app: { id: 1 }, status: 'completed', conclusion: 'success' }] }];
    if (endpoint.includes('/statuses?')) return [overrides.statuses ?? []];
    if (endpoint.includes('/actions/runs?')) return [{ workflow_runs: overrides.runs ?? [] }];
    if (endpoint.includes('/rules/branches/')) return [overrides.rules ?? []];
    if (endpoint.endsWith('/protection')) {
      if (overrides.protectionError) throw overrides.protectionError;
      return overrides.protection ?? { required_status_checks: { checks: [{ context: 'CI', app_id: 1 }] } };
    }
    if (endpoint.includes('/branches/')) return { protected: overrides.protected ?? true };
    throw new Error(`Unexpected API call: ${args.join(' ')}`);
  };
  return { api, calls, pr };
}

test('arguments reject ambiguous/unsafe targets and require explicit merged CI policy', () => {
  assert.equal(options().pr, 42);
  for (const args of [[], ['--repo', '../x', '--pr', '42'], ['--repo', 'a/b', '--pr', '0'],
    ['--repo', 'a/b', '--pr', '1', '--phase', 'merged'], ['--repo', 'a/b', '--pr', '1', '--interval', '0'],
    ['--repo', 'a/b', '--pr', '1', '--expect', 'CI', '--allow-no-checks']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['--repo', 'a/b', '--pr', '1', '--phase', 'merged', '--expect', 'Build', '--expect', 'Test']).expected, ['Build', 'Test']);
});

test('gh transport classifies HTTP and GraphQL rate limits without echoing remote secrets', async () => {
  for (const execute of [
    async () => ({ stdout: JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'PRIVATE_REMOTE_TEXT' }] }) }),
    async () => { throw Object.assign(new Error('failure'), { stderr: 'HTTP 429 PRIVATE_REMOTE_TEXT' }); },
  ]) {
    await assert.rejects(gh(['api', 'graphql'], execute), e => {
      assert.equal(e.transient, true);
      assert.doesNotMatch(e.message, /PRIVATE_REMOTE_TEXT/);
      return true;
    });
  }
  await assert.rejects(gh(['api'], async () => { throw Object.assign(new Error('denied'), { stderr: 'HTTP 403 PRIVATE' }); }), e => !e.transient);
});

test('readiness requires current completed checks, expected contexts, readable policy, and reviews', () => {
  assert.equal(assess(snapshot()).status, 'ready');
  for (const state of ['failure', 'cancelled', 'timed_out', 'action_required', 'error', 'stale']) {
    assert.equal(assess(snapshot({ checks: [{ name: 'CI', state }] })).status, 'action');
  }
  for (const change of [{ checks: [] }, { checks: [{ name: 'CI', state: 'pending' }] },
    { expected: ['Missing'] }, { reviewDecision: 'REVIEW_REQUIRED' }, { mergeStateStatus: 'UNKNOWN' }, { isDraft: true }]) {
    assert.equal(assess(snapshot(change)).status, 'waiting');
  }
  assert.equal(assess(snapshot({ policyKnown: false })).status, 'action');
  assert.equal(assess(snapshot({ checks: [], expected: [] }), { allowNoChecks: true }).status, 'ready');
  assert.equal(assess(snapshot({ checks: [], expected: ['CI'] }), { allowNoChecks: true }).status, 'waiting');
  assert.equal(assess(snapshot({ threads: [{ isResolved: false, isOutdated: true }] })).status, 'action');
  assert.equal(assess(snapshot({ mergeStateStatus: 'BEHIND' })).status, 'action');
  assert.equal(assess(snapshot({ state: 'CLOSED' })).status, 'action');
  assert.equal(assess(snapshot({ state: 'MERGED' })).status, 'merged');
});

test('app-bound requirements cannot be satisfied by a check with the same name from another app', () => {
  assert.equal(assess(snapshot({ expected: [{ name: 'CI', appId: 99 }], checks: [{ name: 'CI', appId: 1, state: 'success' }] })).status, 'waiting');
});

test('observations deduplicate events, detect edited feedback and new heads, and never carry old green forward', () => {
  const initial = transition({}, snapshot({ feedback: [{ id: 'C1', updatedAt: 'one' }] }));
  assert.ok(initial.events.some(e => e.type === 'feedback'));
  assert.deepEqual(transition(initial.state, snapshot({ feedback: [{ id: 'C1', updatedAt: 'one' }] })).events, []);
  assert.ok(transition(initial.state, snapshot({ feedback: [{ id: 'C1', updatedAt: 'two' }] })).events.some(e => e.type === 'feedback'));
  const moved = transition(initial.state, snapshot({ sha: mergedSha, checks: [] }));
  assert.equal(moved.verdict.status, 'waiting');
  assert.ok(moved.events.some(e => e.type === 'head'));
});

test('collector pins checks to SHA, paginates feedback, discovers rules and uses newest legacy statuses', async () => {
  const f = apiFixture({ statuses: [{ context: 'legacy', state: 'success' }, { context: 'legacy', state: 'failure' }],
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Extra', integration_id: 7 }] } }],
    feedbackPages: { comments: [{ nodes: [{ id: 'C1' }], pageInfo: { hasNextPage: true, endCursor: 'next' } },
      { nodes: [{ id: 'C2' }], pageInfo: { hasNextPage: false } }] } });
  const s = await collectSnapshot(options(), f.api);
  assert.deepEqual(s.feedback.map(c => c.id), ['C1', 'C2']);
  assert.equal(s.checks.filter(c => c.name === 'legacy').length, 1);
  assert.equal(s.checks.find(c => c.name === 'legacy').state, 'success');
  assert.ok(s.expected.some(c => c.name === 'Extra' && c.appId === 7));
  assert.ok(f.calls.some(c => c.at(-1).includes(`/commits/${sha}/check-runs`)));
  assert.equal(assess(s).status, 'waiting');
});

test('a PR that moves during observation invalidates the snapshot', async () => {
  await assert.rejects(collectSnapshot(options(), apiFixture({ finalPr: { headRefOid: mergedSha } }).api), /moved/);
});

test('readiness uses refreshed review and merge state even when head does not move', async () => {
  const s = await collectSnapshot(options(), apiFixture({ finalPr: { mergeStateStatus: 'BEHIND', reviewDecision: 'CHANGES_REQUESTED' } }).api);
  assert.equal(assess(s).status, 'action');
});

test('unreadable protected-branch policy cannot pass, and API failures are not empty policy', async () => {
  const notFound = Object.assign(new Error('not found'), { notFound: true });
  const s = await collectSnapshot(options(), apiFixture({ protectionError: notFound }).api);
  assert.equal(assess(s).status, 'action');
  const unprotected = await collectSnapshot(options(), apiFixture({ protectionError: notFound, protected: false }).api);
  assert.equal(assess(unprotected).status, 'ready');
  await assert.rejects(collectSnapshot(options(), apiFixture({ protectionError: new Error('denied') }).api), /denied/);
});

test('merged observation uses actual merge SHA and base branch, excludes PR events and selects latest reruns', async () => {
  const o = { ...options(), phase: 'merged', expected: ['CI'] };
  const row = { name: 'CI', workflow_id: 1, head_sha: mergedSha, head_branch: 'main', event: 'push', run_number: 10, run_attempt: 1, status: 'completed', conclusion: 'failure' };
  const f = apiFixture({ pr: { state: 'MERGED', mergeCommit: { oid: mergedSha } }, runs: [row,
    { ...row, run_attempt: 2, conclusion: 'success' }, { ...row, workflow_id: 2, name: 'wrong', event: 'pull_request' },
    { ...row, workflow_id: 3, name: 'wrong-branch', head_branch: 'develop' }, { ...row, workflow_id: 4, name: 'wrong-sha', head_sha: sha }] });
  const s = await collectSnapshot(o, f.api);
  assert.equal(s.sha, mergedSha);
  assert.deepEqual(s.checks.map(c => c.name), ['CI']);
  assert.equal(assess(s).status, 'ready');
  assert.ok(f.calls.some(c => c.at(-1).includes(`head_sha=${mergedSha}`)));
  assert.equal(assess({ ...s, checks: [] }).status, 'waiting');
  await assert.rejects(collectSnapshot(o, apiFixture().api), /confirmed merge/);
});

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'watch-pr-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('portable exclusive lock spans phases and releases without deleting state', async t => {
  const root = await directory(t);
  const release = await acquireLock(root, 'same-pr');
  await assert.rejects(acquireLock(root, 'same-pr'), /lock exists/);
  await release();
  const again = await acquireLock(root, 'same-pr');
  await again();
});

test('run handles existing feedback before green, resumes without duplicate events, and writes no comment text', async t => {
  const stateDir = await directory(t), emitted = [];
  const f = apiFixture({ feedbackPages: { comments: [{ nodes: [{ id: 'C1', updatedAt: 'now', body: 'PRIVATE_COMMENT' }], pageInfo: {} }] } });
  const o = { ...options(), stateDir };
  assert.equal(await run(o, { api: f.api, emit: e => emitted.push(e) }), 1);
  assert.ok(emitted.some(e => e.type === 'feedback'));
  emitted.length = 0;
  assert.equal(await run(o, { api: f.api, emit: e => emitted.push(e) }), 0);
  assert.deepEqual(emitted, []);
  const files = await readdir(stateDir);
  assert.equal(files.filter(f => f.endsWith('.lock')).length, 0);
  assert.doesNotMatch(await readFile(path.join(stateDir, files[0]), 'utf8'), /PRIVATE_COMMENT/);
});

test('pending, failures, and rate limits have distinct non-success exits; backoff is bounded', async t => {
  const stateDir = await directory(t);
  const o = { ...options(), stateDir };
  assert.equal(await run(o, { api: apiFixture({ checks: [] }).api, emit: () => {} }), 3);
  assert.equal(await run(o, { api: apiFixture({ checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }] }).api, emit: () => {} }), 1);
  const events = [];
  assert.equal(await run(o, { api: async () => { throw Object.assign(new Error('limited'), { transient: true }); }, emit: e => events.push(e) }), 3);
  assert.equal(events[0].seconds, 30);
  assert.equal(backoff(12), 300);
  await assert.rejects(run(o, { api: async () => { throw new Error('denied'); } }), /denied/);
  assert.equal((await readdir(stateDir)).some(f => f.endsWith('.lock')), false);
});
