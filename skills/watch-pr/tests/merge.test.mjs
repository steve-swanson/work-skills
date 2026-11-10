import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyTarget } from '../lib/merge-policy.mjs';
import { runRequest } from '../lib/requests.mjs';
import { hash } from '../lib/state.mjs';
import { createGitHub } from '../lib/providers/github.mjs';
import { createGitLab } from '../lib/providers/gitlab.mjs';
import { createBitbucket } from '../lib/providers/bitbucket.mjs';
import { createAzure } from '../lib/providers/azure.mjs';
import { parseRepository } from '../lib/identity.mjs';
import { runCli } from '../scripts/request.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40), merged = 'c'.repeat(40);
async function fixture(t) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'review-work-merge-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const f = { writes: 0, reads: 0, defaultBranch: 'main', checks: [{ name: 'CI', state: 'success' }],
    feedback: [], threads: [], gates: [], reviewDecision: 'APPROVED', policyKnown: true,
    current: { provider: 'github', host: 'github.com', repositoryId: '2', requestId: 42,
      url: 'https://github.com/upstream/repo/pull/42', state: 'OPEN', sourceRepositoryId: '1', targetRepositoryId: '2',
      sourceRef: 'fix/review-findings', targetRef: 'feature/editor', sourceSha: head, targetSha: target, isDraft: false } };
  f.input = { url: f.current.url, headSha: head, targetSha: target, mergePolicy: { mode: 'review-work-working-branch',
    sourceRepositoryId: '1', targetRepositoryId: '2', sourceRef: f.current.sourceRef, targetRef: f.current.targetRef,
    sharedBranches: ['main', 'develop', 'qa', 'stg'], branchEvidence: 'Provider default and repository branch documentation inspected.' } };
  f.adapter = {
    async resolveRepository(r = parseRepository(f.input.url)) { return { ...r, repositoryId: '2', defaultBranch: f.defaultBranch }; },
    async getRequest() { f.reads++; if (f.onRead) f.onRead(); return structuredClone(f.current); },
    async collectSnapshot(options = {}) { return { phase: 'open', state: 'OPEN', sha: f.current.sourceSha, identity: structuredClone(f.current),
      checks: f.checks, expected: ['CI', ...(options.expected ?? [])], threads: f.threads, feedback: f.feedback, gates: f.gates, policyKnown: f.policyKnown,
      reviewDecision: f.reviewDecision, mergeStateStatus: 'CLEAN', isDraft: f.current.isDraft }; },
    async merge() { f.writes++; if (f.onMerge) return f.onMerge(); f.current = { ...f.current, state: 'MERGED', mergeSha: merged }; },
  };
  f.run = (input = f.input) => runRequest('merge', input, { stateDir, adapterFactory: () => f.adapter });
  return f;
}

test('target classification keeps shared/default/environment/release branches manual and permits ordinary working names', () => {
  for (const name of ['main', 'master', 'trunk', 'dev', 'develop', 'development', 'qa', 'uat', 'stg', 'stage', 'staging',
    'prod', 'production', 'live', 'test', 'testing', 'integration', 'release', 'releases', 'release/1.2', 'release-1.2',
    'releases_2026', 'qa/eu', 'refs/heads/main', 'company-shared']) {
    assert.equal(classifyTarget({ targetRef: name, defaultBranch: 'primary', sharedBranches: ['company-shared'] }).eligible, false, name);
  }
  for (const name of ['feature/editor', 'feat/main-menu', 'fix/qa-test', 'bugfix/123', 'chore/dependencies', 'ticket-123']) {
    assert.equal(classifyTarget({ targetRef: name, defaultBranch: 'main' }).eligible, true, name);
  }
  assert.equal(classifyTarget({ targetRef: 'feature/default', defaultBranch: 'feature/default' }).eligible, false);
  assert.equal(classifyTarget({ targetRef: 'feature/editor' }).eligible, false);
});

test('clean owned fix request merges once and returns authoritative merge commit without leaking text', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, 'merged'); assert.equal(result.request.mergeSha, merged); assert.equal(f.writes, 1);
  assert.equal((await f.run()).status, 'merged'); assert.equal(f.writes, 1);
});

