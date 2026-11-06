import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReview, ReviewStore, readManifest, listReviews } from '../assets/runtime/store.mjs';
import { startServer, notifyBatch, prefsFile, readPrefs } from '../assets/runtime/server.mjs';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-work-runtime-'));
  const resources = [];
  const cleanup = callback => resources.push(callback);
  // Node test hooks run in registration order. Close services and SQLite
  // handles before removing their files, which Windows refuses while open.
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'develop'); git(repo, 'config', 'user.name', 'Review Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'example.txt'), 'initial\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const result = createReview({ repo, branch: 'develop', home, conversationId: 'test-conversation', reviewMode: 'fanout', maxReviewers: 2, ...options });
  const store = new ReviewStore(result.reviewDir); cleanup(() => store.close());
  return { root, repo, home, result, store, cleanup };
}
function finding(id = 'R001', overrides = {}) {
  return { id, label: 'issue', blocking: true, title: 'Duplicate processing on retry', discussion: 'An interrupted request can be processed twice.', evidence: 'Two requests reach the same write path.', suggestion: 'Make the operation idempotent.', location: { path: 'example.txt', line: 1 }, ...overrides };
}
function approve(store, id = 'R001', requestId = 'batch-1') {
  store.editDraft(id, { decision: 'fix', context: 'Preserve public behavior', expectedRevision: 0 });
  return store.submit({ requestId, reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha, findings: [{id, expectedRevision: store.finding(id).revision}] });
}

test('initialization is isolated, durable, ignored, and does not edit the reviewed checkout', t => {
  const { repo, home, result, store, cleanup } = fixture(t);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(store.manifest.scope, 'snapshot');
  assert.equal(store.manifest.reviewedSha, git(repo, 'rev-parse', 'HEAD'));
  assert.ok(result.reviewDir.startsWith(path.join(home, '.agents', 'state', 'review-work')));
  assert.equal(fs.readFileSync(path.join(result.stateRoot, '.gitignore'), 'utf8').trim(), '*');
  store.addFindings([finding()]);
  store.record('coverage', { scope: 'example.txt', status: 'checked', summary: 'Read the complete flow' });
  const again = new ReviewStore(result.reviewDir); cleanup(() => again.close());
  assert.equal(again.state().findings[0].id, 'R001');
  assert.equal(again.state().coverage[0].status, 'checked');
  assert.equal(listReviews({ home, conversationId: 'test-conversation' }).length, 1);
  assert.equal(listReviews({ home, conversationId: 'other-conversation' }).length, 0);
});

test('separate clones and repeated runs cannot collide; linked worktrees share repo identity', t => {
  const { root, repo, home, result } = fixture(t);
  const second = createReview({ repo, home, branch: 'develop' });
  assert.notEqual(result.reviewDir, second.reviewDir);
  assert.equal(readManifest(result.reviewDir).repoId, readManifest(second.reviewDir).repoId);
  const wt = path.join(root, 'linked'); git(repo, 'worktree', 'add', '--detach', wt, 'HEAD');
  const linked = createReview({ repo: wt, home, branch: 'develop' });
  assert.equal(readManifest(linked.reviewDir).repoId, readManifest(result.reviewDir).repoId);
  const clone = path.join(root, 'clone'); git(root, 'clone', '--no-hardlinks', repo, clone);
  const cloned = createReview({ repo: clone, home, branch: 'develop' });
  assert.notEqual(readManifest(cloned.reviewDir).repoId, readManifest(result.reviewDir).repoId);
});

test('feature review requires a base and stores its frozen merge-base', t => {
  const { repo, home } = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD'); git(repo, 'switch', '-c', 'feature/example');
  fs.appendFileSync(path.join(repo, 'example.txt'), 'feature\n'); git(repo, 'commit', '-am', 'feature');
  assert.throws(() => createReview({ repo, home, branch: 'feature/example' }), /base/i);
  const result = createReview({ repo, home, branch: 'feature/example', base: 'develop' });
  assert.equal(readManifest(result.reviewDir).scope, 'diff');
  assert.equal(readManifest(result.reviewDir).baseSha, base);
});

test('draft edits preserve context, reject stale saves, and do not queue work', t => {
  const { store } = fixture(t); store.addFindings([finding()]);
  const first = store.editDraft('R001', { decision: 'fix', context: 'Do not change expiry', expectedRevision: 0 });
  assert.equal(first.status, 'unreviewed'); assert.equal(store.state().batches.length, 0);
  const second = store.editDraft('R001', { decision: 'clarify', context: first.context, expectedRevision: first.revision });
  assert.equal(second.context, 'Do not change expiry');
  assert.throws(() => store.editDraft('R001', { decision: 'dont_fix', context: '', expectedRevision: 0 }), /revision/i);
  assert.equal(store.state().findings[0].decision, 'clarify');
});

