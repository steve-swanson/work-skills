// GitLab.com only. The supplied client owns authentication, pagination and redaction.
const encoded = value => encodeURIComponent(String(value));
const shaPattern = /^[a-f\d]{40}$/i;
const sha = value => typeof value === 'string' && shaPattern.test(value) ? value : null;
const projectId = value => {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error('GitLab project identity is missing or invalid.');
  return String(value);
};
const requestId = value => {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error('GitLab merge request IID is missing or invalid.');
  return String(value);
};
const gate = (id, state, reason) => ({ id, state, ...(reason ? { reason } : {}) });
const unavailable = e => e.notFound || e.status === 403 || e.statusCode === 403 || e.status === 404 || e.statusCode === 404;
const query = data => new URLSearchParams(Object.entries(data).filter(([, value]) => value !== undefined && value !== null)).toString();

function draftTitle(title, isDraft) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('GitLab request title is required.');
  const plain = title.replace(/^(?:draft|wip):\s*/i, '');
  return isDraft ? `Draft: ${plain}` : plain;
}

function mergeGate(raw) {
  const status = raw.detailed_merge_status;
  if (raw.has_conflicts === true || status === 'conflict') return gate('mergeability', 'failed', 'Merge request has conflicts.');
  if (status === 'need_rebase') return gate('mergeability', 'failed', 'Source branch requires a rebase.');
  if (status === 'mergeable') return gate('mergeability', 'satisfied');
  if (['checking', 'unchecked', 'preparing', 'approvals_syncing', 'ci_still_running', 'ci_must_pass',
    'not_approved', 'draft_status', 'discussions_not_resolved', 'requested_changes', 'status_checks_must_pass',
    'merge_request_blocked', 'commits_status', 'locked_paths', 'locked_lfs_files', 'jira_association_missing',
    'security_policy_violations', 'not_open', 'merge_time'].includes(status)) {
    return gate('mergeability', 'pending', `GitLab merge requirement remains: ${status}.`);
  }
  return gate('mergeability', 'unknown', 'GitLab detailed merge status is unavailable or unsupported.');
}

function approvalGate(value) {
  if (!value || !Array.isArray(value.rules)) return gate('approvals', 'unknown', 'Approval rules could not be established.');
  const applicable = value.rules.filter(rule => rule.approvals_required !== 0);
  if (!applicable.length) return gate('approvals', 'not_applicable');
  if (applicable.some(rule => typeof rule.approved !== 'boolean')) return gate('approvals', 'unknown', 'Approval rule satisfaction is missing.');
  return gate('approvals', applicable.every(rule => rule.approved) ? 'satisfied' : 'pending');
}

function checkState(status, { allowFailure = false, allowSkipped = false } = {}) {
  if (status === 'success') return 'success';
  if (status === 'skipped') return allowSkipped || allowFailure ? 'skipped' : 'pending';
  if (['failed', 'canceled'].includes(status)) return allowFailure ? 'skipped' : 'failure';
  if (status === 'manual' && allowFailure) return 'skipped';
  return 'pending';
}

