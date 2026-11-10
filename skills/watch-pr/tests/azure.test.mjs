import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzure } from '../lib/providers/azure.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40), merged = 'c'.repeat(40), synthetic = 'd'.repeat(40);
const repository = { provider: 'azure', host: 'dev.azure.com', repo: 'org/project/repo', organization: 'org', project: 'project', repoName: 'repo' };
const rawPr = () => ({ pullRequestId: 9, status: 'active', title: 'Feature', description: 'Line one\nLine two',
  sourceRefName: 'refs/heads/feature/a', targetRefName: 'refs/heads/main', isDraft: false,
  repository: { id: 'target-id', name: 'repo', project: { id: 'project-id', name: 'project' } },
  lastMergeSourceCommit: { commitId: head }, lastMergeTargetCommit: { commitId: target }, lastMergeCommit: { commitId: synthetic },
  mergeStatus: 'succeeded', reviewers: [{ id: 'reviewer', isRequired: true, vote: 10 }],
  _links: { web: { href: 'https://dev.azure.com/org/project/_git/repo/pullrequest/9' } } });
const build = () => ({ id: 18, repository: { id: 'target-id' }, definition: { id: 3, name: 'CI' },
  sourceVersion: synthetic, sourceBranch: 'refs/pull/9/merge', reason: 'pullRequest', status: 'completed', result: 'succeeded' });
const config = () => ({ id: 1, isBlocking: true, isEnabled: true,
  type: { id: '0609b952-1397-4640-95ec-e00a01b2c241' }, settings: { buildDefinitionId: 3 } });

function fixture(changes = {}) {
  const raw = { ...rawPr(), ...changes.raw }, calls = [];
  let prReads = 0;
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path.includes('/threads')) return { id: 4 };
      if (path.includes('/build/builds/')) return changes.lookupBuild ?? build();
      if (path.includes('/pullrequests/9?')) {
        if (method === 'PATCH') return { ...raw, ...body };
        prReads++;
        return prReads > 1 && changes.moved ? { ...raw, lastMergeSourceCommit: { commitId: merged }, status: 'completed' } : raw;
      }
      if (path.includes('/pullrequests?') && method === 'POST') return { ...raw, title: body.title, description: body.description, isDraft: body.isDraft,
        ...(body.forkSource ? { forkSource: body.forkSource } : {}) };
      if (path.includes('/git/repositories/')) return { id: path.includes('source') ? 'source-id' : 'target-id', name: 'repo',
        project: { id: 'project-id', name: 'project' }, defaultBranch: 'refs/heads/main' };
      throw new Error(`Unexpected ${method} ${path}`);
    },
    async pages(path, field) {
      calls.push({ method: 'PAGES', path, field });
      if (changes.fail && path.includes(changes.fail)) throw Error('denied');
      if (path.includes('/refs?')) {
        const source = path.includes(encodeURIComponent('heads/feature/a'));
        return [{ name: source ? 'refs/heads/feature/a' : 'refs/heads/main', objectId: source ? (changes.currentHead ?? head) : (changes.currentTarget ?? target) }];
      }
      if (path.includes('/git/policy/configurations')) return changes.configurations ?? [config()];
      if (path.includes('/policy/evaluations')) return changes.evaluations ?? [{ configuration: { id: 1 }, status: 'approved', context: { buildId: 18 } }];
      if (path.includes('/build/builds?')) return changes.builds ?? [build()];
      if (path.includes('/threads?')) return changes.threads ?? [];
      if (path.includes('/statuses?')) return changes.statuses ?? [];
      if (path.includes('/iterations?')) return changes.iterations ?? [{ id: 2, createdDate: '2026-01-02' }];
      if (path.includes('/pullrequests?')) return changes.list ?? [raw];
      throw new Error(`Unexpected pages ${path}`);
    },
  };
  return { adapter: createAzure({ repository, client }), calls, raw };
}

