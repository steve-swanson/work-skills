// Azure DevOps Services adapter. No credentials or agent/Git operations here.
const enc = encodeURIComponent;
const short = value => value?.replace(/^refs\/heads\//, '');
const full = value => value?.startsWith('refs/') ? value : `refs/heads/${value}`;
const version = 'api-version=7.1';
const gate = (id, state, reason) => ({ id, state, ...(reason ? { reason } : {}) });
const statusOf = state => ({ succeeded: 'success', failed: 'failure', error: 'failure', canceled: 'failure',
  partiallySucceeded: 'failure', pending: 'pending', notStarted: 'pending', inProgress: 'pending',
  notApplicable: 'skipped' }[state] ?? 'pending');
const policyState = state => ({ approved: 'satisfied', rejected: 'failed', running: 'pending', queued: 'pending',
  notApplicable: 'not_applicable', broken: 'unknown' }[state] ?? 'unknown');
const buildPolicy = '0609b952-1397-4640-95ec-e00a01b2c241';

export function createAzure({ repository, client }) {
  if (repository.provider !== 'azure' || repository.host !== 'dev.azure.com') throw new Error('Only Azure DevOps Services is supported.');
  const parts = repository.repo.split('/');
  const organization = repository.organization ?? parts[0], project = repository.project ?? parts[1], repoName = repository.repoName ?? parts[2];
  const projectBase = `/${enc(organization)}/${enc(project)}/_apis`;
  let resolved = repository;
  const base = () => `${projectBase}/git/repositories/${enc(resolved.repositoryId ?? repoName)}`;
  const prPath = id => `${base()}/pullrequests/${enc(id)}`;
  const rawRequest = id => client.request('GET', `${prPath(id)}?${version}`);
  const normalize = raw => ({ provider: 'azure', host: 'dev.azure.com',
    repositoryId: String(raw.repository?.id ?? resolved.repositoryId ?? ''), requestId: String(raw.pullRequestId),
    url: raw._links?.web?.href ?? `https://dev.azure.com/${enc(organization)}/${enc(project)}/_git/${enc(raw.repository?.name ?? repoName)}/pullrequest/${raw.pullRequestId}`,
    state: raw.status === 'completed' ? 'MERGED' : raw.status === 'active' ? 'OPEN' : 'CLOSED',
    sourceRepositoryId: String(raw.forkSource?.repository?.id ?? raw.repository?.id ?? ''),
    targetRepositoryId: String(raw.repository?.id ?? resolved.repositoryId ?? ''),
    sourceRef: short(raw.sourceRefName), targetRef: short(raw.targetRefName),
    sourceSha: raw.lastMergeSourceCommit?.commitId, targetSha: raw.lastMergeTargetCommit?.commitId,
    mergeSha: raw.status === 'completed' ? raw.lastMergeCommit?.commitId : undefined,
    isDraft: raw.isDraft === true, title: raw.title, description: raw.description ?? '' });
  const optionalPages = async (path, field = 'value') => {
    try { return { items: await client.pages(path, field), known: true }; }
    catch (error) { if (error.transient) throw error; return { items: [], known: false }; }
  };
  async function resolveRepository(descriptor = repository) {
    const p = descriptor.repo.split('/');
    const root = `/${enc(descriptor.organization ?? p[0])}/${enc(descriptor.project ?? p[1])}/_apis/git/repositories/${enc(descriptor.repositoryId ?? descriptor.repoName ?? p[2])}`;
    const raw = await client.request('GET', `${root}?${version}`);
    if (!raw.id || !raw.project?.id || !raw.name) throw new Error('Azure repository/project identity is incomplete.');
    const result = { ...descriptor, provider: 'azure', host: 'dev.azure.com', repositoryId: String(raw.id), projectId: String(raw.project.id),
      organization: descriptor.organization ?? p[0], project: raw.project.name ?? descriptor.project ?? p[1], repoName: raw.name,
      repo: `${descriptor.organization ?? p[0]}/${raw.project.name ?? p[1]}/${raw.name}`, defaultBranch: short(raw.defaultBranch),
      url: raw.webUrl ?? `https://dev.azure.com/${enc(descriptor.organization ?? p[0])}/${enc(raw.project.name ?? p[1])}/_git/${enc(raw.name)}` };
    if (descriptor === repository) resolved = result;
    return result;
  }
  async function currentIdentity(raw) {
    const identity = normalize(raw);
    if (identity.state !== 'OPEN') return identity;
    // Repository GUIDs are organization-wide; omitting project also covers a
    // fork whose source repository belongs to another project.
    const sourceBase = `/${enc(organization)}/_apis/git/repositories/${enc(identity.sourceRepositoryId)}`;
    const [source, target] = await Promise.all([
      client.pages(`${sourceBase}/refs?filter=${enc(`heads/${identity.sourceRef}`)}&${version}`, 'value'),
      client.pages(`${base()}/refs?filter=${enc(`heads/${identity.targetRef}`)}&${version}`, 'value'),
    ]);
    const sourceSha = source.find(r => r.name === full(identity.sourceRef))?.objectId;
    const targetSha = target.find(r => r.name === full(identity.targetRef))?.objectId;
    if (!sourceSha || !targetSha) throw new Error('Azure current source/target refs are unavailable.');
    return { ...identity, sourceSha, targetSha };
  }
  async function getRequest(id) { return currentIdentity(await rawRequest(id)); }
  async function listOpen(input) {
    const query = `searchCriteria.status=active&searchCriteria.sourceRefName=${enc(full(input.sourceRef))}&searchCriteria.targetRefName=${enc(full(input.targetRef))}`;
    const raw = await client.pages(`${base()}/pullrequests?${query}&${version}`, 'value');
    const normalized = await Promise.all(raw.map(currentIdentity));
    return normalized.filter(r => r.state === 'OPEN' && r.sourceRef === short(input.sourceRef) && r.targetRef === short(input.targetRef)
      && (!input.sourceRepositoryId || r.sourceRepositoryId === input.sourceRepositoryId)
      && (!input.targetRepositoryId || r.targetRepositoryId === input.targetRepositoryId));
  }
  async function create(input) {
    const body = { sourceRefName: full(input.sourceRef), targetRefName: full(input.targetRef), title: input.title,
      description: input.description, isDraft: input.isDraft === true };
    if (input.sourceRepositoryId !== input.targetRepositoryId) body.forkSource = { repository: { id: input.sourceRepositoryId }, name: full(input.sourceRef) };
    return currentIdentity(await client.request('POST', `${base()}/pullrequests?${version}`, body));
  }
  async function update(id, input) {
    const body = {};
    for (const [key, value] of Object.entries({ title: input.title, description: input.description, isDraft: input.isDraft })) if (value !== undefined) body[key] = value;
    return currentIdentity(await client.request('PATCH', `${prPath(id)}?${version}`, body));
  }
  async function reply(id, input) {
    const comment = { content: input.body, commentType: 1, parentCommentId: 0 };
    const thread = input.threadId ? String(input.threadId).replace(/^thread:/, '') : undefined;
    if (thread !== undefined && !/^\d+$/.test(thread)) throw new Error('Azure thread ID must be numeric.');
    return input.threadId
      ? client.request('POST', `${prPath(id)}/threads/${thread}/comments?${version}`, comment)
      : client.request('POST', `${prPath(id)}/threads?${version}`, { comments: [comment], status: 1 });
  }
  async function merge(id, { headSha, strategy }) {
    const strategies = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' };
    if (strategy !== undefined && !Object.hasOwn(strategies, strategy)) throw new Error('Unsupported Azure merge strategy.');
    return client.request('PATCH', `${prPath(id)}?${version}`, { status: 'completed', lastMergeSourceCommit: { commitId: headSha },
      completionOptions: { deleteSourceBranch: false, bypassPolicy: false, ...(strategy ? { mergeStrategy: strategies[strategy] } : {}) } });
  }
  async function resolveThread(id, input) {
    const thread = String(input.threadId).replace(/^thread:/, '');
    if (!/^\d+$/.test(thread)) throw new Error('Azure thread ID must be numeric.');
    return client.request('PATCH', `${prPath(id)}/threads/${thread}?${version}`, { status: input.resolved === false ? 1 : 2 });
  }
  const validBuild = (build, raw, identity) => {
    if (build.repository?.id && build.repository.id !== identity.targetRepositoryId && build.repository.id !== identity.sourceRepositoryId) return false;
    if (build.sourceVersion === identity.sourceSha && build.sourceBranch === full(identity.sourceRef)) return true;
    return build.sourceVersion === raw.lastMergeCommit?.commitId && raw.lastMergeSourceCommit?.commitId === identity.sourceSha
      && raw.lastMergeTargetCommit?.commitId === identity.targetSha && build.sourceBranch === `refs/pull/${identity.requestId}/merge`;
  };

  async function collectSnapshot(options) {
    if (!resolved.projectId || !resolved.repositoryId) await resolveRepository();
    const id = options.requestId ?? options.pr ?? repository.requestId;
    const raw = await rawRequest(id), identity = await currentIdentity(raw), phase = options.phase ?? 'open';
    const sha = phase === 'merged' ? identity.mergeSha : identity.sourceSha;
    if (phase === 'merged' && (identity.state !== 'MERGED' || !sha)) throw new Error('Azure has not confirmed the completed merge commit.');
    if (!sha) throw new Error('Azure revision is unavailable.');
    const gates = [], checks = [], threads = [], feedback = [];
    let policyKnown = true, reviewDecision = 'APPROVED';
    let mergeStateStatus = raw.mergeStatus === 'succeeded' ? 'CLEAN' : raw.mergeStatus === 'conflicts' ? 'DIRTY' : 'UNKNOWN';
    const buildsResult = await optionalPages(`${projectBase}/build/builds?repositoryId=${enc(identity.targetRepositoryId)}&repositoryType=TfsGit&queryOrder=queueTimeDescending&${version}`);
    if (!buildsResult.known) { policyKnown = false; gates.push(gate('builds', 'unknown', 'Build validation is unavailable.')); }
    const builds = buildsResult.items;
    const latest = new Map();
    for (const build of builds) {
      const eligible = phase === 'merged'
        ? build.sourceVersion === sha && build.sourceBranch === full(identity.targetRef) && build.reason !== 'pullRequest'
          && (!build.repository?.id || build.repository.id === identity.targetRepositoryId)
        : validBuild(build, raw, identity);
      if (!eligible) continue;
      const key = build.definition?.id ?? build.definition?.name;
      if (!latest.has(key) || build.id > latest.get(key).id) latest.set(key, build);
    }
    for (const b of latest.values()) checks.push({ name: b.definition?.name ?? `build:${b.definition?.id ?? b.id}`,
      state: b.status === 'completed' ? statusOf(b.result) : 'pending', sha, validationSha: b.sourceVersion,
      url: b._links?.web?.href });
    if (phase === 'open' && identity.state === 'OPEN') {
      const artifact = `vstfs:///CodeReview/CodeReviewId/${resolved.projectId}/${id}`;
      const [configurations, evaluations, rawThreads, statuses, iterations] = await Promise.all([
        optionalPages(`${projectBase}/git/policy/configurations?repositoryId=${enc(identity.targetRepositoryId)}&refName=${enc(full(identity.targetRef))}&${version}`),
        optionalPages(`${projectBase}/policy/evaluations?artifactId=${enc(artifact)}&includeNotApplicable=true&api-version=7.1-preview.1`),
        optionalPages(`${prPath(id)}/threads?${version}`),
        optionalPages(`${prPath(id)}/statuses?${version}`),
        optionalPages(`${prPath(id)}/iterations?${version}`),
      ]);
      if ([configurations, evaluations, rawThreads, statuses, iterations].some(r => !r.known)) {
        policyKnown = false; gates.push(gate('observation', 'unknown', 'Policy, feedback, or status data is unavailable.'));
      }
      const latestIteration = iterations.items.reduce((a, b) => b.id > (a?.id ?? -1) ? b : a, null);
      const mergePairCurrent = raw.lastMergeSourceCommit?.commitId === identity.sourceSha && raw.lastMergeTargetCommit?.commitId === identity.targetSha;
      if (!mergePairCurrent) { mergeStateStatus = 'UNKNOWN'; gates.push(gate('revision-pair', 'pending', 'Merge calculation has not caught up with current refs.')); }
      const votes = raw.reviewers ?? [];
      if (votes.some(r => r.vote === -10 || r.vote === -5)) reviewDecision = 'CHANGES_REQUESTED';
      else if (votes.some(r => r.isRequired && r.vote < 5)) reviewDecision = 'REVIEW_REQUIRED';
      for (const c of configurations.items) {
        if (c.isEnabled === false || c.isBlocking === false) continue;
        if (c.isEnabled !== true || c.isBlocking !== true) { policyKnown = false; gates.push(gate(`policy:${c.id}`, 'unknown')); continue; }
        const evaluation = evaluations.items.find(e => String(e.configuration?.id) === String(c.id));
        let state = evaluation ? policyState(evaluation.status) : 'pending';
        // A successful build-policy evaluation alone cannot prove which revision
        // ran. Validate its build against the current source/target pair.
        if ((c.type?.id === buildPolicy || c.settings?.buildDefinitionId !== undefined) && state === 'satisfied') {
          const buildId = evaluation.context?.buildId ?? evaluation.context?.BuildId;
          let build = buildId && builds.find(b => String(b.id) === String(buildId));
          if (buildId && !build) {
            try { build = await client.request('GET', `${projectBase}/build/builds/${enc(buildId)}?${version}`); }
            catch { /* Unknown build evidence remains blocking. */ }
          }
          if (!build || !validBuild(build, raw, identity)) state = 'pending';
        }
        if (evaluation?.context?.pullRequestSourceCommitId && evaluation.context.pullRequestSourceCommitId !== identity.sourceSha) state = 'pending';
        if (evaluation?.context?.pullRequestTargetCommitId && evaluation.context.pullRequestTargetCommitId !== identity.targetSha) state = 'pending';
        gates.push(gate(`policy:${c.id}`, state));
        if (state === 'unknown') policyKnown = false;
      }
      const latestStatus = new Map();
      for (const s of statuses.items) {
        if (s.iterationId !== undefined && s.iterationId !== latestIteration?.id) continue;
        if (s.iterationId === undefined && (!Number.isFinite(Date.parse(latestIteration?.createdDate))
          || !Number.isFinite(Date.parse(s.creationDate)) || Date.parse(s.creationDate) < Date.parse(latestIteration.createdDate))) {
          gates.push(gate(`status:${s.id}`, 'unknown', 'Status revision applicability is unproven.')); policyKnown = false; continue;
        }
        const key = `${s.context?.genre ?? ''}/${s.context?.name ?? s.id}`;
        if (!latestStatus.has(key) || s.id > latestStatus.get(key).id) latestStatus.set(key, s);
      }
      for (const [name, s] of latestStatus) checks.push({ name, state: statusOf(s.state), sha, url: s.targetUrl });
      for (const t of rawThreads.items.filter(t => !t.isDeleted)) {
        const resolvedThread = [2, 3, 4, 5, 'fixed', 'wontFix', 'closed', 'byDesign'].includes(t.status);
        threads.push({ id: `thread:${t.id}`, isResolved: resolvedThread, updatedAt: t.lastUpdatedDate });
        for (const c of (t.comments ?? []).filter(c => !c.isDeleted && c.commentType !== 'system' && c.commentType !== 3)) {
          feedback.push({ id: `thread:${t.id}:comment:${c.id}`, updatedAt: c.lastUpdatedDate ?? c.publishedDate,
            url: c._links?.web?.href });
        }
      }
    } else if (phase === 'merged') {
      mergeStateStatus = 'CLEAN'; gates.push(gate('merge-evidence', 'satisfied'));
    }
    const current = await currentIdentity(await rawRequest(id));
    if (current.state !== identity.state || current.sourceSha !== identity.sourceSha || current.targetSha !== identity.targetSha || current.mergeSha !== identity.mergeSha) {
      throw new Error('Azure request moved during observation; collect a fresh snapshot.');
    }
    return { state: identity.state, sha, phase, headRefOid: identity.sourceSha, baseRefName: identity.targetRef,
      checks, expected: [...(options.expected ?? [])], policyKnown, gates, threads, feedback, reviewDecision,
      mergeStateStatus, isDraft: current.isDraft, identity: current };
  }
  return { resolveRepository, getRequest, listOpen, create, update, merge, reply, resolveThread, collectSnapshot };
}
