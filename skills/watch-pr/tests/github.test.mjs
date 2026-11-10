import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../lib/providers/github.mjs';
import { parseRepository } from '../lib/identity.mjs';

test('GitHub request operations preserve fork source, multiline text, target closure, and native thread IDs', async () => {
  const calls = [], raw = { number: 5, html_url: 'https://github.com/target/repo/pull/5', state: 'open', title: 'Feature', body: 'line1\nline2',
    head: { ref: 'feature', sha: 'a'.repeat(40), repo: { id: 1 } }, base: { ref: 'develop', sha: 'b'.repeat(40), repo: { id: 2 } } };
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/repos/target/repo') return { id: 2, full_name: 'target/repo', html_url: 'https://github.com/target/repo' };
      if (method === 'GET' && path === '/repos/fork/repo') return { id: 1, full_name: 'fork/repo', html_url: 'https://github.com/fork/repo' };
      if (path === '/graphql' && body.query.startsWith('query')) return { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'THREAD_NODE' }], pageInfo: { hasNextPage: false } } } } } };
      if (path === '/graphql') return { data: {} };
      return raw;
    },
    async pages() { return [raw]; },
  };
  const adapter = createGitHub({ repository: parseRepository('https://github.com/target/repo'), client });
  const targetRepository = await adapter.resolveRepository(), sourceRepository = await adapter.resolveRepository(parseRepository('https://github.com/fork/repo'));
  const input = { sourceRepository, targetRepository, sourceRepositoryId: '1', targetRepositoryId: '2', sourceRef: 'feature', targetRef: 'develop', title: 'Feature', description: 'line1\nline2' };
  assert.equal((await adapter.listOpen(input)).length, 1);
  assert.equal((await adapter.create(input)).sourceRepositoryId, '1');
  assert.deepEqual(calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls')).body,
    { title: 'Feature', body: 'line1\nline2', head: 'fork:feature', head_repo: 'repo', base: 'develop', draft: false });
  await adapter.reply(5, { body: 'Fix proof', threadId: 'THREAD_NODE' });
  assert.ok(calls.some(c => c.body?.query?.includes('addPullRequestReviewThreadReply') && c.body.variables.id === 'THREAD_NODE'));
  await adapter.resolveThread(5, { threadId: 'THREAD_NODE', resolved: true });
  assert.ok(calls.some(c => c.body?.query?.includes('mutation') && c.body.query.includes('resolveReviewThread')));
  await assert.rejects(adapter.resolveThread(5, { threadId: 'WRONG_NODE' }), /does not belong/);
});

test('GitHub target movement during observation invalidates green source checks', async () => {
  let reads = 0;
  const source = 'a'.repeat(40);
  const adapter = createGitHub({ repository: parseRepository('https://github.com/o/r'), client: { async request() {
    return { number: 5, html_url: 'https://github.com/o/r/pull/5', state: 'open', head: { ref: 'feat', sha: source, repo: { id: 1 } },
      base: { ref: 'main', sha: (++reads === 1 ? 'b' : 'c').repeat(40), repo: { id: 1 } } };
  } }, githubApi: async args => {
    if (args[0] === 'pr') return { state: 'OPEN', headRefOid: source, baseRefName: 'main', mergeCommit: null };
    const endpoint = args.at(-1);
    if (endpoint.includes('/check-runs?')) return [{ check_runs: [] }];
    if (endpoint.includes('/statuses?')) return [[]];
    if (endpoint.includes('/rules/branches')) return [[]];
    if (endpoint.endsWith('/protection')) return {};
    if (args.includes('graphql')) {
      const q = args.find(x => x.startsWith('query='));
      const field = ['reviewThreads', 'comments', 'reviews'].find(f => q.includes(`${f}(`));
      return { data: { repository: { pullRequest: { [field]: { nodes: [], pageInfo: {} } } } } };
    }
    return { protected: false };
  } });
  await assert.rejects(adapter.collectSnapshot({ requestId: 5, phase: 'open', expected: [] }), /moved/);
});
