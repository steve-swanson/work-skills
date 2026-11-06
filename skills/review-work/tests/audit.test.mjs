import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReview, ReviewStore } from '../assets/runtime/store.mjs';
import { startServer } from '../assets/runtime/server.mjs';
import { assessRisk, routeTask } from '../assets/runtime/routing.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-work-audit-'));
  const repo = path.join(root, 'project');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-b', 'develop');
  git('config', 'user.name', 'Review Audit Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'example.txt'), 'fixture\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const stores = [];
  const makeStore = () => {
    const result = createReview({ repo, home: path.join(root, 'home'), branch: 'develop' });
    const store = new ReviewStore(result.reviewDir);
    stores.push(store);
    return store;
  };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { makeStore, store: makeStore() };
}

function approve(store, id) {
  store.addFindings([{ id, label: 'issue', blocking: true, title: 'Fixture defect', evidence: 'Observed fixture failure', location: { path: 'example.txt', line: 1 } }]);
  store.editDraft(id, { decision: 'fix', context: '', expectedRevision: 0 });
  store.submit({ requestId: `approve-${id}`, reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha, findings: [{ id, expectedRevision: 1 }] });
}

function task(store, id, findingId, role = 'implementation') {
  return { id, role, findingIds: [findingId], model: 'gpt-6-astra', effort: 'xhigh', provider: 'fixture', startSha: store.manifest.reviewedSha };
}

const complete = commit => ({ status: 'completed', commit, checks: [{ command: 'fixture acceptance', status: 'passed' }] });

test('chat may cancel a queued fix, but cannot discard an assigned fix', t => {
  const { store } = fixture(t); approve(store, 'R001'); approve(store, 'R002');
  store.resolve('R001', {decision:'dont_fix',resolution:'User changed their mind before dispatch.',requestId:'cancel-one'});
  assert.equal(store.finding('R001').status,'dropped');
  store.reserveTask(task(store,'assigned','R002'));
  assert.throws(()=>store.resolve('R002',{decision:'dont_fix',resolution:'Changed mind.',requestId:'cancel-two'}), /Active|scope/i);
});

test('a new coordinator or target checkpoint invalidates combined verification', t => {
  const {store}=fixture(t); store.record('coverage',{scope:'example.txt',status:'checked'}); approve(store,'R001');
  store.reserveTask(task(store,'fix','R001')); store.updateTask('fix',complete('fix-head'));
  store.record('coordinator',{branch:'fix/retry-recovery',sha:'fix-head',targetSha:'target-one'});
  store.record('verification',{scope:'combined',status:'passed',sha:'fix-head'});
  assert.equal(store.readiness().ready,true);
  store.record('coordinator',{branch:'fix/retry-recovery',sha:'rebased-head',targetSha:'target-two'});
  assert.equal(store.readiness().ready,false);
  store.record('verification',{scope:'combined',status:'passed',sha:'rebased-head'});
  assert.equal(store.readiness().ready,true);
});

test('a delayed failed-task replay cannot overwrite its completed retry', t => {
  const { store } = fixture(t);
  approve(store, 'R001');
  store.reserveTask(task(store, 'first', 'R001'));
  store.updateTask('first', { status: 'failed', error: 'Confirmed host failure' });
  store.reserveTask(task(store, 'retry', 'R001'));
  store.updateTask('retry', complete('retry-commit'));
  store.updateTask('first', { status: 'failed', error: 'Confirmed host failure' });
  assert.equal(store.finding('R001').status, 'completed');
  assert.throws(() => store.updateTask('first', { status: 'failed', error: 'Changed failure' }), /immutable|terminal/i);
  assert.equal(store.finding('R001').status, 'completed');
});

test('combined verification must be repeated after a later approved fix', t => {
  const { store } = fixture(t);
  store.record('coverage', { scope: 'example.txt', status: 'checked' });
  approve(store, 'R001');
  store.reserveTask(task(store, 'first', 'R001'));
  store.updateTask('first', complete('head-one'));
  store.record('verification', { scope: 'combined', status: 'passed', sha: 'head-one' });
  assert.equal(store.readiness().ready, true);
  approve(store, 'R002');
  store.reserveTask(task(store, 'second', 'R002'));
  store.updateTask('second', complete('head-two'));
  assert.equal(store.readiness().ready, false);
  assert.throws(() => store.setClosed(true), /Combined verification/i);
  store.record('verification', { scope: 'combined', status: 'passed', sha: 'head-two' });
  assert.equal(store.readiness().ready, true);
});

test('a later failed combined check invalidates an earlier successful check', t => {
  const { store } = fixture(t);
  store.record('coverage', { scope: 'example.txt', status: 'checked' });
  approve(store, 'R001');
  store.reserveTask(task(store, 'fix', 'R001'));
  store.updateTask('fix', complete('head-one'));
  store.record('verification', { scope: 'combined', status: 'passed', sha: 'head-one' });
  store.record('verification', { scope: 'combined', status: 'failed', sha: 'head-one' });
  assert.equal(store.readiness().ready, false);
});

test('completed coverage supersedes incomplete history for the same scope', t => {
  const { store } = fixture(t);
  store.record('coverage', { scope: 'example.txt', status: 'incomplete' });
  assert.equal(store.readiness().ready, false);
  store.record('coverage', { scope: 'example.txt', status: 'checked' });
  assert.equal(store.readiness().ready, true);
  assert.equal(store.state().coverage.length, 2, 'History must remain available.');
});

