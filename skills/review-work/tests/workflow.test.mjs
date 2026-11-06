import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReview, ReviewStore } from '../assets/runtime/store.mjs';

// Disposable Git protocol fixtures only: these do not create managed agents or external PRs.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = cwd => git(cwd, 'rev-parse', 'HEAD');
const reviewedBranch = 'feature/checkout';
const coordinatorBranch = 'review/checkout-fixes';
const route = { model: 'gpt-6-astra', effort: 'xhigh', provider: 'fixture' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-workflow-test-'));
  let store;
  t.after(() => { store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'primary'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'develop');
  git(repo, 'config', 'user.name', 'Workflow Fixture'); git(repo, 'config', 'user.email', 'workflow@example.invalid');
  const initial = {
    'discount.mjs': 'export const discount = total => total;\n',
    'tax.mjs': 'export const tax = total => total * 1.1;\n',
    'shipping.mjs': 'export const shipping = total => 5;\n',
    'notes.txt': 'unrelated notes\n', 'staged.txt': 'original staged file\n',
  };
  for (const [name, contents] of Object.entries(initial)) fs.writeFileSync(path.join(repo, name), contents);
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base fixture');
  git(repo, 'switch', '-c', reviewedBranch);
  fs.writeFileSync(path.join(repo, 'checkout.mjs'), "import {discount} from './discount.mjs';\nimport {tax} from './tax.mjs';\nimport {shipping} from './shipping.mjs';\nexport const checkout = total => tax(discount(total)) + shipping(discount(total));\n");
  git(repo, 'add', 'checkout.mjs'); git(repo, 'commit', '-m', 'add checkout feature');
  const reviewedSha = head(repo);
  fs.appendFileSync(path.join(repo, 'notes.txt'), 'unrelated unstaged user work\n');
  fs.appendFileSync(path.join(repo, 'staged.txt'), 'unrelated staged user work\n');
  git(repo, 'add', 'staged.txt');
  fs.writeFileSync(path.join(repo, 'draft.txt'), 'unrelated untracked user work\n');
  const untouched = primarySnapshot(repo);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const review = createReview({ repo, home, branch: reviewedBranch, base: 'develop', reviewMode: 'fanout', maxReviewers: 2 });
  store = new ReviewStore(review.reviewDir);
  return { root, repo, reviewedSha, review, store, untouched };
}

function primarySnapshot(repo) {
  return {
    head: head(repo), branch: git(repo, 'branch', '--show-current'),
    status: git(repo, 'status', '--porcelain'), unstaged: git(repo, 'diff', '--binary'), staged: git(repo, 'diff', '--cached', '--binary'),
    notes: fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), stagedFile: fs.readFileSync(path.join(repo, 'staged.txt'), 'utf8'),
    untracked: fs.readFileSync(path.join(repo, 'draft.txt'), 'utf8'),
  };
}

function findings(store, decisions) {
  store.addFindings(decisions.map(([id, file]) => ({ id, label: 'issue', blocking: true, title: `Correct ${file}`, evidence: `Fixture contract fails in ${file}.`, location: { path: file, line: 1 } })));
  for (const [id, , decision] of decisions) store.editDraft(id, { decision, context: 'Preserve the unrelated checkout work.', expectedRevision: 0 });
  return store.submit({ requestId: 'visible-page-batch', reviewId: store.manifest.id, reviewedSha: store.manifest.reviewedSha,
    findings: decisions.map(([id]) => ({ id, expectedRevision: store.finding(id).revision })) });
}

function coordinatorForFixes(f) {
  if (!f.store.state().findings.some(item => item.decision === 'fix' && item.status === 'queued')) return null;
  const directory = path.join(f.root, 'coordinator');
  git(f.repo, 'worktree', 'add', '-b', coordinatorBranch, directory, f.reviewedSha);
  f.store.record('coordinator', { branch: coordinatorBranch, worktreePath: directory, startSha: f.reviewedSha, fixtureOnly: true });
  return directory;
}

