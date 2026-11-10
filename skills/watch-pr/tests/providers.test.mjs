import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRepository, requestKey, monitoringMode, discoverRepository } from '../lib/identity.mjs';
import { runRequest } from '../lib/requests.mjs';
import { createClient, commandSpec } from '../lib/transport.mjs';
import { run, parseArgs, assess, transition, acquireLock } from '../scripts/watch.mjs';
import { hash } from '../lib/state.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40);
async function directory(t) { const d = await mkdtemp(path.join(tmpdir(), 'cloud-provider-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
test('cloud remote and request URLs canonicalize without credentials, including subgroups and Azure aliases', () => {
  for (const [input, provider, repo, id] of [
    ['git@github.com:owner/repo.git', 'github', 'owner/repo'], ['https://user:SECRET@github.com/owner/repo/pull/42?token=SECRET', 'github', 'owner/repo', 42],
    ['ssh://git@gitlab.com/group/sub/project.git', 'gitlab', 'group/sub/project'], ['https://gitlab.com/group/sub/project/-/merge_requests/4', 'gitlab', 'group/sub/project', 4],
    ['git@bitbucket.org:team/repo.git', 'bitbucket', 'team/repo'], ['https://bitbucket.org/team/repo/pull-requests/8', 'bitbucket', 'team/repo', 8],
    ['git@ssh.dev.azure.com:v3/org/project/repo', 'azure', 'org/project/repo'], ['https://org.visualstudio.com/DefaultCollection/project/_git/repo/pullrequest/9', 'azure', 'org/project/repo', 9],
    ['https://org@dev.azure.com/org/a%20project/_git/repo', 'azure', 'org/a project/repo'],
  ]) {
    const r = parseRepository(input); assert.equal(r.provider, provider); assert.equal(r.repo, repo); assert.equal(r.requestId, id);
    assert.doesNotMatch(JSON.stringify(r), /SECRET|user:|token=/);
  }
  for (const invalid of ['https://gitlab.internal/group/repo', 'git@work-alias:owner/repo', 'https://github.com/o/r/pull/0',
    'https://github.com/o/%2E%2E', 'https://evil.test/owner/repo', 'https://github.com:444/o/r']) assert.throws(() => parseRepository(invalid));
});

test('discovery respects push remote and target base remote without printing credential-bearing git output', async () => {
  const calls = [];
  const execute = async (exe, args) => { calls.push(args); return { stdout: args[0] === 'config' ? (args[2] === 'branch.main.remote' ? 'upstream' : 'origin') : 'https://SECRET@github.com/o/r.git' }; };
  assert.equal((await discoverRepository({ cwd: '/fixture', baseBranch: 'main', target: true }, execute)).repo, 'o/r');
  assert.ok(calls.some(c => c.join(' ') === 'remote get-url upstream'));
});

test('URL selector preserves legacy flags, rejects ambiguous selectors, and monitoring falls back truthfully', () => {
  const o = parseArgs(['--url', 'https://gitlab.com/g/sub/p/-/merge_requests/4', '--once']);
  assert.equal(o.repository.provider, 'gitlab'); assert.equal(o.pr, 4);
  assert.throws(() => parseArgs(['--url', o.url, '--repo', 'o/r', '--pr', '4']));
  assert.equal(monitoringMode({ nativeSupported: true }), 'native');
  assert.equal(monitoringMode({ portableAllowed: true, canResumeAgent: true }), 'portable');
  assert.equal(monitoringMode({ portableAllowed: true }), 'manual_resume');
});

test('transport scopes API hosts, preserves multiline JSON through stdin, paginates, and forbids watcher writes', async () => {
  const calls = [];
  const client = createClient('gitlab', { execute: async (exe, args, options) => {
    calls.push({ exe, args, input: options.input });
    return { stdout: calls.length === 1 ? 'HTTP/2.0 200 OK\nLink: <https://gitlab.com/api/v4/projects?page=2>; rel="next"\n\n[{"id":1}]' : 'HTTP/2.0 200 OK\n\n[{"id":2}]' };
  } });
  assert.deepEqual(await client.pages('/projects'), [{ id: 1 }, { id: 2 }]);
  await client.request('POST', '/projects/1/merge_requests', { description: 'line one\nline two' });
  assert.equal(JSON.parse(calls[2].input).description, 'line one\nline two');
  assert.ok(!calls[2].args.join(' ').includes('line one'));
  await assert.rejects(client.request('GET', 'https://evil.test/api'), /Cross-host/);
  await assert.rejects(createClient('github', { readOnly: true }).request('POST', '/repos/o/r/pulls', {}), /refuses/);
});

test('Bitbucket and Azure use scoped in-process auth and classify rate limits without exposing headers', async () => {
  let authorization;
  const fetchImpl = async (url, options) => { authorization = options.headers.Authorization; return new Response('{"values":[]}', { status: 200 }); };
  await createClient('bitbucket', { env: { BITBUCKET_API_TOKEN: 'FIXTURE', BITBUCKET_EMAIL: 'fixture@example.invalid' }, fetchImpl }).request('GET', '/repositories/o/r');
  assert.equal(authorization, `Basic ${Buffer.from('fixture@example.invalid:FIXTURE').toString('base64')}`);
  await createClient('azure', { env: {}, execute: async () => ({ stdout: '{"accessToken":"FIXTURE_AZURE"}' }), fetchImpl }).request('GET', '/o/p/_apis/git/repositories');
  assert.equal(authorization, 'Bearer FIXTURE_AZURE');
  await assert.rejects(createClient('bitbucket', { env: { BITBUCKET_ACCESS_TOKEN: 'FIXTURE' }, fetchImpl: async () => new Response('PRIVATE', { status: 429 }) }).request('GET', '/repositories/o/r'), e => e.transient && !e.message.includes('PRIVATE'));
  await assert.rejects(createClient('bitbucket', { env: { BITBUCKET_ACCESS_TOKEN: 'FIXTURE' }, fetchImpl: async () => new Response('PRIVATE_INVALID_JSON') }).request('GET', '/repositories/o/r'), e => !e.message.includes('PRIVATE'));
  assert.match(commandSpec('az', ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '-o', 'json'], 'win32').args.at(-1), /^az account/);
  assert.throws(() => commandSpec('az', ['account', 'unsafe & echo secret'], 'win32'), /Unsafe/);
});

function requestFixture() {
  const requests = []; let creates = 0, fail = false;
  const input = { sourceUrl: 'https://github.com/fork/repo', targetUrl: 'https://github.com/upstream/repo', sourceRef: 'feature', targetRef: 'develop', headSha: head, title: 'Feature', description: 'First line\nSecond line' };
  const adapter = {
    async resolveRepository(r) { return { ...r, repositoryId: r.repo.startsWith('fork/') ? '1' : '2' }; },
    async listOpen() { return requests; }, async getRequest() { return requests[0]; },
    async create(data) { creates++; if (fail) throw Error('unknown result'); const r = { provider: 'github', host: 'github.com', repositoryId: '2', requestId: 42, url: 'https://github.com/upstream/repo/pull/42', state: 'OPEN',
      sourceRepositoryId: '1', targetRepositoryId: '2', sourceRef: data.sourceRef, targetRef: data.targetRef, sourceSha: data.headSha, targetSha: target }; requests.push(r); return r; },
    async update(id, data) { return { ...requests[0], ...data }; }, async reply() { return { id: 5 }; }, async resolveThread() {},
  };
  return { input, adapter, requests, creates: () => creates, setFail: value => { fail = value; } };
}
test('creation reuses exact fork-aware requests and verifies expected revisions without duplicate writes', async t => {
  const f = requestFixture(), stateDir = await directory(t), options = { stateDir, adapterFactory: () => f.adapter };
  const created = await runRequest('create', f.input, options); assert.equal(created.status, 'created');
  assert.equal((await runRequest('create', f.input, options)).status, 'reused'); assert.equal(f.creates(), 1);
  assert.equal((await runRequest('create', { ...f.input, sourceRef: 'refs/heads/feature', targetRef: 'refs/heads/develop' }, options)).status, 'reused');
  await assert.rejects(runRequest('create', { ...f.input, headSha: target }, options), /does not match/);
  assert.equal((await runRequest('reply', { url: created.request.url, headSha: head, body: 'Evidence-backed reply' }, options)).status, 'replied');
  await assert.rejects(runRequest('update', { url: created.request.url, headSha: target, title: 'Stale' }, options), /current/);
});
test('uncertain creation is retained and never blindly retried; multiple matches are refused', async t => {
  const f = requestFixture(), options = { stateDir: await directory(t), adapterFactory: () => f.adapter };
  f.setFail(true);
  await assert.rejects(runRequest('create', f.input, options), /reconcile/);
  await assert.rejects(runRequest('create', f.input, options), /uncertain/); assert.equal(f.creates(), 1);
  f.requests.push({}, {});
  await assert.rejects(runRequest('create', f.input, options), /Multiple/);
});
test('ambiguous create reconciles a request actually created before the connection failed', async t => {
  const f = requestFixture(), original = f.adapter.create;
  f.adapter.create = async data => { await original(data); throw Error('lost response'); };
  assert.equal((await runRequest('create', f.input, { stateDir: await directory(t), adapterFactory: () => f.adapter })).status, 'created');
  assert.equal(f.creates(), 1);
});

test('provider gates preserve unknown/manual/optional semantics', () => {
  const s = { state: 'OPEN', phase: 'open', sha: head, checks: [{ name: 'optional', state: 'failure', required: false }, { name: 'required', state: 'success' }],
    expected: ['required'], policyKnown: true, threads: [], feedback: [], mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', gates: [] };
  assert.equal(assess(s).status, 'ready');
  assert.equal(assess({ ...s, gates: [{ id: 'manual-job', state: 'pending' }] }).status, 'waiting');
  assert.equal(assess({ ...s, gates: [{ id: 'approvals', state: 'unknown' }] }).status, 'action');
});

test('version 2 state imports legacy GitHub records while honoring old locks and preserving old files', async t => {
  const stateDir = await directory(t), options = { ...parseArgs(['--repo', 'o/r', '--pr', '42', '--once']), stateDir };
  const s = { state: 'OPEN', phase: 'open', sha: head, checks: [{ name: 'CI', state: 'success' }], expected: ['CI'], policyKnown: true,
    threads: [], feedback: [], reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' };
  const legacyKey = hash({ repo: 'o/r', pr: 42 }), legacyFile = path.join(stateDir, `${legacyKey}-open.json`);
  const old = { ...transition({}, s).state, version: 1 }; await writeFile(legacyFile, JSON.stringify(old));
  const adapterFactory = () => ({ async resolveRepository(r) { return { ...r, repositoryId: '123' }; }, async collectSnapshot() { return s; } });
  const release = await acquireLock(stateDir, legacyKey);
  await assert.rejects(run(options, { adapterFactory, emit: () => {} }), /lock exists/); await release();
  const events = []; assert.equal(await run(options, { adapterFactory, emit: e => events.push(e) }), 0); assert.deepEqual(events, []);
  assert.deepEqual(JSON.parse(await readFile(legacyFile, 'utf8')), old);
  const canonical = hash(requestKey({ provider: 'github', host: 'github.com', repositoryId: '123', requestId: 42 }));
  assert.equal(JSON.parse(await readFile(path.join(stateDir, `${canonical}-open.json`), 'utf8')).version, 2);
  assert.equal((await readdir(stateDir)).some(f => f.endsWith('.lock')), false);
  assert.notEqual(canonical, hash(requestKey({ provider: 'gitlab', host: 'gitlab.com', repositoryId: '123', requestId: 42 })));
});
