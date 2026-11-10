import path from 'node:path';
import { assess } from '../scripts/watch.mjs';
import { requestKey } from './identity.mjs';
import { acquireLock, hash, readState, writeState } from './state.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const short = value => typeof value === 'string' ? value.replace(/^refs\/heads\//, '') : '';
const shared = /^(?:main|master|trunk|dev|develop|development|qa|uat|stg|stage|staging|prod|production|live|test|testing|integration|release|releases)(?:$|\/)/i;
const identityFields = ['provider', 'host', 'repositoryId', 'requestId', 'url', 'sourceRepositoryId', 'targetRepositoryId', 'sourceRef', 'targetRef', 'sourceSha'];

export function classifyTarget({ targetRef, defaultBranch, sharedBranches = [] }) {
  const target = short(targetRef), primary = short(defaultBranch);
  if (!target || !primary || !Array.isArray(sharedBranches) || sharedBranches.some(b => !short(b))) {
    return { eligible: false, reason: 'Target/default branch or repository branch-role evidence is unavailable.' };
  }
  if (target === primary || shared.test(target) || /^releases?[-_]/i.test(target)
    || sharedBranches.some(b => short(b) === target)) {
    return { eligible: false, reason: 'Target is a default, shared, environment, or release branch.' };
  }
  return { eligible: true, reason: 'Target is a working branch outside the repository shared-branch set.' };
}

const same = (a, b) => a && b && identityFields.every(k => String(a[k] ?? '') === String(b[k] ?? ''));
function authorize(input, request, repository) {
  const p = input.mergePolicy;
  if (p?.mode !== 'review-work-working-branch' || p.optOut === true || typeof p.branchEvidence !== 'string' || !p.branchEvidence.trim()
    || !Array.isArray(p.sharedBranches) || !['sourceRepositoryId', 'targetRepositoryId', 'sourceRef', 'targetRef'].every(k => typeof p[k] === 'string' && p[k] && p[k] === request[k])) {
    throw new Error('A review-work-owned request and recorded branch merge policy are required.');
  }
  if (String(repository.repositoryId) !== request.targetRepositoryId) throw new Error('Merge target repository does not match.');
  const eligibility = classifyTarget({ targetRef: request.targetRef, defaultBranch: repository.defaultBranch, sharedBranches: p.sharedBranches });
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  return eligibility;
}

// The coordinator supplies its saved authorization and evidence. The watcher
// remains read-only; only this explicit write path can request a merge.
export async function mergeRequest(input, { adapter, repository, request, stateDir }) {
  if (!sha(input.headSha) || !sha(input.targetSha) || request.sourceSha !== input.headSha) throw new Error('Merge requires the exact reviewed source and target SHAs.');
  authorize(input, request, repository);
  const strategies = { github: ['merge', 'squash', 'rebase'], gitlab: ['merge', 'squash'], bitbucket: ['merge', 'squash', 'fast_forward'], azure: ['merge', 'squash', 'rebase'] };
  if (input.strategy !== undefined && !strategies[request.provider]?.includes(input.strategy)) throw new Error('Unsupported provider merge strategy.');
  const expected = input.expected ?? [];
  if (!Array.isArray(expected) || expected.some(e => typeof e === 'string' ? !e.trim() : !e || typeof e.name !== 'string' || !e.name.trim()
    || e.appId !== undefined && !Number.isInteger(e.appId)) || input.allowNoChecks === true && expected.length) throw new Error('Invalid or contradictory expected-check policy.');
  const intent = { ...Object.fromEntries(identityFields.map(k => [k, request[k]])), targetSha: input.targetSha };
  const key = `merge-${hash(requestKey(request))}`;
  const release = await acquireLock(stateDir, key), filename = path.join(stateDir, `${key}.json`);
  try {
    const saved = await readState(filename);
    if (saved?.status === 'dispatching' && hash(saved.intent) !== hash(intent)) throw new Error('An earlier merge outcome is uncertain; reconcile it before another merge.');
    async function reconcile() {
      const current = await adapter.getRequest(request.requestId);
      if (!same(request, current)) throw new Error('Request identity or head changed; revalidate before merging.');
      if (current.state === 'MERGED' && sha(current.mergeSha)) {
        await writeState(filename, { status: 'completed', intent, mergeSha: current.mergeSha });
        return { status: 'merged', request: current };
      }
      if (current.state === 'CLOSED') throw new Error('Request closed without a confirmed merge; preserve its recovery context.');
      return { status: 'merge_pending', request: current };
    }
    if (request.state === 'MERGED' || saved?.status === 'dispatching') return await reconcile();
    if (request.state !== 'OPEN' || request.targetSha !== input.targetSha) throw new Error('Open request source/target pair changed; revalidate before merging.');
    const snapshot = await adapter.collectSnapshot({ phase: 'open', pr: request.requestId, requestId: request.requestId, expected, allowNoChecks: input.allowNoChecks === true });
    if (!same(request, snapshot.identity) || snapshot.identity.targetSha !== input.targetSha || snapshot.sha !== input.headSha || snapshot.phase !== 'open'
      || snapshot.state !== 'OPEN' || assess(snapshot, { allowNoChecks: input.allowNoChecks === true }).status !== 'ready') {
      throw new Error('Current request validation, approvals, feedback, or revisions do not permit merging.');
    }
    if (input.allowNoChecks === true && (typeof input.noChecksEvidence !== 'string' || !input.noChecksEvidence.trim())) throw new Error('No-check merge requires explicit repository/user evidence.');
    for (const item of [...snapshot.feedback, ...snapshot.threads]) {
      const disposition = input.feedback?.find(f => f.id === item.id && f.digest === hash(item));
      if (!disposition || !['addressed', 'declined', 'not_actionable'].includes(disposition.disposition) || !disposition.reason?.trim()) {
        throw new Error('Current feedback needs an evidence-backed disposition before merging.');
      }
    }
    const latestRepository = await adapter.resolveRepository();
    const latest = await adapter.getRequest(request.requestId);
    authorize(input, latest, latestRepository);
    if (!same(request, latest) || latest.targetSha !== input.targetSha || latest.state !== 'OPEN' || latest.isDraft) throw new Error('Request moved before merge; revalidate.');
    if (typeof adapter.merge !== 'function') throw new Error('Provider merge operation is unavailable.');
    await writeState(filename, { status: 'dispatching', intent });
    try { await adapter.merge(request.requestId, { headSha: input.headSha, strategy: input.strategy }); }
    catch (error) {
      if ([400, 401, 403, 404, 405, 409, 422].includes(error.status)) {
        await writeState(filename, { status: 'rejected', intent, statusCode: error.status });
        throw new Error('Provider rejected the merge; inspect policy, permissions, and current revisions.');
      }
      // A lost response or an asynchronous provider job must be observed, never
      // blindly submitted a second time.
    }
    return await reconcile();
  } finally { await release(); }
}