function childFix(f, { id, findingId, startSha, file, content, assertions }) {
  const branch = `fix/${id}`;
  const directory = path.join(f.root, id);
  f.store.record('routing', { taskId: id, route: { modelId: route.model, effort: route.effort, effortOptionId: 'reasoning_effort', source: 'fixture' } });
  f.store.reserveTask({ id, role: 'implementation', findingIds: [findingId], ...route, startSha, branch, worktreePath: directory });
  git(f.repo, 'worktree', 'add', '-b', branch, directory, startSha);
  assert.equal(head(directory), startSha);
  f.store.record('worktree', { taskId: id, branch, path: directory, owned: true, status: 'created' });
  f.store.updateTask(id, { status: 'running', externalId: `fixture-${id}` });
  fs.writeFileSync(path.join(directory, file), content);
  git(directory, 'add', file); git(directory, 'commit', '-m', `Fix ${file}`);
  behavior(directory, assertions);
  f.store.updateTask(id, { status: 'verifying' });
  return { id, branch, directory, originalCommit: head(directory), assertions };
}

function behavior(directory, assertions) {
  execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';\n${assertions}`], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
}

function integrated(f, coordinator, child) {
  const commit = head(child.directory);
  git(coordinator, 'merge', '--ff-only', child.branch);
  assert.equal(head(coordinator), commit);
  git(coordinator, 'merge-base', '--is-ancestor', commit, 'HEAD');
  behavior(coordinator, child.assertions);
  f.store.updateTask(child.id, { status: 'completed', commit, checks: [{ command: 'node fixture behavior assertions', status: 'passed' }], summary: 'Fixture fix verified and fast-forwarded into the coordinator.' });
  removeChild(f, coordinator, child);
  return commit;
}

function removeChild(f, coordinator, child) {
  const tip = head(child.directory);
  git(coordinator, 'merge-base', '--is-ancestor', tip, 'HEAD');
  assert.equal(git(child.directory, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git(child.directory, 'ls-files', '--others', '--ignored', '--exclude-standard'), '');
  git(f.repo, 'worktree', 'remove', child.directory);
  git(coordinator, 'branch', '-d', child.branch);
  f.store.record('worktree', { taskId: child.id, branch: child.branch, path: child.directory, owned: true, status: 'removed' });
  assert.equal(fs.existsSync(child.directory), false);
  assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${child.branch}`), '');
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').includes(`branch refs/heads/${child.branch}`), false);
}

function auditChildren(f, children) {
  const worktrees = git(f.repo, 'worktree', 'list', '--porcelain');
  assert.equal(worktrees.split('\n').filter(line => line.startsWith('worktree ')).length, 2);
  for (const child of children) {
    assert.equal(fs.existsSync(child.directory), false);
    assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${child.branch}`), '');
    assert.equal(worktrees.includes(`branch refs/heads/${child.branch}`), false);
  }
}

