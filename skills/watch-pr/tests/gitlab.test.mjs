import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitLab } from '../lib/providers/gitlab.mjs';

const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40), syntheticSha = 'd'.repeat(40);
const repository = { provider: 'gitlab', host: 'gitlab.com', repo: 'group/sub/project', url: 'https://gitlab.com/group/sub/project' };
const rawMR = { iid: 42, source_project_id: 12, target_project_id: 10, source_branch: 'feature/a', target_branch: 'main',
  sha: sourceSha, state: 'opened', web_url: 'https://gitlab.com/group/sub/project/-/merge_requests/42', title: 'Fix editor',
  description: 'Line one\n\nLine two', draft: false, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true,
  head_pipeline: { id: 50, project_id: 12 } };

function fixture(overrides = {}) {
  const calls = [], mr = { ...rawMR, ...overrides.mr };
  let reads = 0;
  const settings = { id: 10, path_with_namespace: 'group/sub/project', web_url: repository.url, default_branch: 'main',
    only_allow_merge_if_pipeline_succeeds: true, allow_merge_on_skipped_pipeline: false, ...overrides.settings };
  const pipeline = { id: 50, project_id: 12, name: 'CI', sha: sourceSha, ref: 'feature/a', source: 'merge_request_event', status: 'success', web_url: 'https://gitlab.com/pipeline/50', ...overrides.pipeline };
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/projects/group%2Fsub%2Fproject') return settings;
      if (method === 'GET' && path === '/projects/10') return settings;
      if (method === 'GET' && path === '/projects/10/merge_requests/42') return { ...mr, ...(++reads > 1 ? overrides.finalMR : {}) };
      if (method === 'GET' && path === '/projects/10/repository/branches/main') return { commit: { id: overrides.finalTarget && reads > 1 ? overrides.finalTarget : targetSha } };
      if (path.endsWith('/approval_state')) {
        if (overrides.approvalError) throw overrides.approvalError;
        return overrides.approvals ?? { rules: [{ id: 1, approvals_required: 1, approved: true }] };
      }
      if (/\/pipelines\/50$/.test(path)) return pipeline;
      if (/\/repository\/commits\//.test(path)) return { id: syntheticSha, parent_ids: overrides.parents ?? [sourceSha, targetSha] };
      if (method === 'POST' && path === '/projects/12/merge_requests') return mr;
      if (method === 'PUT' && path === '/projects/10/merge_requests/42') return { ...mr, title: body.title ?? mr.title, description: body.description ?? mr.description };
      if (method !== 'GET' && /\/notes$|\/discussions\/thread$/.test(path)) return { id: 99, ...body };
      throw new Error(`Unexpected request ${method} ${path}`);
    },
    async pages(path) {
      calls.push({ method: 'PAGES', path });
      if (path.includes('/jobs?')) return overrides.jobs ?? [{ name: 'test', status: 'success', allow_failure: false }];
      if (path.includes('/discussions?')) return overrides.discussions ?? [];
      if (path.startsWith('/projects/10/pipelines?')) return overrides.postPipelines ?? [{ ...pipeline, project_id: 10 }];
      if (path.endsWith('/pipelines?per_page=100')) return overrides.mrPipelines ?? [pipeline];
      if (path.includes('/merge_requests?')) return overrides.list ?? [mr];
      throw new Error(`Unexpected page ${path}`);
    },
  };
  const adapter = createGitLab({ repository, client });
  return { adapter, client, calls, mr, pipeline };
}

