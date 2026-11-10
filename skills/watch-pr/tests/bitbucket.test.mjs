import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitbucket } from '../lib/providers/bitbucket.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40);
const repository = { provider: 'bitbucket', host: 'bitbucket.org', repo: 'team/project', repositoryId: '{target}' };
const request = () => ({ id: 7, state: 'OPEN', title: 'Feature', description: 'Line one\nLine two', draft: false,
  source: { repository: { uuid: '{source}', full_name: 'fork/project' }, branch: { name: 'feature/a' }, commit: { hash: head } },
  destination: { repository: { uuid: '{target}', full_name: 'team/project' }, branch: { name: 'main' }, commit: { hash: base } },
  author: { uuid: '{author}' }, participants: [{ approved: true, user: { uuid: '{reviewer}' } }],
  links: { html: { href: 'https://bitbucket.org/team/project/pull-requests/7' } } });

function fixture(changes = {}) {
  const raw = { ...request(), ...changes.raw }, calls = [];
  let reads = 0;
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path === '/repositories/team/project') return { uuid: '{target}', full_name: 'team/project', mainbranch: { name: 'main' } };
      if (path.endsWith('/branching-model')) {
        if (!changes.branchingModel) throw Error('unavailable');
        return changes.branchingModel;
      }
      if (path.includes('/pullrequests/7/comments') || path.endsWith('/resolve')) return { id: 11 };
      if (path === '/repositories/team/project/pullrequests' && method === 'POST') return { ...raw, title: body.title, description: body.description, draft: body.draft };
      if (path.endsWith('/pullrequests/7')) {
        if (method === 'PUT') return { ...raw, ...body };
        reads++;
        return reads > 1 && changes.moved ? { ...raw, source: { ...raw.source, commit: { hash: merge } } } : raw;
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    },
    async pages(path, field) {
      calls.push({ method: 'PAGES', path, field });
      if (changes.fail && path.includes(changes.fail)) throw Error('denied');
      if (path.includes('/pullrequests?q=')) return changes.list ?? [raw];
      if (path.includes('/branch-restrictions')) return changes.rules ?? [{ id: 1, kind: 'require_approvals_to_merge', pattern: 'main', branch_match_kind: 'glob', value: 1 }];
      if (path.includes('/mergeability/checks')) return changes.mergeability ?? [{ type: 'git_mergeability_check', status: 'PASSED', required: true }];
      if (path.includes('/comments')) return changes.comments ?? [];
      if (path.includes('/tasks')) return changes.tasks ?? [];
      if (path.includes('/statuses')) return changes.statuses ?? [{ key: 'CI', name: 'CI', state: 'SUCCESSFUL', updated_on: '2026-01-01' }];
      if (path.includes('/pipelines/')) return changes.pipelines ?? [];
      if (path.includes('/effective-default-reviewers')) return changes.defaultReviewers ?? [];
      throw new Error(`Unexpected pages ${path}`);
    },
  };
  return { adapter: createBitbucket({ repository, client }), calls, raw };
}

test('Bitbucket resolves authoritative repository identity and preserves fork source IDs', async () => {
  const f = fixture();
  const repo = await f.adapter.resolveRepository();
  assert.equal(repo.repositoryId, '{target}');
  assert.equal(repo.defaultBranch, 'main');
  const pr = await f.adapter.getRequest(7);
  assert.equal(pr.sourceRepositoryId, '{source}');
  assert.equal(pr.targetRepositoryId, '{target}');
  assert.equal(pr.sourceSha, head);
  assert.equal(pr.url, 'https://bitbucket.org/team/project/pull-requests/7');
  assert.throws(() => createBitbucket({ repository: { ...repository, host: 'internal.example' }, client: {} }), /Cloud/);
});

test('Bitbucket list/create/update pin both repositories and refs without merging or branch deletion', async () => {
  const f = fixture({ list: [request(), { ...request(), source: { ...request().source, repository: { uuid: '{wrong}' } } }] });
  const input = { sourceRepositoryId: '{source}', targetRepositoryId: '{target}', sourceRef: 'feature/a', targetRef: 'main',
    title: 'New title', description: 'Exact\nmultiline text', isDraft: true };
  assert.equal((await f.adapter.listOpen(input)).length, 1);
  const result = await f.adapter.create(input);
  assert.equal(result.description, input.description);
  assert.equal(result.isDraft, true);
  const body = f.calls.find(c => c.method === 'POST').body;
  assert.equal(body.source.repository.uuid, '{source}');
  assert.equal(body.destination.branch.name, 'main');
  assert.equal(body.close_source_branch, false);
  await f.adapter.update(7, { title: 'Updated' });
  assert.deepEqual(f.calls.find(c => c.method === 'PUT').body, { title: 'Updated' });
  assert.ok(!f.calls.some(c => c.path.endsWith('/merge')));
});

test('Bitbucket replies and resolves only the specified native comment', async () => {
  const f = fixture();
  await f.adapter.reply(7, { body: 'Evidence\nreply', threadId: 'comment:11' });
  assert.deepEqual(f.calls[0].body, { content: { raw: 'Evidence\nreply' }, parent: { id: 11 } });
  await f.adapter.resolveThread(7, { threadId: 'comment:11', resolved: true });
  assert.equal(f.calls[1].path, '/repositories/team/project/pullrequests/7/comments/11/resolve');
  await assert.rejects(f.adapter.resolveThread(7, { threadId: '../wrong' }), /numeric/);
});