test('Azure resolves cloud project/repository GUIDs, actual refs and fork provenance', async () => {
  const f = fixture({ raw: { forkSource: { repository: { id: 'source-id' } } } });
  const r = await f.adapter.resolveRepository();
  assert.equal(r.repositoryId, 'target-id');
  assert.equal(r.projectId, 'project-id');
  const pr = await f.adapter.getRequest(9);
  assert.equal(pr.sourceRepositoryId, 'source-id');
  assert.equal(pr.sourceSha, head);
  assert.equal(pr.targetSha, target);
  assert.ok(f.calls.some(c => c.path.startsWith('/org/_apis/git/repositories/source-id/refs?')));
  assert.throws(() => createAzure({ repository: { ...repository, host: 'server.example' }, client: {} }), /Services/);
});

test('Azure source resolution does not switch adapter target for fork creation', async () => {
  const f = fixture();
  await f.adapter.resolveRepository();
  await f.adapter.resolveRepository({ ...repository, repo: 'org/other/source', project: 'other', repoName: 'source', repositoryId: 'source-id' });
  await f.adapter.create({ sourceRepositoryId: 'source-id', targetRepositoryId: 'target-id', sourceRef: 'feature/a', targetRef: 'main',
    title: 'Exact title', description: 'Exact\nmultiline text', isDraft: true });
  const write = f.calls.find(c => c.method === 'POST');
  assert.match(write.path, /\/project\/_apis\/git\/repositories\/target-id\/pullrequests/);
  assert.equal(write.body.forkSource.repository.id, 'source-id');
  assert.equal(write.body.sourceRefName, 'refs/heads/feature/a');
  assert.equal(write.body.description, 'Exact\nmultiline text');
  assert.equal(write.body.isDraft, true);
});

test('Azure list/update/reply/resolve use explicit request identities without completion writes', async () => {
  const f = fixture();
  const list = await f.adapter.listOpen({ sourceRepositoryId: 'target-id', targetRepositoryId: 'target-id', sourceRef: 'feature/a', targetRef: 'main' });
  assert.equal(list.length, 1);
  await f.adapter.update(9, { title: 'Updated' });
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH').body, { title: 'Updated' });
  await f.adapter.reply(9, { body: 'Evidence\nreply' });
  assert.deepEqual(f.calls.filter(c => c.method === 'POST')[0].body, { comments: [{ content: 'Evidence\nreply', commentType: 1, parentCommentId: 0 }], status: 1 });
  await f.adapter.resolveThread(9, { threadId: 'thread:4', resolved: true });
  assert.deepEqual(f.calls.filter(c => c.method === 'PATCH').at(-1).body, { status: 2 });
  assert.ok(!f.calls.some(c => c.body?.status === 'completed'));
});

test('Azure current synthetic merge build and required policy evidence can pass', async () => {
  const f = fixture();
  const s = await f.adapter.collectSnapshot({ pr: 9, phase: 'open', expected: ['CI'] });
  assert.equal(s.sha, head);
  assert.equal(s.policyKnown, true);
  assert.equal(s.mergeStateStatus, 'CLEAN');
  assert.equal(s.checks[0].validationSha, synthetic);
  assert.equal(s.checks[0].sha, head);
  assert.equal(s.gates.find(g => g.id === 'policy:1').state, 'satisfied');
  assert.ok(f.calls.some(c => c.path.includes(encodeURIComponent('vstfs:///CodeReview/CodeReviewId/project-id/9'))));
});

test('Azure does not use stale PR merge metadata instead of current source and target refs', async () => {
  const f = fixture({ currentHead: merged });
  const s = await f.adapter.collectSnapshot({ pr: 9 });
  assert.equal(s.identity.sourceSha, merged);
  assert.equal(s.mergeStateStatus, 'UNKNOWN');
  assert.equal(s.checks.length, 0);
  assert.equal(s.gates.find(g => g.id === 'policy:1').state, 'pending');
  assert.equal(s.gates.find(g => g.id === 'revision-pair').state, 'pending');
});

