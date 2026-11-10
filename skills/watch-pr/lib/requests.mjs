import { homedir } from 'node:os';
import path from 'node:path';
import { parseRepository, discoverRepository } from './identity.mjs';
import { getAdapter } from './providers/index.mjs';
import { acquireLock, hash, readState, writeState } from './state.mjs';
import { mergeRequest } from './merge-policy.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const idFields = ['provider', 'host', 'repositoryId', 'requestId', 'url', 'state', 'sourceRepositoryId', 'targetRepositoryId', 'sourceRef', 'targetRef', 'sourceSha', 'targetSha', 'mergeSha', 'isDraft'];
export const publicRequest = request => Object.fromEntries(idFields.filter(k => request[k] !== undefined).map(k => [k, request[k]]));

function verify(request, input) {
  if (request.state !== 'OPEN' || request.sourceRepositoryId !== String(input.sourceRepositoryId) || request.targetRepositoryId !== String(input.targetRepositoryId)
    || request.sourceRef !== input.sourceRef || request.targetRef !== input.targetRef || request.sourceSha !== input.headSha) {
    throw new Error('Published request does not match the intended repositories, branches, or head SHA; preserve it and reconcile.');
  }
  const parsed = parseRepository(request.url, { requireRequest: true });
  const intended = parseRepository(input.targetRepository.url);
  if (parsed.provider !== input.targetRepository.provider || parsed.repo.toLowerCase() !== intended.repo.toLowerCase()
    || parsed.requestId !== Number(request.requestId)) throw new Error('Unexpected published request URL.');
  return request;
}

export async function runRequest(command, input, { adapterFactory = getAdapter, stateDir = path.join(homedir(), '.agents', 'state', 'watch-pr') } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request input must be an object.');
  if (command === 'discover') return { repository: await discoverRepository(input) };
  if (!['create', 'inspect', 'update', 'reply', 'resolve-thread', 'merge'].includes(command)) throw new Error('Unsupported request operation.');
  if (command !== 'create') {
    const parsed = parseRepository(input.url, { requireRequest: true });
    const adapter = adapterFactory(parsed);
    const repository = await adapter.resolveRepository(parsed);
    const request = await adapter.getRequest(parsed.requestId);
    if (command === 'inspect') return { status: 'observed', request: publicRequest(request) };
    if (command === 'merge') {
      const result = await mergeRequest(input, { adapter, repository, request, stateDir });
      return { ...result, request: publicRequest(result.request) };
    }
    if (request.state !== 'OPEN' || !sha(input.headSha) || request.sourceSha !== input.headSha) throw new Error('A current open-request head SHA is required before writing.');
    if (command === 'update') {
      if (input.title !== undefined && !text(input.title) || input.description !== undefined && typeof input.description !== 'string') throw new Error('Invalid request text.');
      const updated = await adapter.update(parsed.requestId, { title: input.title, description: input.description });
      if (updated.sourceSha !== request.sourceSha || updated.targetRef !== request.targetRef || updated.sourceRepositoryId !== request.sourceRepositoryId || updated.targetRepositoryId !== request.targetRepositoryId) throw new Error('Request identity changed during update.');
      return { status: 'updated', request: publicRequest(updated) };
    }
    if (command === 'reply') {
      if (!text(input.body)) throw new Error('A reply body is required.');
      const reply = await adapter.reply(parsed.requestId, { body: input.body, threadId: input.threadId });
      return { status: 'replied', request: publicRequest(request), replyId: reply?.id ?? null };
    }
    if (!text(String(input.threadId ?? ''))) throw new Error('A thread ID is required.');
    await adapter.resolveThread(parsed.requestId, { threadId: input.threadId, resolved: input.resolved !== false });
    return { status: 'thread_updated', request: publicRequest(request) };
  }
  for (const field of ['sourceRef', 'targetRef', 'title']) if (!text(input[field])) throw new Error('Source/target branches and title are required.');
  if (!sha(input.headSha) || typeof input.description !== 'string' || input.isDraft !== undefined && typeof input.isDraft !== 'boolean') throw new Error('Provide a committed head SHA, description, and optional boolean draft preference.');
  const source = parseRepository(input.sourceUrl), target = parseRepository(input.targetUrl);
  if (source.provider !== target.provider || source.host !== target.host) throw new Error('Source and target must use the same cloud provider.');
  const adapter = adapterFactory(target);
  const targetRepository = await adapter.resolveRepository(target);
  const sourceRepository = await adapter.resolveRepository(source);
  const intent = { ...input, sourceRef: input.sourceRef.replace(/^refs\/heads\//, ''), targetRef: input.targetRef.replace(/^refs\/heads\//, ''),
    sourceRepository, targetRepository, sourceRepositoryId: String(sourceRepository.repositoryId), targetRepositoryId: String(targetRepository.repositoryId) };
  const key = hash({ operation: 'create', provider: target.provider, host: target.host, source: intent.sourceRepositoryId,
    target: intent.targetRepositoryId, sourceRef: intent.sourceRef, targetRef: intent.targetRef,
    ...(target.provider === 'azure' ? { organization: target.organization.toLowerCase() } : {}) });
  const release = await acquireLock(stateDir, `create-${key}`);
  const journal = path.join(stateDir, `create-${key}.json`);
  try {
    const saved = await readState(journal);
    const existing = await adapter.listOpen(intent);
    if (existing.length > 1) throw new Error('Multiple matching open requests; choose the intended request before continuing.');
    if (existing.length === 1) {
      const found = verify(await adapter.getRequest(existing[0].requestId), intent);
      await writeState(journal, { status: 'completed', request: publicRequest(found) });
      return { status: 'reused', request: publicRequest(found) };
    }
    if (saved?.status === 'dispatching') throw new Error('Earlier creation outcome is uncertain; reconcile with the provider before another create attempt.');
    await writeState(journal, { status: 'dispatching', provider: target.provider, targetRepositoryId: intent.targetRepositoryId,
      sourceRepositoryId: intent.sourceRepositoryId, sourceRef: input.sourceRef, targetRef: input.targetRef, headSha: input.headSha });
    let created;
    try { created = await adapter.create(intent); }
    catch (error) {
      const matches = await adapter.listOpen(intent);
      if (matches.length === 1) created = await adapter.getRequest(matches[0].requestId);
      else {
        if ([400, 401, 403, 404, 422].includes(error.status)) await writeState(journal, { status: 'rejected', statusCode: error.status });
        throw new Error('Creation did not confirm a request; preserve the journal and reconcile before retrying.');
      }
    }
    const verified = verify(await adapter.getRequest(created.requestId), intent);
    await writeState(journal, { status: 'completed', request: publicRequest(verified) });
    return { status: 'created', request: publicRequest(verified) };
  } finally { await release(); }
}