test('Bitbucket snapshots evaluate native mergeability and approvals against source-fork commit statuses', async () => {
  const f = fixture();
  const s = await f.adapter.collectSnapshot({ pr: 7, phase: 'open', expected: ['CI'] });
  assert.equal(s.policyKnown, true);
  assert.equal(s.mergeStateStatus, 'CLEAN');
  assert.equal(s.reviewDecision, 'APPROVED');
  assert.equal(s.checks[0].sha, head);
  assert.ok(f.calls.some(c => c.path.includes(`/repositories/fork/project/commit/${head}/statuses`)));
  assert.ok(s.gates.every(g => g.state === 'satisfied'));
});

test('Bitbucket requested changes, insufficient approvals, tasks and unresolved native comments remain blocking', async () => {
  const f = fixture({ raw: { participants: [{ approved: false, state: 'changes_requested' }] },
    rules: [{ id: 1, kind: 'require_approvals_to_merge', pattern: 'main', value: 1 }, { id: 2, kind: 'require_tasks_to_be_completed', pattern: 'main' }],
    tasks: [{ id: 4, state: 'OPEN' }], comments: [{ id: 11, resolution: null, updated_on: 'today' }, { id: 12, content: { raw: 'Ordinary discussion' } }] });
  const s = await f.adapter.collectSnapshot({ pr: 7 });
  assert.equal(s.reviewDecision, 'CHANGES_REQUESTED');
  assert.ok(s.gates.some(g => g.id === 'restriction:1' && g.state === 'pending'));
  assert.ok(s.gates.some(g => g.id === 'restriction:2' && g.state === 'failed'));
  assert.deepEqual(s.threads.map(t => t.id), ['comment:11']);
  assert.equal(s.threads[0].isResolved, false);
  assert.equal(s.feedback.length, 3);
});

test('Bitbucket unavailable policy and unknown applicability never become passing', async () => {
  for (const changes of [{ fail: 'branch-restrictions' }, { mergeability: [] },
    { rules: [{ id: 3, kind: 'require_approvals_to_merge', branch_match_kind: 'branching_model', branch_type: 'production' }] },
    { rules: [{ id: 4, kind: 'require_all_dependencies_merged', pattern: 'main' }] }]) {
    const s = await fixture(changes).adapter.collectSnapshot({ pr: 7 });
    assert.equal(s.policyKnown, false);
    assert.ok(s.gates.some(g => g.state === 'unknown'));
  }
});

test('Bitbucket branching-model and effective default-reviewer requirements use actual applicable policy', async () => {
  const f = fixture({ branchingModel: { production: { name: 'main' } }, defaultReviewers: [{ uuid: '{reviewer}' }],
    rules: [{ id: 5, kind: 'require_default_reviewer_approvals_to_merge', branch_match_kind: 'branching_model', branch_type: 'production', value: 1 }] });
  const s = await f.adapter.collectSnapshot({ pr: 7 });
  assert.equal(s.policyKnown, true);
  assert.equal(s.gates.find(g => g.id === 'restriction:5').state, 'satisfied');
  const unknown = await fixture({ rules: [{ id: 1, kind: 'require_approvals_to_merge', pattern: 'main' }] }).adapter.collectSnapshot({ pr: 7 });
  assert.equal(unknown.policyKnown, false);
});

test('Bitbucket native advisory failures do not invent a blocking policy', async () => {
  const s = await fixture({ mergeability: [{ type: 'git_mergeability_check', status: 'PASSED' },
    { type: 'custom_pre_merge_check', id: 9, status: 'FAILED', required: false, blocking: false }] }).adapter.collectSnapshot({ pr: 7 });
  assert.equal(s.gates.find(g => g.id.startsWith('mergeability:9')).state, 'not_applicable');
});

test('Bitbucket rejects observations that move mid-read', async () => {
  await assert.rejects(fixture({ moved: true }).adapter.collectSnapshot({ pr: 7 }), /moved/);
});

test('Bitbucket merged CI only accepts actual merge SHA/ref pipelines and newest rerun', async () => {
  const pipeline = { build_number: 10, target: { type: 'pipeline_ref_target', ref_name: 'main', commit: { hash: merge }, selector: { type: 'default' } },
    state: { name: 'COMPLETED', result: { name: 'FAILED' } } };
  const f = fixture({ raw: { state: 'MERGED', merge_commit: { hash: merge } }, pipelines: [pipeline,
    { ...pipeline, build_number: 11, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } },
    { ...pipeline, build_number: 12, target: { ...pipeline.target, type: 'pipeline_pullrequest_target' } },
    { ...pipeline, build_number: 13, target: { ...pipeline.target, commit: { hash: head } } }] });
  const s = await f.adapter.collectSnapshot({ pr: 7, phase: 'merged', expected: ['default'] });
  assert.equal(s.sha, merge);
  assert.deepEqual(s.checks.map(c => [c.name, c.state]), [['default', 'success']]);
  assert.ok(f.calls.some(c => c.path.includes(encodeURIComponent(merge))));
  await assert.rejects(fixture().adapter.collectSnapshot({ pr: 7, phase: 'merged' }), /confirmed/);
});