test('GitLab resolves subgroup repository IDs and preserves fork identities and multiline creation input', async () => {
  const f = fixture();
  const resolved = await f.adapter.resolveRepository();
  assert.equal(resolved.repositoryId, '10');
  const existing = await f.adapter.listOpen({ sourceRepositoryId: '12', targetRepositoryId: '10', sourceRef: 'feature/a', targetRef: 'main' });
  assert.equal(existing[0].sourceRepositoryId, '12');
  const created = await f.adapter.create({ sourceRepositoryId: '12', targetRepositoryId: '10', sourceRef: 'feature/a', targetRef: 'main', title: 'Fix editor', description: 'one\n\ntwo', isDraft: true });
  assert.equal(created.repositoryId, '10');
  const write = f.calls.find(c => c.method === 'POST');
  assert.equal(write.path, '/projects/12/merge_requests');
  assert.equal(write.body.target_project_id, 10);
  assert.equal(write.body.description, 'one\n\ntwo');
  assert.equal(write.body.title, 'Draft: Fix editor');
  const updated = await f.adapter.update(42, { title: 'Updated', description: 'other\nbody', isDraft: false });
  assert.equal(updated.title, 'Updated');
});

test('GitLab only lists exact open source/target matches and replies/resolves through explicit endpoints', async () => {
  const f = fixture({ list: [rawMR, { ...rawMR, source_project_id: 99 }, { ...rawMR, target_branch: 'other' }] });
  assert.equal((await f.adapter.listOpen({ sourceRepositoryId: '12', targetRepositoryId: '10', sourceRef: 'feature/a', targetRef: 'main' })).length, 1);
  await f.adapter.reply(42, { body: 'fixed\nproof', threadId: 'thread' });
  await f.adapter.resolveThread(42, { threadId: 'thread', resolved: true });
  assert.ok(f.calls.some(c => c.path.endsWith('/discussions/thread/notes') && c.body.body === 'fixed\nproof'));
  assert.ok(f.calls.some(c => c.method === 'PUT' && c.path.endsWith('/discussions/thread') && c.body.resolved));
});

test('GitLab open snapshot includes approvals, pipeline/job results, and feedback without saving note bodies', async () => {
  const f = fixture({ discussions: [{ id: 'thread', notes: [{ id: 1, body: 'PRIVATE', resolvable: true, resolved: false, updated_at: 'now' }] }] });
  const s = await f.adapter.collectSnapshot({ pr: 42, phase: 'open', expected: ['test'] });
  assert.equal(s.sha, sourceSha);
  assert.equal(s.policyKnown, true);
  assert.equal(s.reviewDecision, 'APPROVED');
  assert.equal(s.threads[0].isResolved, false);
  assert.equal(s.checks.find(c => c.name === 'test').state, 'success');
  assert.doesNotMatch(JSON.stringify(s), /PRIVATE/);
});

test('GitLab missing or unreadable approval rules stay unknown, while explicit no-rules is not applicable', async () => {
  for (const extra of [{ approvalError: Object.assign(new Error('not found'), { status: 404 }) }, { approvals: {} }]) {
    const s = await fixture(extra).adapter.collectSnapshot({ pr: 42 });
    assert.equal(s.policyKnown, false);
    assert.equal(s.gates.find(g => g.id === 'approvals').state, 'unknown');
  }
  const s = await fixture({ approvals: { rules: [] } }).adapter.collectSnapshot({ pr: 42 });
  assert.equal(s.gates.find(g => g.id === 'approvals').state, 'not_applicable');
  assert.equal((await fixture({ approvals: { rules: [{ approvals_required: 1, approved: false }] } }).adapter.collectSnapshot({ pr: 42 })).reviewDecision, 'REVIEW_REQUIRED');
});

test('GitLab distinguishes optional failed/manual jobs from blocking jobs and skipped pipeline policy', async () => {
  const s = await fixture({ jobs: [{ name: 'optional', status: 'failed', allow_failure: true },
    { name: 'manual optional', status: 'manual', allow_failure: true }, { name: 'manual required', status: 'manual', allow_failure: false }] }).adapter.collectSnapshot({ pr: 42 });
  assert.equal(s.checks.find(c => c.name === 'optional').state, 'skipped');
  assert.equal(s.checks.find(c => c.name === 'manual optional').state, 'skipped');
  assert.equal(s.checks.find(c => c.name === 'manual required').state, 'pending');
  assert.equal((await fixture({ pipeline: { status: 'skipped' } }).adapter.collectSnapshot({ pr: 42 })).checks[0].state, 'pending');
  assert.equal((await fixture({ pipeline: { status: 'skipped' }, settings: { allow_merge_on_skipped_pipeline: true } }).adapter.collectSnapshot({ pr: 42 })).checks[0].state, 'skipped');
});