test('independent fixture fixes rebase and fast-forward; later clarification starts at coordinator HEAD', t => {
  const f = fixture(t);
  const batch = findings(f.store, [['R001', 'discount.mjs', 'fix'], ['R002', 'tax.mjs', 'fix'], ['R003', 'shipping.mjs', 'clarify']]);
  assert.equal(batch.items.length, 3);
  f.store.record('coverage', { scope: 'checkout fixture', status: 'checked', summary: 'Reviewed discount, tax, shipping, and checkout composition.' });
  const coordinator = coordinatorForFixes(f);
  assert.ok(coordinator);
  const initialCoordinatorSha = head(coordinator);
  assert.equal(initialCoordinatorSha, f.reviewedSha);
  const discount = childFix(f, {
    id: 'discount-boundary', findingId: 'R001', startSha: initialCoordinatorSha, file: 'discount.mjs',
    content: 'export const discount = total => Math.max(0, total - 10);\n',
    assertions: "import {discount} from './discount.mjs'; assert.equal(discount(25), 15); assert.equal(discount(5), 0);",
  });
  const tax = childFix(f, {
    id: 'tax-rounding', findingId: 'R002', startSha: initialCoordinatorSha, file: 'tax.mjs',
    content: 'export const tax = total => Number((total * 1.1).toFixed(2));\n',
    assertions: "import {tax} from './tax.mjs'; assert.equal(tax(0.1), 0.11); assert.equal(tax(15), 16.5);",
  });
  assert.equal(git(discount.directory, 'rev-parse', 'HEAD^'), initialCoordinatorSha);
  assert.equal(git(tax.directory, 'rev-parse', 'HEAD^'), initialCoordinatorSha);
  const firstCommit = integrated(f, coordinator, discount);
  assert.equal(firstCommit, discount.originalCommit);
  assert.equal(git(coordinator, 'rev-list', '--left-right', '--count', `HEAD...${tax.branch}`), '1\t1');
  git(tax.directory, 'rebase', coordinatorBranch);
  assert.notEqual(head(tax.directory), tax.originalCommit);
  assert.equal(git(tax.directory, 'rev-parse', 'HEAD^'), firstCommit);
  integrated(f, coordinator, tax);
  behavior(coordinator, "import {checkout} from './checkout.mjs'; assert.equal(checkout(25), 21.5);");
  f.store.record('verification', { scope: 'combined', status: 'passed', headSha: head(coordinator), command: 'node checkout fixture assertions' });
  assert.equal(f.store.readiness().ready, false, 'Clarification remains unresolved.');

  const clarified = f.store.resolve('R003', { decision: 'fix', context: 'Free shipping applies after discount at 50 or above.', resolution: 'The fixture user clarified the shipping threshold in the same review.', requestId: 'shipping-clarification' });
  assert.equal(clarified.items[0].decision, 'fix');
  const laterBase = head(coordinator);
  assert.notEqual(laterBase, initialCoordinatorSha);
  const shipping = childFix(f, {
    id: 'shipping-threshold', findingId: 'R003', startSha: laterBase, file: 'shipping.mjs',
    content: 'export const shipping = total => total >= 50 ? 0 : 5;\n',
    assertions: "import {shipping} from './shipping.mjs'; assert.equal(shipping(50), 0); assert.equal(shipping(49), 5);",
  });
  assert.equal(git(shipping.directory, 'rev-parse', 'HEAD^'), laterBase);
  const lastCommit = integrated(f, coordinator, shipping);
  assert.ok(f.store.readiness().blockers.some(reason => /Combined verification/.test(reason)), 'Earlier verification cannot cover the later fix.');
  behavior(coordinator, "import {checkout} from './checkout.mjs'; assert.equal(checkout(25), 21.5); assert.equal(checkout(100), 99); assert.equal(checkout(5), 5);");
  f.store.record('verification', { scope: 'combined', status: 'passed', headSha: lastCommit, command: 'node final checkout fixture assertions' });
  f.store.record('pull_request', { status: 'fixture_only', externalCreated: false, baseBranch: f.store.manifest.branch, headBranch: coordinatorBranch });
  auditChildren(f, [discount, tax, shipping]);

  const state = f.store.state();
  assert.equal(state.pullRequest.baseBranch, reviewedBranch);
  assert.notEqual(state.pullRequest.baseBranch, 'develop');
  assert.equal(state.pullRequest.externalCreated, false);
  assert.equal(state.tasks.length, 3);
  for (const task of state.tasks) {
    assert.equal(task.model, route.model); assert.equal(task.effort, route.effort); assert.equal(task.status, 'completed');
    git(coordinator, 'merge-base', '--is-ancestor', task.commit, 'HEAD');
  }
  assert.equal(state.tasks.find(task => task.id === shipping.id).startSha, laterBase);
  assert.equal(state.routing.length, 3);
  assert.equal(state.worktrees.filter(item => item.status === 'removed').length, 3);
  assert.deepEqual(f.store.readiness(), { ready: true, needsPr: true, blockers: [] });
  assert.deepEqual(primarySnapshot(f.repo), f.untouched, 'Staged, unstaged, untracked work, primary branch, and HEAD all remain untouched.');
  assert.equal(git(coordinator, 'rev-list', '--count', `${f.reviewedSha}..HEAD`), '3');
  f.store.setClosed(true);
  assert.equal(f.store.state().review.closed, true);
});