test('submission is immutable and idempotent, and untouched findings remain undecided', t => {
  const { store } = fixture(t); store.addFindings([finding(), finding('R002')]);
  const batch = approve(store);
  assert.equal(batch.items.length, 1); assert.equal(batch.items[0].context, 'Preserve public behavior');
  const repeat = store.submit({ requestId: 'batch-1', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha });
  assert.equal(repeat.id, batch.id); assert.equal(store.state().batches.length, 1);
  assert.equal(store.state().findings[1].decision, null);
  assert.throws(() => store.editDraft('R001', { decision: 'dont_fix', context: '', expectedRevision: 1 }), /submitted/i);
  assert.throws(() => store.submit({ requestId: 'foreign', reviewId: 'wrong', reviewedSha: store.manifest.reviewedSha }), /review/i);
  assert.throws(() => store.submit({ requestId: 'stale', reviewId: store.manifest.id, reviewedSha: 'bad' }), /commit/i);
});

test('chat clarification creates a later batch in the same review without another UI approval', t => {
  const { store } = fixture(t); store.addFindings([finding()]);
  store.editDraft('R001', { decision: 'clarify', context: 'Keep old links valid?', expectedRevision: 0 });
  store.submit({ requestId: 'clarify-1', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha, findings: [{id:'R001',expectedRevision:1}] });
  const resolved = store.resolve('R001', { decision: 'fix', context: 'Preserve existing links', resolution: 'User confirmed backwards compatibility.', requestId: 'chat-1' });
  assert.equal(resolved.items[0].decision, 'fix'); assert.equal(store.state().batches.length, 2);
  assert.equal(store.state().findings[0].status, 'queued');
  assert.equal(store.resolve('R001', { decision: 'fix', context: 'Preserve existing links', resolution: 'User confirmed backwards compatibility.', requestId: 'chat-1' }).id, resolved.id);
});

test('task reservations enforce authorization, concurrency, ownership and replay identity', t => {
  const { store } = fixture(t); store.addFindings([finding(), finding('R002'), finding('R003')]);
  approve(store, 'R001', 'approve-1'); approve(store, 'R002', 'approve-2');
  const task = { id: 'fix-1', role: 'implementation', findingIds: ['R001'], model: 'gpt-6-astra', effort: 'xhigh', provider: 'codex', startSha: store.manifest.reviewedSha };
  const first = store.reserveTask(task); assert.ok(first.clientRequestId.includes(store.manifest.id));
  assert.equal(store.reserveTask(task).clientRequestId, first.clientRequestId);
  assert.throws(() => store.reserveTask({ ...task, model: 'different' }), /different|conflict/i);
  assert.throws(() => store.reserveTask({ ...task, id: 'duplicate-owner' }), /assigned/i);
  assert.throws(() => store.reserveTask({ ...task, id: 'unapproved', findingIds: ['R003'] }), /approved/i);
  store.reserveTask({ ...task, id: 'fix-2', findingIds: ['R002'] });
  assert.throws(() => store.reserveTask({ id: 'review-3', role: 'review', findingIds: [], model: 'gpt-6-astra', effort: 'xhigh', provider: 'codex', startSha: store.manifest.reviewedSha }), /concurrent|capacity/i);
  store.updateTask('fix-1', { status: 'running', externalId: 'actual-delegate-1' });
  store.updateTask('fix-1', { status: 'verifying' });
  store.updateTask('fix-1', { status: 'completed', commit: 'fixture-commit', checks: [{ command: 'node --test', status: 'passed' }] });
  assert.equal(store.state().findings[0].status, 'completed');
});

test('failed delivery retries the same persisted batch rather than creating duplicate work', async t => {
  const { store } = fixture(t, { deliveryMode: 't3', conversationId: 'bound-thread', t3Command: [process.execPath, 'fixture-cli.mjs'] });
  store.addFindings([finding()]); const batch = approve(store); let count = 0;
  await notifyBatch(store, batch.id, async () => { count++; throw new Error('connection refused'); });
  assert.equal(store.state().delivery.status, 'failed'); assert.equal(store.state().batches.length, 1);
  await notifyBatch(store, batch.id, async ({ manifest, batch: sent }) => { count++; assert.equal(manifest.conversationId, 'bound-thread'); assert.equal(sent.id, batch.id); return { accepted: true }; });
  await notifyBatch(store, batch.id, async () => { count++; });
  assert.equal(count, 2); assert.equal(store.state().delivery.status, 'sent');
});

