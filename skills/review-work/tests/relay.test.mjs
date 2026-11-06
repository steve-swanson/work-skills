import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReview, createMirror, ReviewStore, frameRelay, unframeRelay, readManifest } from '../assets/runtime/store.mjs';
import { notificationMessage } from '../assets/runtime/server.mjs';
import { runCli } from '../assets/runtime/cli.mjs';

const ENV = '7b95aeb2-2e4b-4644-bc5c-46c51c0116ca';
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function finding(id, overrides = {}) {
  return { id, label: 'issue', blocking: true, title: `Finding ${id}`, discussion: 'Why it matters.', evidence: 'example.txt:1 shows it.', suggestion: 'Small fix: change it.', location: { path: 'example.txt', line: 1 }, ...overrides };
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-work-relay-'));
  const stores = [];
  t.after(() => { for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'develop'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'example.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const source = createReview({ repo, branch: 'develop', home: path.join(root, 'review-home'), deliveryMode: 't3', conversationId: 'review-thread', t3Command: [process.execPath, 'fixture-t3.mjs'], ...options });
  const open = dir => { const s = new ReviewStore(dir); stores.push(s); return s; };
  const store = open(source.reviewDir);
  store.addFindings([finding('R001'), finding('R002', { label: 'question', blocking: false }), finding('R003', { excerpt: { startLine: 1, code: 'one', highlight: [1] } })]);
  store.record('coverage', { id: 'all', status: 'checked', paths: ['example.txt'] });
  return { root, source, store, open };
}
function mirrorOf(ctx, store) {
  const bundle = unframeRelay('page', [`🐤 Here it is:\n${frameRelay('page', store.pageBundle({ environmentId: ENV }))}`]);
  const mirror = createMirror({ bundle, home: path.join(ctx.root, 'page-home'), conversationId: 'page-thread', t3Command: [process.execPath, 'fixture-t3.mjs'] });
  return { mirror, page: ctx.open(mirror.reviewDir) };
}
function submitAll(page, choices) {
  for (const [id, decision, context] of choices) page.editDraft(id, { decision, context, expectedRevision: page.finding(id).revision });
  return page.submit({ requestId: 'page-submit-1', reviewId: page.manifest.id, reviewedSha: page.manifest.reviewedSha, findings: choices.map(([id]) => ({ id, expectedRevision: page.finding(id).revision })) });
}

test('a page copy on another machine round-trips choices and notes back to the review', t => {
  const ctx = setup(t); const { store } = ctx;
  store.editDraft('R003', { decision: 'clarify', context: 'Draft made on the review machine.', expectedRevision: 0 });
  const { mirror, page } = mirrorOf(ctx, store);
  const state = page.state();
  assert.equal(state.review.host, store.manifest.host);
  assert.equal(state.review.mirror.sourceEnvironmentId, ENV);
  assert.equal(state.review.mirror.sourceThreadId, 'review-thread');
  assert.equal(state.review.repoPath, null);
  assert.deepEqual(state.findings.map(f => f.id), ['R001', 'R002', 'R003']);
  assert.equal(page.finding('R003').decision, 'clarify');
  assert.equal(page.finding('R003').context, 'Draft made on the review machine.');
  assert.deepEqual(page.finding('R003').excerpt, { startLine: 1, code: 'one', highlight: [1] });
  assert.equal(state.coverage.length, 1);
  assert.equal(readManifest(mirror.reviewDir).deliveryMode, 't3');

  const batch = submitAll(page, [['R001', 'fix', 'Keep the API.'], ['R002', 'dont_fix', 'Prices are public on purpose.'], ['R003', 'clarify', 'What does support expect?']]);
  const decisions = unframeRelay('decisions', ['older message', `Review-work decisions from page.\n${frameRelay('decisions', page.relayExport(batch.id))}`]);
  const result = store.relayImport(decisions);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.batch.source, 'relay');
  assert.deepEqual(Object.fromEntries(store.state().findings.map(f => [f.id, [f.status, f.context]])), {
    R001: ['queued', 'Keep the API.'], R002: ['dropped', 'Prices are public on purpose.'], R003: ['clarify', 'What does support expect?'],
  });
  assert.equal(store.state().deliveries.at(-1).status, 'manual');
  const again = store.relayImport(decisions);
  assert.equal(again.repeated, true); assert.equal(again.batch.id, result.batch.id);
  assert.equal(store.state().batches.length, 1);
});

test('choices for findings that changed on the review machine are reported, not applied', t => {
  const ctx = setup(t); const { store } = ctx;
  const { page } = mirrorOf(ctx, store);
  store.resolve('R002', { decision: 'fix', resolution: 'User decided in chat.', requestId: 'chat-R002' });
  const batch = submitAll(page, [['R001', 'fix', ''], ['R002', 'dont_fix', '']]);
  const result = store.relayImport(page.relayExport(batch.id));
  assert.deepEqual(result.conflicts, [{ id: 'R002', reason: 'already decided here' }]);
  assert.deepEqual(result.batch.items.map(x => x.id), ['R001']);
  assert.equal(store.finding('R002').decision, 'fix');
});

test('relay frames reject tampering, truncation, and the wrong review', t => {
  const ctx = setup(t); const { store } = ctx;
  const framed = frameRelay('page', store.pageBundle({ environmentId: ENV }));
  assert.throws(() => unframeRelay('page', framed.replace('Finding R001', 'Finding R00X')), /changed in transit/);
  assert.throws(() => unframeRelay('page', framed.split('\n').slice(0, 2).join('\n')), /no end marker/);
  assert.throws(() => unframeRelay('page', framed.replace('{', '{{')), /not valid JSON/);
  assert.equal(unframeRelay('decisions', framed), null);
  const { page } = mirrorOf(ctx, store);
  const batch = submitAll(page, [['R001', 'fix', '']]);
  const body = page.relayExport(batch.id);
  assert.throws(() => store.relayImport({ ...body, sourceReviewId: 'another-review' }), /another review/);
  assert.throws(() => store.relayImport({ ...body, items: [{ ...body.items[0], decision: 'ship_it' }] }), /Invalid decision/);
});

test('page copies cannot run review work, and source reviews cannot export page choices', t => {
  const ctx = setup(t); const { store } = ctx;
  const { page } = mirrorOf(ctx, store);
  assert.throws(() => page.addFindings([finding('R009')]), /page-only copy/);
  assert.throws(() => page.resolve('R001', { decision: 'fix', resolution: 'x', requestId: 'r' }), /page-only copy/);
  assert.throws(() => page.reserveTask({ id: 'T1', role: 'implementation', findingIds: ['R001'] }), /page-only copy/);
  assert.throws(() => page.pageBundle({ environmentId: ENV }), /page-only copy/);
  assert.throws(() => store.relayExport('any'), /page-only copy of a review/);
});

test('a page bundle needs a T3 review chat and open findings', t => {
  const terminal = setup(t, { deliveryMode: 'terminal', conversationId: null, t3Command: null });
  assert.throws(() => terminal.store.pageBundle({ environmentId: ENV }), /T3 review chat/);
  const ctx = setup(t); const { store } = ctx;
  for (const id of ['R001', 'R002', 'R003']) store.resolve(id, { decision: 'dont_fix', resolution: 'Chat.', requestId: `chat-${id}` });
  assert.throws(() => store.pageBundle({ environmentId: ENV }), /already has a submitted choice/);
});

test('the page machine is told exactly where to send the choices', t => {
  const ctx = setup(t); const { store } = ctx;
  const { mirror, page } = mirrorOf(ctx, store);
  const batch = submitAll(page, [['R001', 'fix', '']]);
  const message = notificationMessage(page.manifest, mirror.reviewDir, batch);
  assert.match(message, /^Relay review-work decisions\./);
  assert.ok(message.includes(`relay-export --review ${JSON.stringify(mirror.reviewDir)} --batch ${batch.id}`));
  assert.match(message, /Run: node --no-warnings /);
  assert.ok(message.includes(`environmentId ${JSON.stringify(ENV)}`));
  assert.ok(message.includes('threadId "review-thread"'));
  assert.match(notificationMessage(store.manifest, ctx.source.reviewDir, { id: 'b1' }), /^Resume review-work\./);
});

test('the owner CLI bundles, hosts, exports, and imports through files, and caps bundle size', async t => {
  const ctx = setup(t); const { store, source, root } = ctx;
  const bundled = await runCli(['page-bundle', '--review', source.reviewDir, '--environment', ENV]);
  assert.match(bundled.text, /^REVIEW-WORK-PAGE v1 BEGIN\n/);
  const bundleFile = path.join(root, 'bundle.txt'); fs.writeFileSync(bundleFile, `Host this page.\n${bundled.text}\n`);
  const hosted = await runCli(['page-init', '--input', JSON.stringify({ bundleFile, conversationId: 'page-thread', t3Command: [process.execPath, 'x.mjs'], home: path.join(root, 'cli-page-home') })]);
  assert.equal(hosted.findings, 3);
  const page = ctx.open(hosted.reviewDir);
  const batch = submitAll(page, [['R001', 'fix', 'via cli']]);
  const exported = await runCli(['relay-export', '--review', hosted.reviewDir, '--batch', batch.id]);
  const decisionsFile = path.join(root, 'decisions.txt'); fs.writeFileSync(decisionsFile, exported.text);
  const imported = await runCli(['relay-import', '--review', source.reviewDir, '--input', decisionsFile]);
  assert.deepEqual(imported.batch.items.map(x => [x.id, x.decision, x.context]), [['R001', 'fix', 'via cli']]);
  store.addFindings(Array.from({ length: 30 }, (_, i) => finding(`B${i}`, { discussion: 'x'.repeat(4000) })));
  await assert.rejects(runCli(['page-bundle', '--review', source.reviewDir, '--environment', ENV]), /Show the page on this machine/);
});