test('shared targets, custom default branches, unknown roles and caller opt-outs prevent any merge', async t => {
  for (const mutate of [
    f => { f.current.targetRef = f.input.mergePolicy.targetRef = 'main'; },
    f => { f.defaultBranch = 'feature/editor'; }, f => { f.defaultBranch = undefined; },
    f => { f.input.mergePolicy.sharedBranches.push('feature/editor'); },
    f => { f.input.mergePolicy.mode = 'manual'; }, f => { f.input.mergePolicy.optOut = true; },
    f => { f.input.mergePolicy.branchEvidence = ''; }, f => { delete f.input.mergePolicy; },
  ]) {
    const f = await fixture(t); mutate(f); await assert.rejects(f.run()); assert.equal(f.writes, 0);
  }
});

test('failed, pending, unknown, draft, or missing approval prevents a merge', async t => {
  for (const mutate of [
    f => { f.checks[0].state = 'failure'; }, f => { f.checks[0].state = 'pending'; },
    f => { f.checks = []; }, f => { f.reviewDecision = 'REVIEW_REQUIRED'; },
    f => { f.reviewDecision = 'CHANGES_REQUESTED'; }, f => { f.current.isDraft = true; },
    f => { f.policyKnown = false; }, f => { f.gates = [{ id: 'manual-job', state: 'pending' }]; },
    f => { f.gates = [{ id: 'policy', state: 'unknown' }]; },
    f => { f.threads = [{ id: 'thread', isResolved: false }]; },
  ]) {
    const f = await fixture(t); mutate(f); await assert.rejects(f.run(), /validation/); assert.equal(f.writes, 0);
  }
});

test('repair can merge only after validation passes for its new published head', async t => {
  const f = await fixture(t); f.checks[0].state = 'failure';
  await assert.rejects(f.run(), /validation/); assert.equal(f.writes, 0);
  f.current.sourceSha = 'd'.repeat(40); f.checks[0].state = 'success';
  await assert.rejects(f.run(), /exact reviewed/);
  f.input.headSha = f.current.sourceSha;
  assert.equal((await f.run()).status, 'merged'); assert.equal(f.writes, 1);
});

test('wrong owner, retargeting, source/target movement and changed default branch invalidate authorization', async t => {
  for (const mutate of [
    f => { f.input.mergePolicy.sourceRepositoryId = 'other'; },
    f => { f.current.targetRef = 'fix/different'; },
    f => { f.current.targetSha = merged; },
    f => { f.onRead = () => { if (f.reads === 2) f.current.sourceSha = merged; }; },
    f => { f.onRead = () => { if (f.reads === 2) f.current.targetSha = merged; }; },
    f => { const original = f.adapter.resolveRepository; let n = 0; f.adapter.resolveRepository = async r => { if (++n === 2) f.defaultBranch = f.current.targetRef; return original(r); }; },
  ]) {
    const f = await fixture(t); mutate(f); await assert.rejects(f.run()); assert.equal(f.writes, 0);
  }
});

test('current feedback requires disposition evidence; declined nitpicks remain declined', async t => {
  const f = await fixture(t), comment = { id: 'comment:1', updatedAt: '2026-11-09', url: 'https://github.com/upstream/repo/pull/42#issuecomment-1' };
  f.feedback = [comment]; await assert.rejects(f.run(), /disposition/);
  f.input.feedback = [{ id: comment.id, digest: hash(comment), disposition: 'declined', reason: 'Optional nitpick previously declined by user; behavior is covered by focused checks.' }];
  comment.updatedAt = '2026-11-10'; await assert.rejects(f.run(), /disposition/);
  f.input.feedback[0].digest = hash(comment);
  assert.equal((await f.run()).status, 'merged');
});

test('no-CI merge requires explicit evidence, not empty results or an allow flag alone', async t => {
  const f = await fixture(t), original = f.adapter.collectSnapshot;
  f.checks = []; f.adapter.collectSnapshot = async () => ({ ...await original(), expected: [] });
  await assert.rejects(f.run(), /validation/);
  f.input.allowNoChecks = true; await assert.rejects(f.run(), /explicit/);
  f.input.noChecksEvidence = 'Repository instructions explicitly say this branch has no CI.';
  assert.equal((await f.run()).status, 'merged');
});

test('lost merge response reconciles completed merge without another write', async t => {
  const f = await fixture(t); f.onMerge = () => { f.current = { ...f.current, state: 'MERGED', mergeSha: merged }; throw Error('lost response'); };
  assert.equal((await f.run()).status, 'merged'); assert.equal((await f.run()).status, 'merged'); assert.equal(f.writes, 1);
});