export function createGitLab({ repository, client }) {
  if (repository?.provider !== 'gitlab' || repository.host !== 'gitlab.com') throw new Error('Only GitLab.com is supported.');
  if (!client?.request || !client?.pages) throw new Error('GitLab adapter requires an authenticated paginated client.');
  let currentRepository = repository;
  const root = async () => `/projects/${encoded((await ensureRepository()).repositoryId)}`;
  async function resolveRepository(descriptor = currentRepository) {
    if (descriptor.provider !== 'gitlab' || descriptor.host !== 'gitlab.com') throw new Error('GitLab repository host does not match.');
    const key = descriptor.repositoryId ?? descriptor.repo;
    if (!key) throw new Error('GitLab repository path is required.');
    const data = await client.request('GET', `/projects/${encoded(key)}`);
    const resolved = { ...descriptor, repositoryId: projectId(data.id), repo: data.path_with_namespace,
      url: data.web_url, defaultBranch: data.default_branch };
    if (!resolved.repo || !resolved.url?.startsWith('https://gitlab.com/')) throw new Error('GitLab returned an incomplete repository identity.');
    if (descriptor === currentRepository || descriptor === repository) currentRepository = resolved;
    return resolved;
  }
  async function ensureRepository() { return currentRepository.repositoryId ? currentRepository : resolveRepository(); }
  async function targetHead(raw) {
    if (!raw.target_branch) throw new Error('GitLab target branch is missing.');
    const branch = await client.request('GET', `/projects/${encoded(projectId(raw.target_project_id))}/repository/branches/${encoded(raw.target_branch)}`);
    const revision = sha(branch.commit?.id);
    if (!revision) throw new Error('GitLab target branch SHA could not be established.');
    return revision;
  }
  function normalize(raw, targetSha = null) {
    const target = projectId(raw.target_project_id ?? currentRepository.repositoryId);
    const id = requestId(raw.iid);
    const url = raw.web_url;
    if (!url?.startsWith('https://gitlab.com/') || !url.endsWith(`/-/merge_requests/${id}`)) throw new Error('GitLab returned an invalid merge request URL.');
    const state = raw.state === 'merged' ? 'MERGED' : raw.state === 'closed' ? 'CLOSED' : ['opened', 'locked'].includes(raw.state) ? 'OPEN' : null;
    if (!state) throw new Error('GitLab returned an unsupported merge request state.');
    return { provider: 'gitlab', host: 'gitlab.com', repositoryId: target, requestId: id, url, state,
      sourceRepositoryId: projectId(raw.source_project_id), targetRepositoryId: target,
      sourceRef: raw.source_branch, targetRef: raw.target_branch, sourceSha: sha(raw.sha ?? raw.diff_refs?.head_sha),
      targetSha, mergeSha: sha(raw.merge_commit_sha), squashSha: sha(raw.squash_commit_sha),
      isDraft: raw.draft === true || raw.work_in_progress === true || /^(?:draft|wip):\s/i.test(raw.title ?? ''),
      title: raw.title, description: raw.description ?? '' };
  }
  async function load(id) {
    const path = `${await root()}/merge_requests/${encoded(requestId(id))}`;
    const raw = await client.request('GET', path);
    if (String(raw.target_project_id) !== String((await ensureRepository()).repositoryId)) throw new Error('GitLab request belongs to a different target repository.');
    return { raw, path, identity: normalize(raw, await targetHead(raw)) };
  }
  async function getRequest(id) { return (await load(id)).identity; }
  async function listOpen(input) {
    const items = await client.pages(`${await root()}/merge_requests?${query({ state: 'opened', scope: 'all',
      source_branch: input.sourceRef, target_branch: input.targetRef, per_page: 100 })}`);
    return items.filter(raw => String(raw.source_project_id) === String(input.sourceRepositoryId)
      && String(raw.target_project_id) === String(input.targetRepositoryId)
      && raw.source_branch === input.sourceRef && raw.target_branch === input.targetRef).map(raw => normalize(raw));
  }
  async function create(input) {
    const source = projectId(input.sourceRepositoryId ?? input.sourceRepository?.repositoryId);
    const target = projectId(input.targetRepositoryId ?? input.targetRepository?.repositoryId);
    const raw = await client.request('POST', `/projects/${encoded(source)}/merge_requests`, {
      source_branch: input.sourceRef, target_branch: input.targetRef, target_project_id: Number(target),
      title: draftTitle(input.title, input.isDraft === true), description: input.description ?? '',
    });
    return normalize(raw, await targetHead(raw));
  }
  async function update(id, input) {
    const existing = await load(id), body = {};
    if (input.title !== undefined || input.isDraft !== undefined) body.title = draftTitle(input.title ?? existing.raw.title, input.isDraft ?? existing.identity.isDraft);
    if (input.description !== undefined) body.description = input.description;
    const raw = await client.request('PUT', existing.path, body);
    return normalize(raw, await targetHead(raw));
  }
  async function merge(id, { headSha, strategy }) {
    if (strategy !== undefined && !['merge', 'squash'].includes(strategy)) throw new Error('Unsupported GitLab merge strategy.');
    return client.request('PUT', `${await root()}/merge_requests/${encoded(requestId(id))}/merge`, {
      sha: headSha, auto_merge: false, should_remove_source_branch: false, ...(strategy ? { squash: strategy === 'squash' } : {}),
    });
  }
  async function reply(id, input) {
    const path = `${await root()}/merge_requests/${encoded(requestId(id))}`;
    return client.request('POST', input.threadId ? `${path}/discussions/${encoded(input.threadId)}/notes` : `${path}/notes`, { body: input.body });
  }
  async function resolveThread(id, input) {
    if (!input.threadId || typeof input.resolved !== 'boolean') throw new Error('GitLab thread ID and resolved boolean are required.');
    return client.request('PUT', `${await root()}/merge_requests/${encoded(requestId(id))}/discussions/${encoded(input.threadId)}`, { resolved: input.resolved });
  }

  async function pipelineChecks(pipeline, identity, phase, settings) {
    const pipelineProject = projectId(pipeline.project_id ?? (phase === 'merged' ? identity.targetRepositoryId : identity.sourceRepositoryId));
    const details = await client.request('GET', `/projects/${encoded(pipelineProject)}/pipelines/${encoded(pipeline.id)}`);
    let bound = false;
    if (!sha(details.sha)) return { checks: [], gate: gate('pipeline_revision', 'unknown', 'Pipeline commit SHA is invalid or unavailable.') };
    if (phase === 'merged') {
      bound = details.sha === identity.mergeSha && details.ref === identity.targetRef && details.source !== 'merge_request_event';
    } else if (details.sha === identity.sourceSha) {
      bound = details.ref === identity.sourceRef || details.ref === `refs/merge-requests/${identity.requestId}/head`
        || details.source === 'merge_request_event';
    } else if (details.source === 'merge_request_event' && details.ref === `refs/merge-requests/${identity.requestId}/merge`) {
      const commit = await client.request('GET', `/projects/${encoded(pipelineProject)}/repository/commits/${encoded(details.sha)}`);
      bound = commit.id === details.sha && Array.isArray(commit.parent_ids)
        && commit.parent_ids.includes(identity.sourceSha) && commit.parent_ids.includes(identity.targetSha);
    }
    if (!bound) return { checks: [], gate: gate('pipeline_revision', 'pending', 'Pipeline does not prove validation of the current source/target revision.') };
    const jobs = await client.pages(`/projects/${encoded(pipelineProject)}/pipelines/${encoded(pipeline.id)}/jobs?include_retried=false&per_page=100`);
    const aggregate = { name: details.name ?? `Pipeline ${details.id ?? pipeline.id}`, state: checkState(details.status,
      { allowSkipped: settings.allow_merge_on_skipped_pipeline === true }), url: details.web_url, sha: details.sha, required: true };
    const checks = [aggregate, ...jobs.map(job => ({ name: job.name, state: checkState(job.status,
      { allowFailure: job.allow_failure === true, allowSkipped: job.status === 'skipped' }),
    url: job.web_url, required: job.allow_failure !== true, sha: details.sha }))];
    return { checks, gate: gate('pipeline_revision', 'satisfied') };
  }

  async function collectSnapshot(options = {}) {
    const phase = options.phase ?? 'open', id = options.requestId ?? options.pr ?? repository.requestId;
    if (!['open', 'merged'].includes(phase)) throw new Error('GitLab phase must be open or merged.');
    const first = await load(id), { raw, path, identity } = first;
    const revision = phase === 'merged' ? identity.mergeSha : identity.sourceSha;
    if (phase === 'merged' && (identity.state !== 'MERGED' || !revision)) throw new Error('GitLab merged phase requires a confirmed merge commit.');
    if (!revision) throw new Error('GitLab merge request head SHA is missing.');
    const base = { state: identity.state, sha: revision, phase, headRefOid: identity.sourceSha, baseRefName: identity.targetRef,
      checks: [], expected: [...(options.expected ?? [])], policyKnown: true, threads: [], feedback: [],
      reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', isDraft: identity.isDraft, identity, gates: [] };
    if (phase === 'open' && identity.state !== 'OPEN') return base;
    const settings = await client.request('GET', `${await root()}`);
    let pipelines;
    if (phase === 'merged') {
      pipelines = await client.pages(`${await root()}/pipelines?${query({ sha: revision, ref: identity.targetRef, per_page: 100 })}`);
      pipelines = pipelines.filter(p => p.sha === revision && p.ref === identity.targetRef && p.source !== 'merge_request_event');
      // Preserve each post-merge pipeline source/name, selecting its latest run.
      const latest = new Map();
      for (const p of pipelines) {
        const key = `${p.source}:${p.name ?? ''}`;
        if (!latest.has(key) || Number(p.id) > Number(latest.get(key).id)) latest.set(key, p);
      }
      pipelines = [...latest.values()];
    } else {
      let approvals;
      try { approvals = await client.request('GET', `${path}/approval_state`); }
      catch (e) { if (!unavailable(e)) throw e; }
      base.gates.push(approvalGate(approvals), mergeGate(raw));
      base.reviewDecision = base.gates[0].state === 'satisfied' || base.gates[0].state === 'not_applicable' ? 'APPROVED' : 'REVIEW_REQUIRED';
      if (raw.detailed_merge_status === 'requested_changes') base.reviewDecision = 'CHANGES_REQUESTED';
      base.mergeStateStatus = raw.has_conflicts || raw.detailed_merge_status === 'conflict' ? 'DIRTY'
        : raw.detailed_merge_status === 'need_rebase' ? 'BEHIND' : raw.detailed_merge_status === 'mergeable' ? 'CLEAN' : 'UNKNOWN';
      const discussions = await client.pages(`${path}/discussions?per_page=100`);
      for (const d of discussions) {
        const notes = (d.notes ?? []).filter(n => !n.system);
        const resolvable = notes.filter(n => n.resolvable === true);
        if (resolvable.length) base.threads.push({ id: String(d.id), isResolved: resolvable.every(n => n.resolved === true),
          updatedAt: notes.map(n => n.updated_at ?? n.created_at ?? '').sort().at(-1), url: `${identity.url}#note_${notes.at(-1)?.id}` });
        base.feedback.push(...notes.map(n => ({ id: `note:${n.id}`, updatedAt: n.updated_at ?? n.created_at, url: `${identity.url}#note_${n.id}` })));
      }
      if (raw.blocking_discussions_resolved === false) base.gates.push(gate('discussions', 'failed', 'Blocking discussions remain unresolved.'));
      // head_pipeline is GitLab's current MR pipeline association, even if a
      // source push has made that association stale while a new run is pending.
      if (raw.head_pipeline) pipelines = [raw.head_pipeline];
      else {
        const listed = await client.pages(`${path}/pipelines?per_page=100`);
        pipelines = listed.length ? [listed.reduce((a, b) => Number(a.id) >= Number(b.id) ? a : b)] : [];
      }
    }
    for (const pipeline of pipelines) {
      const result = await pipelineChecks(pipeline, identity, phase, settings);
      base.checks.push(...result.checks); base.gates.push(result.gate);
    }
    if (!pipelines.length) base.gates.push(gate('ci', options.allowNoChecks && !base.expected.length ? 'not_applicable' : 'pending', 'No pipeline has been established for this revision.'));
    base.policyKnown = !base.gates.some(g => g.state === 'unknown');
    const last = await load(id);
    if (['sourceSha', 'targetSha', 'sourceRef', 'targetRef', 'sourceRepositoryId', 'targetRepositoryId', 'state', 'mergeSha', 'isDraft'].some(k => last.identity[k] !== identity[k])
      || (phase === 'open' && (last.raw.head_pipeline?.id !== raw.head_pipeline?.id
        || last.raw.detailed_merge_status !== raw.detailed_merge_status
        || last.raw.blocking_discussions_resolved !== raw.blocking_discussions_resolved))) {
      throw new Error('GitLab request or target revision moved during observation; take a fresh snapshot.');
    }
    return base;
  }
  return { resolveRepository, getRequest, listOpen, create, update, merge, reply, resolveThread, collectSnapshot };
}