test('Azure build policy cannot approve a synthetic build for another source/target pair', async () => {
  const f = fixture({ builds: [{ ...build(), sourceVersion: 'e'.repeat(40) }] });
  const s = await f.adapter.collectSnapshot({ pr: 9 });
  assert.equal(s.checks.length, 0);
  assert.equal(s.gates.find(g => g.id === 'policy:1').state, 'pending');
});

test('Azure unknown policy, missing evaluations and required reviewers remain unready', async () => {
  const unknown = await fixture({ fail: '/git/policy/configurations' }).adapter.collectSnapshot({ pr: 9 });
  assert.equal(unknown.policyKnown, false);
  assert.ok(unknown.gates.some(g => g.state === 'unknown'));
  const missing = await fixture({ evaluations: [] }).adapter.collectSnapshot({ pr: 9 });
  assert.equal(missing.gates.find(g => g.id === 'policy:1').state, 'pending');
  const unapproved = await fixture({ raw: { reviewers: [{ isRequired: true, vote: 0 }] } }).adapter.collectSnapshot({ pr: 9 });
  assert.equal(unapproved.reviewDecision, 'REVIEW_REQUIRED');
  const changes = await fixture({ raw: { reviewers: [{ vote: -10 }] } }).adapter.collectSnapshot({ pr: 9 });
  assert.equal(changes.reviewDecision, 'CHANGES_REQUESTED');
});

test('Azure statuses use current iterations; unproven legacy status applicability stays unknown', async () => {
  const f = fixture({ statuses: [
    { id: 1, context: { name: 'old' }, iterationId: 1, state: 'succeeded' },
    { id: 2, context: { name: 'current' }, iterationId: 2, state: 'pending' },
    { id: 3, context: { name: 'global-old' }, creationDate: '2026-01-01', state: 'succeeded' },
  ] });
  const s = await f.adapter.collectSnapshot({ pr: 9 });
  assert.ok(!s.checks.some(c => c.name === '/old' || c.name === '/global-old'));
  assert.equal(s.checks.find(c => c.name === '/current').state, 'pending');
  assert.equal(s.policyKnown, false);
});

test('Azure feedback threads preserve unresolved state and ignore deleted/system messages', async () => {
  const f = fixture({ threads: [
    { id: 1, status: 'active', comments: [{ id: 1, content: 'Issue', lastUpdatedDate: 'today' }, { id: 2, commentType: 'system' }] },
    { id: 2, status: 'fixed', comments: [{ id: 1, content: 'Fixed', lastUpdatedDate: 'today' }] },
    { id: 3, isDeleted: true, status: 'active' },
  ] });
  const s = await f.adapter.collectSnapshot({ pr: 9 });
  assert.deepEqual(s.threads.map(t => t.isResolved), [false, true]);
  assert.equal(s.feedback.length, 2);
});

test('Azure merged CI uses only actual merge commit on target branch and newest definition run', async () => {
  const targetBuild = { ...build(), sourceVersion: merged, sourceBranch: 'refs/heads/main', reason: 'individualCI' };
  const f = fixture({ raw: { status: 'completed', lastMergeCommit: { commitId: merged } }, builds: [targetBuild,
    { ...targetBuild, id: 19, result: 'failed' }, { ...targetBuild, id: 20, reason: 'pullRequest' },
    { ...targetBuild, id: 21, sourceVersion: head }, { ...targetBuild, id: 22, sourceBranch: 'refs/heads/other' }] });
  const s = await f.adapter.collectSnapshot({ pr: 9, phase: 'merged', expected: ['CI'] });
  assert.equal(s.sha, merged);
  assert.deepEqual(s.checks.map(c => [c.name, c.state]), [['CI', 'failure']]);
  await assert.rejects(fixture().adapter.collectSnapshot({ pr: 9, phase: 'merged' }), /confirmed/);
});

test('Azure observation rejects state/revision movement during the read', async () => {
  await assert.rejects(fixture({ moved: true }).adapter.collectSnapshot({ pr: 9 }), /moved/);
});
