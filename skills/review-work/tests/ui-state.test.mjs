import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore, SubmissionAttempt, recoverSubmission, sendSubmission, visibleFindings, tabCounts, findingTag, stepSelection, kindFilters, matchesKinds } from '../assets/runtime/public/draft-store.mjs';

const finding = (changes = {}) => ({ id: 'R001', label: 'issue', blocking: true, title: 'A concrete issue', decision: null, context: '', revision: 0, submittedRevision: null, status: 'unreviewed', ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const makeStore = (patch, options = {}) => new DraftStore({ patch, debounceMs: 60_000, ...options });

test('decision changes preserve context and do not queue execution', async () => {
  const calls = [];
  const store = makeStore(async (id, draft) => { calls.push(draft); return finding({ ...draft, revision: 1 }); });
  store.ingest([finding()]);
  store.update('R001', { decision: 'clarify', context: 'Please explain the race.' });
  store.update('R001', { decision: 'fix' });
  assert.equal(store.get('R001').context, 'Please explain the race.');
  assert.equal(store.get('R001').status, 'unreviewed');
  assert.equal(store.get('R001').saveState, 'pending');
  await store.flush();
  assert.deepEqual(calls, [{ decision: 'fix', context: 'Please explain the race.', expectedRevision: 0 }]);
  assert.equal(store.get('R001').saveState, 'saved');
  store.destroy();
});

test('edits made during a save are serialized using the acknowledged revision', async () => {
  const first = deferred();
  const calls = [];
  const store = makeStore(async (id, draft) => { calls.push(draft); return calls.length === 1 ? first.promise : finding({ ...draft, revision: 2 }); });
  store.ingest([finding()]);
  store.update('R001', { decision: 'fix', context: 'First' });
  const flushing = store.flush();
  await Promise.resolve();
  store.update('R001', { context: 'Newest' });
  first.resolve(finding({ decision: 'fix', context: 'First', revision: 1 }));
  await flushing;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { decision: 'fix', context: 'Newest', expectedRevision: 1 });
  assert.equal(store.get('R001').context, 'Newest');
  assert.equal(store.get('R001').persistedContext, 'Newest');
  assert.equal(store.get('R001').saveState, 'saved');
  store.destroy();
});

test('a poll cannot acknowledge an in-flight save or overwrite newer typing', async () => {
  const pending = deferred();
  const store = makeStore(async () => pending.promise);
  store.ingest([finding()]);
  store.update('R001', { decision: 'fix', context: 'Local' });
  const saving = store.flush();
  store.ingest([finding({ decision: 'fix', context: 'Local', revision: 1 })]);
  assert.equal(store.get('R001').saveState, 'saving');
  assert.equal(store.get('R001').persistedContext, '');
  pending.resolve(finding({ decision: 'fix', context: 'Local', revision: 1 }));
  await saving;
  store.ingest([finding({ revision: 0 })]);
  assert.equal(store.get('R001').context, 'Local');
  assert.equal(store.get('R001').saveState, 'saved');
  store.destroy();
});

test('failed saves preserve the draft and prevent a successful flush', async () => {
  const store = makeStore(async () => { throw new Error('Connection lost'); });
  store.ingest([finding()]);
  const rawContext = '  Why?\n\nKeep this indentation.\t ';
  store.update('R001', { decision: 'clarify', context: rawContext });
  await assert.rejects(store.flush(), /Connection lost/);
  assert.equal(store.get('R001').context, rawContext);
  assert.equal(store.get('R001').persistedContext, '');
  assert.equal(store.get('R001').saveState, 'error');
  store.destroy();
});

test('conflicts preserve local context until an explicit reload or retry', async () => {
  let conflict = true;
  const calls = [];
  const store = makeStore(async (id, draft) => { calls.push(draft); if (conflict) throw Object.assign(new Error('Changed elsewhere'), { status: 409 }); return finding({ ...draft, revision: 3 }); });
  store.ingest([finding()]);
  store.update('R001', { decision: 'fix', context: 'My draft' });
  await assert.rejects(store.flush(), /Changed elsewhere/);
  store.ingest([finding({ decision: 'clarify', context: 'Other draft', revision: 2 })]);
  assert.equal(store.get('R001').context, 'My draft');
  assert.equal(store.get('R001').conflict.latest.context, 'Other draft');
  conflict = false;
  store.retryLocal('R001');
  await store.flush();
  assert.equal(calls[1].expectedRevision, 2);
  assert.equal(store.get('R001').persistedContext, 'My draft');
  store.update('R001', { context: 'Another local edit' });
  store.ingest([finding({ decision: 'dont_fix', context: 'Remote', revision: 4 })]);
  store.acceptRemote('R001');
  assert.equal(store.get('R001').context, 'Remote');
  assert.equal(store.get('R001').saveState, 'saved');
  store.destroy();
});

test('submitted findings are read-only, including remote submissions while a draft is dirty', () => {
  const store = makeStore(async () => { throw new Error('must not save'); });
  store.ingest([finding()]);
  store.update('R001', { decision: 'fix', context: 'Local retained' });
  store.ingest([finding({ decision: 'clarify', context: 'Submitted', revision: 1, submittedRevision: 1, status: 'clarify' })]);
  assert.equal(store.get('R001').locked, true);
  assert.equal(store.get('R001').context, 'Local retained');
  assert.throws(() => store.update('R001', { decision: 'fix' }), /submitted/i);
  assert.throws(() => store.retryLocal('R001'), /submitted/i);
  store.acceptRemote('R001');
  assert.equal(store.get('R001').context, 'Submitted');
  store.destroy();
});

test('submit request identity survives retries and retains its original review snapshot', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const attempt = new SubmissionAttempt({ storage, reviewId: 'review-one', randomUUID: () => 'request-one' });
  const snapshot = [{ id: 'R001', expectedRevision: 2 }];
  assert.deepEqual(attempt.begin('sha-one', snapshot), { requestId: 'request-one', reviewId: 'review-one', reviewedSha: 'sha-one', findings: snapshot });
  snapshot[0].expectedRevision = 99;
  assert.equal(attempt.begin('sha-two', [{ id: 'R002', expectedRevision: 3 }]).reviewedSha, 'sha-one');
  const reloaded = new SubmissionAttempt({ storage, reviewId: 'review-one', randomUUID: () => 'request-two' });
  assert.equal(reloaded.pending.requestId, 'request-one');
  assert.deepEqual(reloaded.pending.findings, [{ id: 'R001', expectedRevision: 2 }]);
  assert.deepEqual(attempt.pending.findings, [{ id: 'R001', expectedRevision: 2 }]);
  reloaded.complete();
  assert.equal(reloaded.begin('sha-two', []).requestId, 'request-two');
});