test('review, verification, and coordinator tasks cannot own and complete approved fixes', t => {
  const { store } = fixture(t);
  approve(store, 'R001');
  for (const role of ['review', 'verification', 'coordinator']) {
    assert.throws(() => store.reserveTask(task(store, role, 'R001', role)), /implementation|ownership|finding/i);
  }
  assert.equal(store.finding('R001').status, 'queued');
  assert.equal(store.state().tasks.length, 0);
});

test('a stale submit cannot authorize a newer decision from another tab', t => {
  const { store } = fixture(t);
  store.addFindings([{ id: 'R001', label: 'issue', blocking: true, title: 'Fixture defect', evidence: 'Observed fixture failure', location: { path: 'example.txt', line: 1 } }]);
  store.editDraft('R001', { decision: 'dont_fix', context: 'Tab A viewed this choice', expectedRevision: 0 });
  store.editDraft('R001', { decision: 'fix', context: 'Tab B has not submitted this choice', expectedRevision: 1 });
  assert.throws(() => store.submit({ requestId: 'tab-a-submit', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha,
    findings: [{ id: 'R001', expectedRevision: 1 }] }), /revision|stale|changed/i);
  assert.equal(store.state().batches.length, 0);
  assert.equal(store.finding('R001').submittedRevision, null);
  assert.equal(store.finding('R001').status, 'unreviewed');
});

test('submission authorizes only its explicit finding snapshot and replays exactly once', t => {
  const { store } = fixture(t);
  store.addFindings(['R001', 'R002'].map(id => ({ id, label: 'issue', blocking: true, title: 'Fixture defect', evidence: 'Observed fixture failure', location: { path: 'example.txt', line: 1 } })));
  for (const id of ['R001', 'R002']) store.editDraft(id, { decision: 'fix', context: '', expectedRevision: 0 });
  const request = { requestId: 'tab-a-submit', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha,
    findings: [{ id: 'R001', expectedRevision: 1 }] };
  const batch = store.submit(request);
  assert.deepEqual(batch.items.map(item => item.id), ['R001']);
  assert.equal(store.finding('R002').submittedRevision, null);
  assert.equal(store.finding('R002').status, 'unreviewed');
  assert.equal(store.submit(request).id, batch.id);
  assert.equal(store.state().batches.length, 1);
});

test('a stale item rejects the entire submit snapshot without partially authorizing it', t => {
  const { store } = fixture(t);
  store.addFindings(['R001', 'R002'].map(id => ({ id, label: 'issue', blocking: true, title: 'Fixture defect', evidence: 'Observed fixture failure', location: { path: 'example.txt', line: 1 } })));
  for (const id of ['R001', 'R002']) store.editDraft(id, { decision: 'fix', context: '', expectedRevision: 0 });
  store.editDraft('R002', { decision: 'dont_fix', context: '', expectedRevision: 1 });
  assert.throws(() => store.submit({ requestId: 'stale-batch', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha,
    findings: ['R001', 'R002'].map(id => ({ id, expectedRevision: 1 })) }), /revision|stale|changed/i);
  assert.equal(store.state().batches.length, 0);
  for (const id of ['R001', 'R002']) assert.equal(store.finding(id).submittedRevision, null);
});

test('simultaneous review pages retain independent sessions in one browser cookie jar', async t => {
  const { makeStore, store } = fixture(t);
  const first = await startServer({ reviewDir: store.directory });
  const second = await startServer({ reviewDir: makeStore().directory });
  try {
    // Cookies share the host across ports. Preserve both only if their names differ.
    const jar = new Map();
    for (const service of [first, second]) {
      const landing = await fetch(service.url);
      await landing.text();
      const pair = landing.headers.get('set-cookie').split(';')[0];
      jar.set(pair.slice(0, pair.indexOf('=')), pair);
    }
    assert.equal(jar.size, 2, 'Opening the second page must not overwrite the first session.');
    const cookie = [...jar.values()].join('; ');
    for (const service of [first, second]) {
      const response = await fetch(`${service.url}/api/state`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      await response.json();
    }
  } finally { await first.close(); await second.close(); }
});

test('recognized vulnerability work cannot be mislabeled ordinary and routed below the security floor', async () => {
  const catalog = [
    { id: 'gpt-6-mini', family: 'gpt', effortOptionId: 'reasoning_effort', efforts: ['low', 'high'] },
    { id: 'gpt-6-astra', family: 'gpt', effortOptionId: 'reasoning_effort', efforts: ['xhigh'] },
  ];
  for (const description of ['Fix SQL injection in the search query', 'Review CSRF token validation', 'Patch stored XSS in comments', 'Review access-control bypass', 'Review session cookie handling']) {
    const task = { description, risk: 'ordinary' };
    assert.equal(assessRisk(task).category, 'security', description);
    const result = await routeTask({ callerRole: 'main', selectedModel: 'gpt-6-astra', catalog, task,
      judgment: { modelId: 'gpt-6-mini', effort: 'low', reason: 'Caller mislabeled task as ordinary' }, credentialOptions: { env: {} } });
    assert.notEqual(result.status, 'routed', description);
  }
});