test('all declined fixture findings close without a coordinator, child worktree, task, or PR', t => {
  const f = fixture(t);
  findings(f.store, [['R001', 'discount.mjs', 'dont_fix'], ['R002', 'tax.mjs', 'dont_fix']]);
  f.store.record('coverage', { scope: 'checkout fixture', status: 'checked' });
  assert.equal(coordinatorForFixes(f), null);
  const state = f.store.state();
  assert.equal(state.coordinator, null); assert.equal(state.pullRequest, null);
  assert.deepEqual(state.tasks, []); assert.deepEqual(state.worktrees, []);
  assert.deepEqual(f.store.readiness(), { ready: true, needsPr: false, blockers: [] });
  assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/review/', 'refs/heads/fix/'), '');
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  assert.deepEqual(primarySnapshot(f.repo), f.untouched);
  f.store.setClosed(true);
  assert.equal(f.store.state().review.closed, true);
});

for (const strategy of ['merge', 'squash', 'rebase']) {
  test(`post-merge Git protocol: ${strategy} preserves unrelated work and guards branch deletion`, t => {
    const f = fixture(t);
    findings(f.store, [['R001', 'discount.mjs', 'fix']]);
    const coordinator = coordinatorForFixes(f);
    fs.writeFileSync(path.join(coordinator, 'discount.mjs'), 'export const discount = total => Math.max(0, total - 10);\n');
    git(coordinator, 'add', 'discount.mjs'); git(coordinator, 'commit', '-m', 'approved fix');
    const publishedTip = head(coordinator);
    const target = path.join(f.root, 'forge-target-fixture');
    git(f.repo, 'worktree', 'add', '-b', 'forge-target-fixture', target, f.reviewedSha);
    if (strategy === 'merge') git(target, 'merge', '--ff-only', coordinatorBranch);
    else if (strategy === 'squash') {
      git(target, 'merge', '--squash', coordinatorBranch);
      git(target, 'commit', '-m', 'forge squash fixture');
    } else {
      fs.writeFileSync(path.join(target, 'discount.mjs'), fs.readFileSync(path.join(coordinator, 'discount.mjs')));
      git(target, 'add', 'discount.mjs'); git(target, 'commit', '-m', 'forge rewritten commit fixture');
    }
    behavior(target, "import {discount} from './discount.mjs'; assert.equal(discount(25), 15); assert.equal(discount(5), 0);");
    if (strategy !== 'merge') {
      assert.throws(() => git(target, 'merge-base', '--is-ancestor', publishedTip, 'HEAD'));
    }
    assert.equal(git(coordinator, 'status', '--porcelain', '--untracked-files=all'), '');
    git(f.repo, 'worktree', 'remove', coordinator);
    assert.equal(fs.existsSync(coordinator), false);
    assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').includes(`branch refs/heads/${coordinatorBranch}`), false);
    if (strategy === 'merge') git(target, 'branch', '-d', coordinatorBranch);
    else {
      assert.throws(() => git(target, 'branch', '-d', coordinatorBranch), 'Original commits are not ancestors after forge rewriting.');
      const ref = `refs/heads/${coordinatorBranch}`;
      // Simulate a newer local commit/ref after the cleanup preflight.
      git(target, 'update-ref', ref, head(target), publishedTip);
      assert.throws(() => git(target, 'update-ref', '-d', ref, publishedTip));
      assert.equal(git(target, 'rev-parse', ref), head(target), 'CAS must preserve newer work.');
      // Restore only this disposable fixture to exercise a proven unchanged merged ref.
      git(target, 'update-ref', ref, publishedTip, head(target));
      git(target, 'update-ref', '-d', ref, publishedTip);
      // Git itself rejects a repeated expected-old deletion: a wake must reconcile absence first.
      assert.throws(() => git(target, 'update-ref', '-d', ref, publishedTip));
      assert.equal(git(target, 'for-each-ref', '--format=%(refname)', ref), '');
    }
    assert.equal(git(target, 'for-each-ref', '--format=%(refname)', `refs/heads/${coordinatorBranch}`), '');
    assert.deepEqual(primarySnapshot(f.repo), f.untouched);
    assert.ok(fs.existsSync(f.review.reviewDir), 'Git cleanup preserves durable review records.');
  });
}
