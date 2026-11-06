import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const wrapper = fileURLToPath(new URL('../scripts/review.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function cli(args, options = {}) {
  const output = await exec(process.execPath, [options.wrapper ?? wrapper, ...args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(output.stdout);
}
async function fixture(t, input = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-test-'));
  let result;
  t.after(async () => {
    if (result) try { await cli(['stop', '--review', result.reviewDir]); } catch { /* A test may deliberately leave invalid metadata. */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  git(repo, 'init', '-b', 'develop'); git(repo, 'config', 'user.name', 'CLI Fixture'); git(repo, 'config', 'user.email', 'cli@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  result = await cli(['init', '--input', JSON.stringify({ repo, home, branch: 'develop', conversationId: 'conversation-one', ...input })]);
  return { root, repo, home, review: result.reviewDir, result };
}
const finding = { id: 'R001', label: 'issue', blocking: true, title: 'Retry duplicates work', evidence: 'The same operation can be called twice.', location: { path: 'file.txt', line: 1 } };

test('init accepts literal/file/stdin JSON; list and resume preserve repository and conversation identity', async t => {
  const f = await fixture(t);
  assert.ok(fs.existsSync(path.join(f.result.manifest.runtime.directory, 'cli.mjs')));
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  const inputPath = path.join(f.root, 'init.json');
  fs.writeFileSync(inputPath, JSON.stringify({ repo: f.repo, home: f.home, branch: 'develop', conversationId: 'conversation-two' }));
  await cli(['init', '--input', inputPath]);
  const child = execFile(process.execPath, [wrapper, 'init', '--input', '-']);
  child.stdin.end(JSON.stringify({ repo: f.repo, home: f.home, branch: 'develop', conversationId: 'conversation-three' }));
  const streamed = await new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  assert.ok(streamed.reviewDir);
  const listed = await cli(['list', '--home', f.home, '--conversation', 'conversation-one']);
  assert.equal(listed.reviews.length, 1); assert.equal(listed.reviews[0].id, f.result.manifest.id);
  const state = await cli(['state', '--review', f.review]);
  const resumed = await cli(['resume', '--review', f.review]);
  assert.equal(state.review.id, f.result.manifest.id); assert.equal(resumed.review.id, state.review.id);
  assert.equal(resumed.handoff.automatic, false); assert.equal(resumed.handoff.steps.length, 3);
});

test('owner commands delegate findings, records, resolutions, reservations, readiness, and closure', async t => {
  const f = await fixture(t);
  const run = (command, ...args) => cli([command, '--review', f.review, ...args]);
  assert.equal((await run('findings', '--input', JSON.stringify([finding]))).findings[0].id, 'R001');
  await run('record', '--kind', 'coverage', '--input', JSON.stringify({ status: 'checked', scope: 'file.txt' }));
  await run('resolve', '--id', 'R001', '--input', JSON.stringify({ decision: 'dont_fix', resolution: 'User accepts the behavior.', requestId: 'chat-one' }));
  const task = await run('task-reserve', '--input', JSON.stringify({ id: 'review-one', role: 'review', findingIds: [], model: 'gpt-6-astra', effort: 'xhigh', provider: 'host', startSha: f.result.manifest.reviewedSha }));
  assert.equal(task.task.status, 'dispatching');
  await run('task-update', '--id', 'review-one', '--input', JSON.stringify({ status: 'completed', summary: 'Read-only review completed.' }));
  assert.equal((await run('readiness')).ready, true);
  assert.equal((await run('close')).closed, true);
  assert.equal((await run('reopen')).closed, false);
});

test('wrapper uses an existing review pinned runtime after the installed template changes', async t => {
  const f = await fixture(t);
  const alternate = path.join(f.root, 'new-skill');
  fs.mkdirSync(path.join(alternate, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(alternate, 'assets', 'runtime'), { recursive: true });
  const copied = path.join(alternate, 'scripts', 'review.mjs');
  fs.copyFileSync(wrapper, copied);
  fs.writeFileSync(path.join(alternate, 'assets', 'runtime', 'cli.mjs'), 'export async function main(){ throw Error("Wrong template selected"); }');
  const state = await cli(['state', '--review', f.review], { wrapper: copied });
  assert.equal(state.review.id, f.result.manifest.id);
  fs.appendFileSync(path.join(f.result.manifest.runtime.directory, 'cli.mjs'), '\n// tampering\n');
  await assert.rejects(cli(['state', '--review', f.review]), /pinned runtime|digest|modified/i);
});

test('route records only sanitized result data and never input credentials', async t => {
  const f = await fixture(t);
  const secret = 'UNIQUE_CLI_SECRET_123456';
  const input = {
    callerRole: 'main', selectedModel: 'gpt-6-astra',
    catalog: [{ id: 'gpt-6-astra', family: 'gpt', efforts: ['xhigh'], effortOptionId: 'reasoning_effort' }],
    task: { title: 'Review authentication', security: true },
    env: { JEV_API_KEY: secret },
    judgment: { modelId: 'gpt-6-astra', effort: 'xhigh', reason: `Main selected the security model; ${secret}` },
  };
  const result = await cli(['route', '--review', f.review, '--input', JSON.stringify(input)]);
  assert.equal(result.status, 'routed');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  const state = await cli(['state', '--review', f.review]);
  assert.equal(state.routing.length, 1);
  assert.doesNotMatch(JSON.stringify(state.routing), new RegExp(`${secret}|JEV_API_KEY`));
});

test('exports stay inside artifacts, reject overwrite/traversal, and refuse symlink destinations', async t => {
  const f = await fixture(t);
  const exported = await cli(['export', '--review', f.review, '--output', 'snapshot.json']);
  assert.equal(exported.path, fs.realpathSync(path.join(f.review, 'artifacts', 'snapshot.json')));
  assert.equal(JSON.parse(fs.readFileSync(exported.path, 'utf8')).review.id, f.result.manifest.id);
  await assert.rejects(cli(['export', '--review', f.review, '--output', 'snapshot.json']), /exist|overwrite/i);
  await assert.rejects(cli(['export', '--review', f.review, '--output', '../escape.json']), /artifact|path/i);
  await assert.rejects(cli(['export', '--review', f.review, '--output', path.join(f.root, 'escape.json')]), /artifact|path/i);
  fs.symlinkSync(f.root, path.join(f.review, 'artifacts', 'outside'), 'dir');
  await assert.rejects(cli(['export', '--review', f.review, '--output', 'outside/escape.json']), /symlink|symbolic|artifact/i);
  assert.equal(fs.existsSync(path.join(f.root, 'escape.json')), false);
});

test('artifact import copies only the explicit file into artifacts and keeps source bytes unchanged', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'notes.txt');
  fs.writeFileSync(source, 'Evidence from a local check.\n');
  const imported = await cli(['import-artifact', '--review', f.review, '--source', source, '--output', 'evidence/notes.txt']);
  assert.equal(imported.status, 'imported');
  assert.equal(fs.readFileSync(imported.path, 'utf8'), 'Evidence from a local check.\n');
  assert.equal(fs.readFileSync(source, 'utf8'), 'Evidence from a local check.\n');
  await assert.rejects(cli(['import-artifact', '--review', f.review, '--source', source, '--output', '../escaped.txt']), /artifact|path/i);
  await assert.rejects(cli(['findings', '--review', f.review, '--input', '{PRIVATE_INVALID_JSON']), error => {
    assert.match(error.stderr, /not valid JSON/);
    assert.doesNotMatch(error.stderr, /PRIVATE_INVALID_JSON/);
    return true;
  });
});

test('foreground serve reports a page and graceful stop preserves its database', async t => {
  const f = await fixture(t);
  const child = execFile(process.execPath, [wrapper, 'serve', '--review', f.review]);
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const served = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Foreground service readiness timed out.')), 10000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const result = JSON.parse(output); clearTimeout(timer); resolve(result); } catch { /* Wait for the complete JSON report. */ }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(served.status, 'serving');
  assert.equal((await cli(['stop', '--review', f.review])).status, 'stopped');
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync(path.join(f.review, 'review.sqlite')), true);
});

test('detached service starts, reuses only verified identity, stops, and restarts with saved state', async t => {
  const f = await fixture(t);
  await cli(['findings', '--review', f.review, '--input', JSON.stringify([finding])]);
  const started = await cli(['start', '--review', f.review]);
  assert.equal(started.status, 'started'); assert.equal(started.handoff.steps.length, 3);
  assert.match(started.pageUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await (await fetch(`${started.pageUrl}/api/health`)).json();
  assert.equal(health.reviewId, f.result.manifest.id); assert.equal(health.pid, started.pid);
  assert.ok(fs.existsSync(path.join(f.review, 'artifacts', 'service.log')));
  const reused = await cli(['start', '--review', f.review]);
  assert.equal(reused.status, 'reused'); assert.equal(reused.pid, started.pid);
  assert.equal((await cli(['stop', '--review', f.review])).status, 'stopped');
  assert.equal(fs.existsSync(path.join(f.review, 'review.sqlite')), true);
  assert.equal((await cli(['state', '--review', f.review])).findings.length, 1);
  assert.equal((await cli(['start', '--review', f.review])).status, 'started');
  assert.equal((await cli(['stop', '--review', f.review])).status, 'stopped');
});

test('wrong health identity cannot be reused or signaled; T3 handoff states automatic notification', async t => {
  const one = await fixture(t);
  const two = await fixture(t, { deliveryMode: 't3', t3Command: ['unconfigured-fixture-command'] });
  const started = await cli(['start', '--review', one.review]);
  const forged = JSON.parse(fs.readFileSync(path.join(one.review, 'server.json'), 'utf8'));
  forged.reviewId = two.result.manifest.id;
  fs.writeFileSync(path.join(two.review, 'server.json'), JSON.stringify(forged));
  await assert.rejects(cli(['stop', '--review', two.review]), /identity|match/i);
  await assert.rejects(cli(['start', '--review', two.review]), /identity|match/i);
  assert.equal((await (await fetch(`${started.pageUrl}/api/health`)).json()).reviewId, one.result.manifest.id);
  fs.unlinkSync(path.join(two.review, 'server.json'));
  const t3 = await cli(['start', '--review', two.review]);
  assert.equal(t3.handoff.automatic, true); assert.equal(t3.handoff.conversationId, 'conversation-one');
  assert.match(t3.handoff.instructions, /automatic/i);
  await cli(['stop', '--review', one.review]); await cli(['stop', '--review', two.review]);
});