test('filters hide dropped findings by default and search all relevant evidence', () => {
  const rows = [finding({ evidence: 'request ordering' }), finding({ id: 'R002', status: 'dropped', decision: 'dont_fix' }), finding({ id: 'R003', title: 'Other', location: { path: 'src/parser.ts', line: 12 } })];
  assert.equal(visibleFindings(rows).length, 2);
  assert.deepEqual(visibleFindings(rows, { query: 'ordering' }).map(row => row.id), ['R001']);
  assert.deepEqual(visibleFindings(rows, { query: 'parser.ts' }).map(row => row.id), ['R003']);
  assert.equal(visibleFindings(rows, { showDropped: true }).length, 3);
});

test('submission waits for every draft save and sends the exact review identity', async () => {
  const saved = deferred();
  let sent = null;
  const store = makeStore(async () => saved.promise);
  store.ingest([finding()]);
  store.update('R001', { decision: 'fix' });
  const attempt = new SubmissionAttempt({ reviewId: 'review-one', randomUUID: () => 'request-one' });
  const submitting = sendSubmission({ drafts: store, attempt, reviewedSha: 'sha-one', send: async payload => { sent = payload; return { batch: { id: 'batch-one' } }; } });
  await Promise.resolve();
  assert.equal(sent, null);
  assert.equal(attempt.pending, null);
  saved.resolve(finding({ decision: 'fix', revision: 1 }));
  assert.deepEqual(await submitting, { batch: { id: 'batch-one' } });
  assert.deepEqual(sent, { requestId: 'request-one', reviewId: 'review-one', reviewedSha: 'sha-one', findings: [{ id: 'R001', expectedRevision: 1 }] });
  store.destroy();
});

test('a failed draft flush never creates a submit request or sends a batch', async () => {
  const store = makeStore(async () => { throw new Error('Save unavailable'); });
  store.ingest([finding()]);
  store.update('R001', { decision: 'fix' });
  const attempt = new SubmissionAttempt({ reviewId: 'review-one', randomUUID: () => 'request-one' });
  await assert.rejects(sendSubmission({ drafts: store, attempt, reviewedSha: 'sha-one', send: () => assert.fail('must not submit') }), /Save unavailable/);
  assert.equal(attempt.pending, null);
  store.destroy();
});