test('loopback API requires a session and same-origin mutation; draft and submit survive service restart', async t => {
  const { root, store, result, cleanup } = fixture(t); store.addFindings([finding()]);
  const publicDir = path.join(root, 'public'); fs.mkdirSync(publicDir); fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><p>Fixture</p>');
  const server = await startServer({ reviewDir: result.reviewDir, publicDir }); cleanup(() => server.close());
  const anonymous = await fetch(`${server.url}/api/state`); assert.equal(anonymous.status, 401);
  const landing = await fetch(server.url); const cookie = landing.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' };
  const rejected = await fetch(`${server.url}/api/findings/R001`, { method: 'PATCH', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: JSON.stringify({ decision: 'fix', context: '', expectedRevision: 0 }) });
  assert.equal(rejected.status, 403);
  const patched = await fetch(`${server.url}/api/findings/R001`, { method: 'PATCH', headers, body: JSON.stringify({ decision: 'fix', context: 'A <script>literal</script> note', expectedRevision: 0 }) });
  assert.equal(patched.status, 200); assert.equal((await patched.json()).finding.context, 'A <script>literal</script> note');
  const submitted = await fetch(`${server.url}/api/submit`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'http-submit', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha, findings:[{id:'R001',expectedRevision:1}] }) });
  assert.equal(submitted.status, 200); assert.equal((await submitted.json()).state.findings[0].status, 'queued');
  await assert.rejects(startServer({ reviewDir: result.reviewDir, publicDir }), /already|running/i);
  await server.close();
  const restarted = await startServer({ reviewDir: result.reviewDir, publicDir }); cleanup(() => restarted.close());
  assert.equal(store.state().batches.length, 1);
  assert.equal(store.state().findings[0].context, 'A <script>literal</script> note');
});

test('display settings are shared by every review page on the machine and only accept known keys', async t => {
  const { root, store, result, cleanup } = fixture(t); store.addFindings([finding()]);
  const publicDir = path.join(root, 'public'); fs.mkdirSync(publicDir); fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><p>Fixture</p>');
  const server = await startServer({ reviewDir: result.reviewDir, publicDir }); cleanup(() => server.close());
  assert.equal((await fetch(`${server.url}/api/prefs`)).status, 401);
  const cookie = (await fetch(server.url)).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' };
  assert.deepEqual(await (await fetch(`${server.url}/api/prefs`, { headers })).json(), { theme: 'auto', listHidden: false });
  assert.equal((await fetch(`${server.url}/api/prefs`, { method: 'PUT', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: JSON.stringify({ theme: 'dark' }) })).status, 403);
  assert.equal((await fetch(`${server.url}/api/prefs`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'neon' }) })).status, 400);
  assert.equal((await fetch(`${server.url}/api/prefs`, { method: 'PUT', headers, body: JSON.stringify({ secret: 'x' }) })).status, 400);
  const saved = await fetch(`${server.url}/api/prefs`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'dark' }) });
  assert.deepEqual(await saved.json(), { theme: 'dark', listHidden: false });
  await fetch(`${server.url}/api/prefs`, { method: 'PUT', headers, body: JSON.stringify({ listHidden: true }) });
  const file = prefsFile(result.reviewDir);
  assert.equal(path.dirname(file), path.resolve(result.reviewDir, '..', '..', '..'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark', listHidden: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readPrefs(file), { theme: 'auto', listHidden: false });
});

test('findings accept an optional code excerpt and reject malformed ones', t => {
  const { store } = fixture(t);
  const excerpt = { startLine: 41, code: 'const a = 1;\r\nconst b = 2;\nreturn a + b;\n', highlight: [43, 42] };
  const [saved] = store.addFindings([finding('R001', { excerpt })]);
  assert.deepEqual(saved.excerpt, { startLine: 41, code: 'const a = 1;\nconst b = 2;\nreturn a + b;', highlight: [42, 43] });
  assert.deepEqual(store.addFindings([finding('R001', { excerpt })])[0].excerpt, saved.excerpt);
  assert.equal(store.addFindings([finding('R002')])[0].excerpt, undefined);
  const bad = [
    { startLine: 0, code: 'x' },
    { startLine: 1, code: '' },
    { startLine: 1, code: 'x', highlight: [2] },
    { startLine: 1, code: 'x', highlight: [1, 1] },
    { startLine: 1, code: Array.from({ length: 21 }, (_, i) => `line ${i}`).join('\n') },
    { startLine: 1, code: 'x', path: '/etc/passwd' },
    'not an object',
  ];
  for (const [index, value] of bad.entries()) assert.throws(() => store.addFindings([finding(`R1${index}`, { excerpt: value })]), /excerpt/i);
});

test('a Don\'t fix note is saved, kept after Submit, and carried in the batch', t => {
  const { store } = fixture(t); store.addFindings([finding()]);
  const note = 'Intended behavior; tracked in BILL-412.';
  const draft = store.editDraft('R001', { decision: 'dont_fix', context: note, expectedRevision: 0 });
  assert.equal(draft.context, note);
  const batch = store.submit({ requestId: 'skip-1', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha, findings: [{ id: 'R001', expectedRevision: draft.revision }] });
  assert.deepEqual(batch.items.map(item => [item.decision, item.context]), [['dont_fix', note]]);
  const [current] = store.state().findings;
  assert.equal(current.status, 'dropped'); assert.equal(current.context, note);
});
