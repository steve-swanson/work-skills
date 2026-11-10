import { collectGitHubSnapshot, gh } from './github-snapshot.mjs';

export function createGitHub({ repository, client, githubApi = gh }) {
  let target = repository;
  const path = () => `/repos/${target.repo}`;
  const normalize = r => ({ provider: 'github', host: 'github.com', repositoryId: String(r.base.repo.id), requestId: r.number,
    url: r.html_url, state: r.merged_at ? 'MERGED' : r.state === 'open' ? 'OPEN' : 'CLOSED',
    sourceRepositoryId: String(r.head.repo?.id ?? ''), targetRepositoryId: String(r.base.repo.id), sourceRef: r.head.ref,
    targetRef: r.base.ref, sourceSha: r.head.sha, targetSha: r.base.sha, mergeSha: r.merged_at ? r.merge_commit_sha : null,
    isDraft: r.draft === true, title: r.title, description: r.body ?? '' });
  const getRequest = async id => normalize(await client.request('GET', `${path()}/pulls/${Number(id)}`));
  async function verifyThread(id, threadId) {
      // Verify ownership through the current request before accepting a node ID.
      const [owner, name] = target.repo.split('/');
      let after = null, found = false;
      do {
        const data = await client.request('POST', '/graphql', { query: `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}}}}`,
          variables: { owner, name, number: Number(id), after } });
        const connection = data.data?.repository?.pullRequest?.reviewThreads;
        if (!connection) throw new Error('Cannot verify GitHub thread ownership.');
        found = connection.nodes.some(t => t.id === threadId);
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (after && !found);
      if (!found) throw new Error('Thread does not belong to the intended request.');
  }
  return {
    async resolveRepository(descriptor = target) {
      const r = await client.request('GET', `/repos/${descriptor.repo}`);
      if (!r.id || !r.full_name) throw new Error('Incomplete GitHub repository identity.');
      const resolved = { ...descriptor, repo: r.full_name, repositoryId: String(r.id), defaultBranch: r.default_branch, url: r.html_url };
      if (descriptor.repo.toLowerCase() === target.repo.toLowerCase()) target = resolved;
      return resolved;
    },
    getRequest,
    async merge(id, { headSha, strategy }) {
      if (strategy !== undefined && !['merge', 'squash', 'rebase'].includes(strategy)) throw new Error('Unsupported GitHub merge strategy.');
      const result = await client.request('PUT', `${path()}/pulls/${Number(id)}/merge`, { sha: headSha, ...(strategy ? { merge_method: strategy } : {}) });
      if (result.merged !== true) throw Object.assign(new Error('GitHub did not merge the request.'), { status: 405 });
      return result;
    },
    async listOpen(input) {
      const rows = await client.pages(`${path()}/pulls?state=open&base=${encodeURIComponent(input.targetRef)}&per_page=100`);
      return rows.map(normalize).filter(r => r.sourceRef === input.sourceRef && r.sourceRepositoryId === String(input.sourceRepositoryId)
        && r.targetRepositoryId === String(input.targetRepositoryId));
    },
    async create(input) {
      const owner = input.sourceRepository.repo.split('/')[0];
      return normalize(await client.request('POST', `${path()}/pulls`, { title: input.title, body: input.description,
        head: `${owner}:${input.sourceRef}`, head_repo: input.sourceRepository.repo.split('/')[1], base: input.targetRef, draft: input.isDraft === true }));
    },
    async update(id, input) {
      return normalize(await client.request('PATCH', `${path()}/pulls/${Number(id)}`, { ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { body: input.description } : {}) }));
    },
    async reply(id, { body, threadId }) {
      if (!threadId) return client.request('POST', `${path()}/issues/${Number(id)}/comments`, { body });
      await verifyThread(id, threadId);
      return client.request('POST', '/graphql', { query: 'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}',
        variables: { id: threadId, body } });
    },
    async resolveThread(id, { threadId, resolved = true }) {
      await verifyThread(id, threadId);
      const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
      return client.request('POST', '/graphql', { query: `mutation($id:ID!){${operation}(input:{threadId:$id}){thread{id isResolved}}}`, variables: { id: threadId } });
    },
    async collectSnapshot(options) {
      const id = options.requestId ?? options.pr;
      const initial = await getRequest(id);
      const snapshot = await collectGitHubSnapshot({ ...options, repo: target.repo, pr: id }, githubApi);
      const identity = await getRequest(id);
      if (identity.sourceSha !== snapshot.headRefOid || identity.targetRef !== snapshot.baseRefName || identity.state !== snapshot.state
        || ['sourceSha', 'targetSha', 'sourceRef', 'targetRef', 'sourceRepositoryId', 'targetRepositoryId', 'state', 'mergeSha'].some(k => identity[k] !== initial[k])) {
        throw new Error('GitHub request moved during observation.');
      }
      return { ...snapshot, identity };
    },
  };
}