test('GitLab refuses stale pipeline SHA and proves synthetic merge parents against both current revisions', async () => {
  const stale = await fixture({ pipeline: { sha: 'e'.repeat(40) } }).adapter.collectSnapshot({ pr: 42 });
  assert.equal(stale.checks.length, 0);
  assert.equal(stale.gates.find(g => g.id === 'pipeline_revision').state, 'pending');
  const valid = await fixture({ pipeline: { sha: syntheticSha, ref: 'refs/merge-requests/42/merge' } }).adapter.collectSnapshot({ pr: 42 });
  assert.equal(valid.checks[0].sha, syntheticSha);
  const wrongTarget = await fixture({ pipeline: { sha: syntheticSha, ref: 'refs/merge-requests/42/merge' }, parents: [sourceSha, 'f'.repeat(40)] }).adapter.collectSnapshot({ pr: 42 });
  assert.equal(wrongTarget.checks.length, 0);
});

test('GitLab rereads the source and target revisions before accepting a snapshot', async () => {
  await assert.rejects(fixture({ finalMR: { sha: mergeSha } }).adapter.collectSnapshot({ pr: 42 }), /moved/);
  await assert.rejects(fixture({ finalTarget: mergeSha }).adapter.collectSnapshot({ pr: 42 }), /moved/);
  await assert.rejects(fixture({ finalMR: { detailed_merge_status: 'not_approved' } }).adapter.collectSnapshot({ pr: 42 }), /moved/);
  await assert.rejects(fixture({ finalMR: { head_pipeline: { id: 51, project_id: 12 } } }).adapter.collectSnapshot({ pr: 42 }), /moved/);
});

test('GitLab merged phase requires the actual merge commit and target-ref non-MR pipelines', async () => {
  const f = fixture({ mr: { state: 'merged', merge_commit_sha: mergeSha }, pipeline: { project_id: 10, sha: mergeSha, ref: 'main', source: 'push' } });
  const s = await f.adapter.collectSnapshot({ pr: 42, phase: 'merged', expected: ['CI'] });
  assert.equal(s.sha, mergeSha);
  assert.equal(s.checks[0].state, 'success');
  assert.ok(f.calls.some(c => c.path.includes(`sha=${mergeSha}&ref=main`)));
  const oldPR = fixture({ mr: { state: 'merged', merge_commit_sha: mergeSha }, pipeline: { sha: mergeSha, ref: 'main', source: 'merge_request_event' } });
  assert.equal((await oldPR.adapter.collectSnapshot({ pr: 42, phase: 'merged' })).checks.length, 0);
  await assert.rejects(fixture().adapter.collectSnapshot({ pr: 42, phase: 'merged' }), /confirmed merge/);
});

test('GitLab does not confuse squash SHA alone with confirmed target merge SHA or silently accept unknown merge rules', async () => {
  await assert.rejects(fixture({ mr: { state: 'merged', merge_commit_sha: null, squash_commit_sha: mergeSha } }).adapter.collectSnapshot({ pr: 42, phase: 'merged' }), /confirmed merge/);
  const s = await fixture({ mr: { detailed_merge_status: 'new_unknown_policy' } }).adapter.collectSnapshot({ pr: 42 });
  assert.equal(s.policyKnown, false);
  assert.equal(s.mergeStateStatus, 'UNKNOWN');
  assert.throws(() => createGitLab({ repository: { ...repository, host: 'gitlab.example.com' }, client: {} }), /GitLab.com/);
});
