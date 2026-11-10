// Bitbucket Cloud adapter. Authentication, pagination and writes are supplied by client.
const enc = encodeURIComponent;
const repoPath = repo => `/repositories/${repo.split('/').map(enc).join('/')}`;
const gate = (id, state, reason) => ({ id, state, ...(reason ? { reason } : {}) });
const stateOf = value => ({ SUCCESSFUL: 'success', PASSED: 'success', SUCCESS: 'success',
  FAILED: 'failure', ERROR: 'failure', STOPPED: 'failure', EXPIRED: 'failure',
  INPROGRESS: 'pending', IN_PROGRESS: 'pending', PENDING: 'pending', PAUSED: 'pending', NOT_RUN: 'pending' }[value] ?? 'pending');
const ref = value => value?.replace(/^refs\/heads\//, '');
const match = (pattern, name) => {
  if (typeof pattern !== 'string') return null;
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name);
};
const feedbackOf = comment => ({ id: `comment:${comment.id}`, updatedAt: comment.updated_on ?? comment.created_on,
  url: comment.links?.html?.href });

export function createBitbucket({ repository, client }) {
  if (repository.provider !== 'bitbucket' || repository.host !== 'bitbucket.org') throw new Error('Only Bitbucket Cloud is supported.');
  const base = repoPath(repository.repo);
  const rawRequest = id => client.request('GET', `${base}/pullrequests/${enc(id)}`);
  const normalize = raw => ({ provider: 'bitbucket', host: 'bitbucket.org',
    repositoryId: String(raw.destination?.repository?.uuid ?? repository.repositoryId ?? ''), requestId: String(raw.id),
    url: raw.links?.html?.href ?? `https://bitbucket.org/${repository.repo}/pull-requests/${raw.id}`,
    state: raw.state === 'MERGED' ? 'MERGED' : raw.state === 'OPEN' ? 'OPEN' : 'CLOSED',
    sourceRepositoryId: String(raw.source?.repository?.uuid ?? ''), targetRepositoryId: String(raw.destination?.repository?.uuid ?? repository.repositoryId ?? ''),
    sourceRef: raw.source?.branch?.name, targetRef: raw.destination?.branch?.name,
    sourceSha: raw.source?.commit?.hash, targetSha: raw.destination?.commit?.hash, mergeSha: raw.merge_commit?.hash,
    isDraft: raw.draft === true, title: raw.title, description: raw.description ?? '' });
  const optionalPages = async (path, field = 'values') => {
    try { return { items: await client.pages(path, field), known: true }; }
    catch (error) { if (error.transient) throw error; return { items: [], known: false }; }
  };
  async function resolveRepository(descriptor = repository) {
    const raw = await client.request('GET', repoPath(descriptor.repo));
    if (!raw.uuid || !raw.full_name) throw new Error('Bitbucket repository identity is incomplete.');
    return { ...descriptor, provider: 'bitbucket', host: 'bitbucket.org', repo: raw.full_name,
      repositoryId: String(raw.uuid), url: raw.links?.html?.href ?? `https://bitbucket.org/${raw.full_name}`,
      defaultBranch: raw.mainbranch?.name };
  }
  async function getRequest(id) { return normalize(await rawRequest(id)); }
  async function listOpen(input) {
    const q = [`state="OPEN"`, `source.branch.name=${JSON.stringify(ref(input.sourceRef))}`,
      `destination.branch.name=${JSON.stringify(ref(input.targetRef))}`,
      ...(input.sourceRepositoryId ? [`source.repository.uuid=${JSON.stringify(input.sourceRepositoryId)}`] : [])].join(' AND ');
    return (await client.pages(`${base}/pullrequests?q=${enc(q)}&pagelen=100`, 'values')).map(normalize)
      .filter(r => r.state === 'OPEN' && r.sourceRef === ref(input.sourceRef) && r.targetRef === ref(input.targetRef)
        && (!input.sourceRepositoryId || r.sourceRepositoryId === input.sourceRepositoryId)
        && (!input.targetRepositoryId || r.targetRepositoryId === input.targetRepositoryId));
  }
  async function create(input) {
    const raw = await client.request('POST', `${base}/pullrequests`, {
      title: input.title, description: input.description, draft: input.isDraft === true,
      source: { branch: { name: ref(input.sourceRef) }, repository: { uuid: input.sourceRepositoryId } },
      destination: { branch: { name: ref(input.targetRef) }, repository: { uuid: input.targetRepositoryId } },
      close_source_branch: false,
    });
    return normalize(raw);
  }
  async function update(id, input) {
    const body = {};
    for (const [key, value] of Object.entries({ title: input.title, description: input.description, draft: input.isDraft })) {
      if (value !== undefined) body[key] = value;
    }
    return normalize(await client.request('PUT', `${base}/pullrequests/${enc(id)}`, body));
  }
  async function reply(id, input) {
    const parent = input.threadId ? String(input.threadId).replace(/^comment:/, '') : undefined;
    if (parent !== undefined && !/^\d+$/.test(parent)) throw new Error('Bitbucket comment ID must be numeric.');
    return client.request('POST', `${base}/pullrequests/${enc(id)}/comments`, {
      content: { raw: input.body }, ...(parent ? { parent: { id: Number(parent) } } : {}),
    });
  }
  async function merge(id, { strategy }) {
    if (strategy !== undefined && !['merge', 'squash', 'fast_forward'].includes(strategy)) throw new Error('Unsupported Bitbucket merge strategy.');
    return client.request('POST', `${base}/pullrequests/${enc(id)}/merge`, { type: 'pullrequest', close_source_branch: false,
      ...(strategy ? { merge_strategy: strategy === 'merge' ? 'merge_commit' : strategy } : {}) });
  }
  async function resolveThread(id, input) {
    const comment = String(input.threadId).replace(/^comment:/, '');
    if (!/^\d+$/.test(comment)) throw new Error('Bitbucket comment ID must be numeric.');
    return client.request(input.resolved === false ? 'DELETE' : 'POST', `${base}/pullrequests/${enc(id)}/comments/${comment}/resolve`);
  }

  async function collectSnapshot(options) {
    const id = options.requestId ?? options.pr ?? repository.requestId;
    const raw = await rawRequest(id), identity = normalize(raw), phase = options.phase ?? 'open';
    const sha = phase === 'merged' ? identity.mergeSha : identity.sourceSha;
    if (phase === 'merged' && (identity.state !== 'MERGED' || !sha)) throw new Error('Bitbucket has not confirmed a merge commit.');
    if (!sha) throw new Error('Bitbucket revision is unavailable.');
    const gates = [], checks = [], threads = [], feedback = [];
    let reviewDecision = 'APPROVED', mergeStateStatus = 'UNKNOWN', policyKnown = true;
    if (phase === 'merged') {
      const pipelines = await optionalPages(`${base}/pipelines/?q=${enc(`target.commit.hash=${JSON.stringify(sha)}`)}&sort=-created_on&pagelen=100`);
      if (!pipelines.known) { policyKnown = false; gates.push(gate('merge-ci', 'unknown', 'Cannot read merge-commit pipelines.')); }
      const latest = new Map();
      for (const run of pipelines.items) {
        if (run.target?.type !== 'pipeline_ref_target' || run.target.commit?.hash !== sha || run.target.ref_name !== identity.targetRef) continue;
        const name = run.target.selector?.pattern ?? run.target.selector?.type ?? 'pipeline';
        if (!latest.has(name) || run.build_number > latest.get(name).build_number) latest.set(name, run);
      }
      for (const [name, run] of latest) checks.push({ name, state: stateOf(run.state?.result?.name ?? run.state?.name), sha,
        url: run.links?.html?.href });
      gates.push(gate('merge-evidence', 'satisfied'));
      mergeStateStatus = 'CLEAN';
    } else if (identity.state === 'OPEN') {
      const sourceName = raw.source?.repository?.full_name;
      const sourceBase = sourceName ? repoPath(sourceName) : identity.sourceRepositoryId === identity.targetRepositoryId ? base : null;
      const [restrictions, mergeability, comments, tasks, statuses] = await Promise.all([
        optionalPages(`${base}/branch-restrictions?pagelen=100`),
        optionalPages(`${base}/pullrequests/${enc(id)}/mergeability/checks`),
        optionalPages(`${base}/pullrequests/${enc(id)}/comments?pagelen=100`),
        optionalPages(`${base}/pullrequests/${enc(id)}/tasks?pagelen=100`),
        sourceBase ? optionalPages(`${sourceBase}/commit/${enc(sha)}/statuses?pagelen=100`) : { items: [], known: false },
      ]);
      if (!restrictions.known || !mergeability.known || !comments.known || !tasks.known || !statuses.known) {
        policyKnown = false; gates.push(gate('observation', 'unknown', 'Required policy, feedback, or commit status data is unavailable.'));
      }
      // The mergeability endpoint covers standard/custom checks and Git conflicts.
      // Branch restrictions still identify requirements the endpoint cannot evaluate.
      const git = mergeability.items.find(c => c.type === 'git_mergeability_check');
      mergeStateStatus = git?.status === 'PASSED' ? 'CLEAN' : git?.status === 'FAILED' ? 'DIRTY' : 'UNKNOWN';
      if (!git) { policyKnown = false; gates.push(gate('git-mergeability', 'unknown', 'Git mergeability was not evaluated.')); }
      for (const c of mergeability.items) {
        const state = c.status === 'PASSED' ? 'satisfied' : c.status === 'FAILED' ? 'failed'
          : ['PENDING', 'RUNNING', 'IN_PROGRESS'].includes(c.status) ? 'pending' : 'unknown';
        gates.push(gate(`mergeability:${c.id ?? c.type}:${c.restriction?.id ?? ''}`,
          state === 'failed' && c.required === false && c.blocking === false ? 'not_applicable' : state));
        if (state === 'unknown') policyKnown = false;
      }
      const participants = raw.participants ?? [];
      if (participants.some(p => p.state === 'changes_requested')) reviewDecision = 'CHANGES_REQUESTED';
      for (const c of comments.items.filter(c => !c.deleted)) {
        feedback.push(feedbackOf(c));
        // Comments with a resolution field are native resolvable threads. Other
        // ordinary discussion comments remain feedback, not invented blockers.
        if (Object.hasOwn(c, 'resolution')) threads.push({ ...feedbackOf(c), isResolved: Boolean(c.resolution) });
      }
      const openTasks = tasks.items.filter(t => t.state !== 'RESOLVED');
      for (const t of tasks.items) feedback.push({ id: `task:${t.id}`, updatedAt: t.updated_on ?? t.created_on });
      const statusesByKey = new Map();
      for (const s of statuses.items) {
        if (s.commit?.hash && s.commit.hash !== sha) continue;
        const key = s.key ?? s.name;
        if (!statusesByKey.has(key) || String(s.updated_on) > String(statusesByKey.get(key).updated_on)) statusesByKey.set(key, s);
      }
      for (const [key, s] of statusesByKey) checks.push({ name: s.name ?? key, state: stateOf(s.state), sha, url: s.url });
      let branchingModel;
      if (restrictions.items.some(r => r.branch_match_kind === 'branching_model')) {
        try { branchingModel = await client.request('GET', `${base}/branching-model`); }
        catch { /* Unknown applicability remains blocking below. */ }
      }
      let defaults;
      if (restrictions.items.some(r => r.kind === 'require_default_reviewer_approvals_to_merge')) {
        defaults = await optionalPages(`${base}/effective-default-reviewers?pagelen=100`);
      }
      for (const restriction of restrictions.items) {
        let applies;
        if (restriction.branch_match_kind === 'branching_model') {
          const type = restriction.branch_type;
          const main = branchingModel?.[type];
          const branch = branchingModel?.branch_types?.find(b => b.kind === type && b.enabled !== false);
          applies = typeof main?.name === 'string' ? main.name === identity.targetRef
            : typeof branch?.prefix === 'string' ? identity.targetRef.startsWith(branch.prefix) : null;
        } else applies = match(restriction.pattern, identity.targetRef);
        if (applies === false) continue;
        if (applies === null) { policyKnown = false; gates.push(gate(`restriction:${restriction.id}`, 'unknown', 'Branching-model applicability is unknown.')); continue; }
        const kind = restriction.kind, count = Number(restriction.value ?? 0);
        if (['require_approvals_to_merge', 'require_passing_builds_to_merge', 'require_default_reviewer_approvals_to_merge'].includes(kind)
          && (!Number.isInteger(restriction.value) || restriction.value < 0)) {
          policyKnown = false; gates.push(gate(`restriction:${restriction.id}`, 'unknown', 'Required policy count is unavailable.')); continue;
        }
        if (kind === 'require_approvals_to_merge') {
          const approvals = participants.filter(p => p.approved && p.user?.uuid !== raw.author?.uuid).length;
          const state = approvals >= count ? 'satisfied' : 'pending';
          gates.push(gate(`restriction:${restriction.id}`, state));
          if (state !== 'satisfied') reviewDecision = reviewDecision === 'CHANGES_REQUESTED' ? reviewDecision : 'REVIEW_REQUIRED';
        } else if (kind === 'require_tasks_to_be_completed') gates.push(gate(`restriction:${restriction.id}`, openTasks.length ? 'failed' : 'satisfied'));
        else if (kind === 'require_passing_builds_to_merge') gates.push(gate(`restriction:${restriction.id}`, checks.filter(c => c.state === 'success').length >= count ? 'satisfied' : 'pending'));
        else if (kind === 'require_no_changes_requested') gates.push(gate(`restriction:${restriction.id}`, reviewDecision === 'CHANGES_REQUESTED' ? 'failed' : 'satisfied'));
        else if (kind === 'require_default_reviewer_approvals_to_merge') {
          if (!defaults?.known) { policyKnown = false; gates.push(gate(`restriction:${restriction.id}`, 'unknown', 'Default reviewers are unavailable.')); continue; }
          const ids = new Set(defaults.items.map(u => u.uuid ?? u.user?.uuid).filter(Boolean));
          const approvals = participants.filter(p => p.approved && ids.has(p.user?.uuid) && p.user?.uuid !== raw.author?.uuid).length;
          gates.push(gate(`restriction:${restriction.id}`, approvals >= count ? 'satisfied' : 'pending'));
          if (approvals < count && reviewDecision !== 'CHANGES_REQUESTED') reviewDecision = 'REVIEW_REQUIRED';
        } else if (['require_all_dependencies_merged', 'require_commits_behind'].includes(kind)) {
          const evaluated = mergeability.items.some(c => c.restriction?.id === restriction.id && c.status === 'PASSED');
          gates.push(gate(`restriction:${restriction.id}`, evaluated ? 'satisfied' : 'unknown'));
          if (!evaluated) policyKnown = false;
        } else if (!['push', 'force', 'delete', 'restrict_merges', 'enforce_merge_checks', 'allow_auto_merge_when_builds_pass',
          'reset_pullrequest_approvals_on_change', 'smart_reset_pullrequest_approvals', 'reset_pullrequest_changes_requested_on_change'].includes(kind)) {
          policyKnown = false; gates.push(gate(`restriction:${restriction.id}`, 'unknown', 'Unsupported branch requirement.'));
        }
      }
    }
    const current = normalize(await rawRequest(id));
    if (current.state !== identity.state || current.sourceSha !== identity.sourceSha || current.targetSha !== identity.targetSha || current.mergeSha !== identity.mergeSha) {
      throw new Error('Bitbucket request moved during observation; collect a fresh snapshot.');
    }
    return { state: identity.state, phase, sha, headRefOid: identity.sourceSha, baseRefName: identity.targetRef,
      checks, expected: [...(options.expected ?? [])], policyKnown, gates, threads, feedback, reviewDecision,
      mergeStateStatus, isDraft: current.isDraft, identity: current };
  }
  return { resolveRepository, getRequest, listOpen, create, update, merge, reply, resolveThread, collectSnapshot };
}