test('debounced autosave persists only the newest context', async () => {
  const called = deferred();
  const calls = [];
  const store = makeStore(async (id, draft) => { calls.push(draft); called.resolve(); return finding({ ...draft, revision: 1 }); }, { debounceMs: 1 });
  store.ingest([finding()]);
  store.update('R001', { decision: 'clarify', context: 'A' });
  store.update('R001', { context: 'A complete question' });
  await called.promise;
  await store.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context, 'A complete question');
  store.destroy();
});

test('a fresh tab recovers the original failed page submission without retrying chat batches', () => {
  const state = {
    review: { id: 'review-one', reviewedSha: 'sha-one' },
    delivery: { status: 'failed' },
    batches: [{ id: 'page-batch', requestId: 'original-request', source: 'page', items: [{ id: 'R001', revision: 5, decision: 'fix' }] }, { id: 'chat-batch', requestId: 'chat-request', source: 'chat', items: [] }],
    deliveries: [{ batchId: 'page-batch', status: 'failed' }, { batchId: 'chat-batch', status: 'manual' }],
  };
  assert.deepEqual(recoverSubmission(state), { requestId: 'original-request', reviewId: 'review-one', reviewedSha: 'sha-one', findings: [{ id: 'R001', expectedRevision: 5 }] });
  state.deliveries[0].status = 'sent';
  state.delivery.status = 'sent';
  assert.equal(recoverSubmission(state), null);
});

test('new submissions snapshot exactly decided unsubmitted findings after flush', async () => {
  const store = makeStore(async (id, draft) => finding({ id, ...draft, revision: 4 }));
  store.ingest([
    finding({ id: 'R001', decision: 'fix', revision: 2 }),
    finding({ id: 'R002', decision: null, revision: 8 }),
    finding({ id: 'R003', decision: 'clarify', revision: 3, submittedRevision: 3, status: 'clarify' }),
    finding({ id: 'R004', decision: 'dont_fix', revision: 6 }),
  ]);
  store.update('R001', { context: 'Updated before submit' });
  const attempt = new SubmissionAttempt({ reviewId: 'review-one', randomUUID: () => 'request-one' });
  let sent;
  await sendSubmission({ drafts: store, attempt, reviewedSha: 'sha-one', send: async payload => { sent = payload; } });
  assert.deepEqual(sent.findings, [{ id: 'R001', expectedRevision: 4 }, { id: 'R004', expectedRevision: 6 }]);
  store.destroy();
});

test('network retry preserves the submitted snapshot even after a poll discovers another tab decision', async () => {
  const store = makeStore(async () => assert.fail('No draft save expected'));
  store.ingest([finding({ decision: 'fix', revision: 1 })]);
  const attempt = new SubmissionAttempt({ reviewId: 'review-one', randomUUID: () => 'request-one' });
  const calls = [];
  const send = async payload => { calls.push(structuredClone(payload)); if (calls.length === 1) throw new Error('Network unavailable'); };
  await assert.rejects(sendSubmission({ drafts: store, attempt, reviewedSha: 'sha-one', send }), /Network unavailable/);
  store.ingest([finding({ decision: 'dont_fix', context: 'Other tab changed its mind', revision: 2 }), finding({ id: 'R002', decision: 'fix', revision: 1 })]);
  await sendSubmission({ drafts: store, attempt, reviewedSha: 'sha-one', send });
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[1].findings, [{ id: 'R001', expectedRevision: 1 }]);
  store.destroy();
});

test('a submit conflict blocks retry across reload until an explicit fresh-review reset', async () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const store = makeStore(async () => assert.fail('No draft save expected'));
  store.ingest([finding({ decision: 'fix', revision: 1 })]);
  const attempt = new SubmissionAttempt({ storage, reviewId: 'review-one', randomUUID: () => 'request-one' });
  await assert.rejects(sendSubmission({ drafts: store, attempt, reviewedSha: 'sha-one', send: async () => { throw Object.assign(new Error('Snapshot changed'), { status: 409 }); } }), /Snapshot changed/);
  assert.equal(attempt.reloadRequired, 'Snapshot changed');
  store.ingest([finding({ decision: 'dont_fix', revision: 2 })]);
  const reloaded = new SubmissionAttempt({ storage, reviewId: 'review-one', randomUUID: () => 'request-two' });
  await assert.rejects(sendSubmission({ drafts: store, attempt: reloaded, reviewedSha: 'sha-one', send: () => assert.fail('Must not resubmit an unseen newer snapshot') }), /Reload/i);
  assert.deepEqual(reloaded.pending.findings, [{ id: 'R001', expectedRevision: 1 }]);
  reloaded.complete();
  let sent;
  await sendSubmission({ drafts: store, attempt: reloaded, reviewedSha: 'sha-one', send: async payload => { sent = payload; } });
  assert.equal(sent.requestId, 'request-two');
  assert.deepEqual(sent.findings, [{ id: 'R001', expectedRevision: 2 }]);
  store.destroy();
});