test('asynchronous/uncertain merge remains pending across resumes and cannot dispatch a changed intent', async t => {
  const f = await fixture(t); f.onMerge = () => {};
  assert.equal((await f.run()).status, 'merge_pending'); assert.equal((await f.run()).status, 'merge_pending'); assert.equal(f.writes, 1);
  f.current.sourceSha = f.input.headSha = 'd'.repeat(40);
  await assert.rejects(f.run(), /uncertain/); assert.equal(f.writes, 1);
  f.current.sourceSha = f.input.headSha = head; f.current.state = 'MERGED'; f.current.mergeSha = merged;
  assert.equal((await f.run()).status, 'merged'); assert.equal(f.writes, 1);
});

test('confirmed policy rejection never counts as merge success', async t => {
  const f = await fixture(t); f.onMerge = () => { throw Object.assign(Error('conflict'), { status: 409 }); };
  await assert.rejects(f.run(), /rejected/); assert.equal(f.writes, 1);
});

test('concurrent merge attempts share one write lock and uncertain closure is not success', async t => {
  const f = await fixture(t);
  let entered, finish;
  const dispatched = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  f.onMerge = async () => { entered(); await gate; f.current.state = 'CLOSED'; };
  const first = assert.rejects(f.run(), /closed without/); await dispatched;
  try { await assert.rejects(f.run(), /lock exists/); }
  finally { finish(); }
  await first; assert.equal(f.writes, 1);
  await assert.rejects(f.run(), /closed without/); assert.equal(f.writes, 1);
});

test('repository documented checks and app bindings remain required at merge time', async t => {
  const f = await fixture(t); f.input.expected = ['Required by repository docs'];
  await assert.rejects(f.run(), /validation/); assert.equal(f.writes, 0);
  f.input.expected = [{ name: 'CI', appId: 42 }];
  await assert.rejects(f.run(), /validation/); assert.equal(f.writes, 0);
  f.checks[0].appId = 42;
  assert.equal((await f.run()).status, 'merged');
});

test('standalone JSON command exposes guarded merge and rejects it without review-work authorization', async t => {
  const f = await fixture(t), opts = { stateDir: await mkdtemp(path.join(tmpdir(), 'merge-cli-')), adapterFactory: () => f.adapter };
  t.after(() => rm(opts.stateDir, { recursive: true, force: true }));
  assert.match((await runCli(['--help'])).help, /merge/);
  await assert.rejects(runCli(['merge', '--input', JSON.stringify({ ...f.input, mergePolicy: { mode: 'manual' } })], opts), /review-work/);
  assert.equal((await runCli(['merge', '--input', JSON.stringify(f.input)], opts)).status, 'merged');
});

test('provider merge payloads use native head guards where supported, preserve branches, and never bypass policies', async () => {
  const calls = [], client = { async request(method, endpoint, body) { calls.push({ method, endpoint, body }); return { merged: true }; } };
  const repositories = [
    ['https://github.com/o/r', createGitHub], ['https://gitlab.com/g/r', createGitLab],
    ['https://bitbucket.org/o/r', createBitbucket], ['https://dev.azure.com/o/p/_git/r', createAzure],
  ];
  for (const [url, create] of repositories) {
    const adapter = create({ repository: { ...parseRepository(url), repositoryId: '2' }, client: { ...client, pages: async () => [] } });
    await adapter.merge(42, { headSha: head, strategy: 'squash' });
    await assert.rejects(adapter.merge(42, { headSha: head, strategy: 'unsupported' }), /Unsupported/);
  }
  assert.deepEqual(calls[0], { method: 'PUT', endpoint: '/repos/o/r/pulls/42/merge', body: { sha: head, merge_method: 'squash' } });
  assert.deepEqual(calls[1].body, { sha: head, auto_merge: false, should_remove_source_branch: false, squash: true });
  assert.deepEqual(calls[2].body, { type: 'pullrequest', close_source_branch: false, merge_strategy: 'squash' });
  assert.deepEqual(calls[3].body, { status: 'completed', lastMergeSourceCommit: { commitId: head },
    completionOptions: { deleteSourceBranch: false, bypassPolicy: false, mergeStrategy: 'squash' } });
});