test('tabs group findings by what happens next', () => {
  const rows = [
    finding({ id: 'R001' }),
    finding({ id: 'R002', decision: 'fix' }),
    finding({ id: 'R003', decision: 'fix', submittedRevision: 1, status: 'running' }),
    finding({ id: 'R004', decision: 'clarify', submittedRevision: 1, status: 'clarify' }),
    finding({ id: 'R005', decision: 'fix', submittedRevision: 1, status: 'failed' }),
    finding({ id: 'R006', decision: 'fix', submittedRevision: 1, status: 'completed' }),
    finding({ id: 'R007', decision: 'dont_fix', submittedRevision: 1, status: 'dropped' }),
  ];
  const ids = filter => visibleFindings(rows, { filter }).map(row => row.id);
  assert.deepEqual(ids('pending'), ['R001']);
  assert.deepEqual(ids('decided'), ['R002']);
  assert.deepEqual(ids('progress'), ['R003', 'R004', 'R005']);
  assert.deepEqual(ids('done'), ['R006', 'R007']);
  assert.deepEqual(tabCounts(rows), { pending: 1, decided: 1, progress: 3, done: 2, all: 7 });
});

test('list tags describe drafts, submitted work, and save problems', () => {
  assert.deepEqual(findingTag(finding()), { text: 'No choice', tone: 'none' });
  assert.deepEqual(findingTag(finding({ decision: 'dont_fix' })), { text: 'Don’t fix', tone: 'skip' });
  assert.deepEqual(findingTag(finding({ decision: 'fix', submittedRevision: 1, status: 'running' })), { text: 'Fixing', tone: 'run' });
  assert.deepEqual(findingTag(finding({ decision: 'clarify', submittedRevision: 1, status: 'clarify' })), { text: 'In chat', tone: 'ask' });
  assert.deepEqual(findingTag(finding({ decision: 'fix', saveState: 'error' })), { text: 'Not saved', tone: 'danger' });
});

test('keyboard navigation stays inside the visible list', () => {
  const ids = ['R001', 'R002', 'R003'];
  assert.equal(stepSelection(ids, 'R001', 1), 'R002');
  assert.equal(stepSelection(ids, 'R003', 1), 'R003');
  assert.equal(stepSelection(ids, 'R001', -1), 'R001');
  assert.equal(stepSelection(ids, 'R009', 1), 'R001');
  assert.equal(stepSelection(ids, 'R009', -1), 'R003');
  assert.equal(stepSelection([], 'R001', 1), null);
});

test('type filters start empty, show everything, and narrow by group', () => {
  const rows = [
    finding({ id: 'R001', label: 'issue', blocking: true }),
    finding({ id: 'R002', label: 'suggestion', blocking: false }),
    finding({ id: 'R003', label: 'question', blocking: false }),
    finding({ id: 'R004', label: 'issue', blocking: false }),
  ];
  const ids = kinds => visibleFindings(rows, { kinds: new Set(kinds) }).map(row => row.id);
  assert.deepEqual(ids([]), ['R001', 'R002', 'R003', 'R004']);
  assert.deepEqual(visibleFindings(rows, {}).length, 4);
  assert.deepEqual(ids(['blocking']), ['R001']);
  assert.deepEqual(ids(['label:suggestion', 'label:question']), ['R002', 'R003']);
  assert.deepEqual(ids(['label:issue', 'non-blocking']), ['R004']);
  assert.deepEqual(ids(['blocking', 'non-blocking']), ['R001', 'R002', 'R003', 'R004']);
  assert.equal(matchesKinds(rows[0], null), true);
  assert.deepEqual(kindFilters(rows).map(f => [f.key, f.text, f.count]), [
    ['blocking', 'Blocking', 1], ['non-blocking', 'Non-blocking', 3],
    ['label:issue', 'Issue', 2], ['label:suggestion', 'Suggestion', 1], ['label:question', 'Question', 1],
  ]);
  assert.equal(tabCounts(rows, new Set(['blocking'])).all, 1);
  assert.equal(tabCounts(rows).all, 4);
});
