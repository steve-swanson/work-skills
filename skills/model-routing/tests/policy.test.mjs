import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { routeTask, validateRoute } from '../lib/routing.mjs';
import { runCli } from '../scripts/route.mjs';

const models = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-terra',
  'claude-fable-5-1', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const catalog = models.map(id => ({ id, provider: id.startsWith('gpt') ? 'codex' : 'claudeAgent',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'], effortOptionId: id.startsWith('gpt') ? 'reasoningEffort' : 'effort' }));
const capabilities = [
  { provider: 'codex', family: 'gpt', enabled: true, canRunChildTask: true, canRunCrossProviderChildTask: true },
  { provider: 'claudeAgent', family: 'claude', enabled: true, canRunChildTask: true, canRunCrossProviderChildTask: true },
];
const plan = { summary: 'Update the editor layout.', paths: ['src/Editor.tsx'], acceptanceCriteria: ['Editor remains keyboard accessible.'] };
const base = { callerRole: 'main', selectedModel: 'gpt-6.2-sol', catalog, dispatchCapabilities: capabilities,
  credentialOptions: { env: {}, homeConfig: false }, task: { kind: 'review', description: 'Review bounded behavior', risk: 'ordinary' } };
const judge = ({ stage, candidates }) => ({ choice: stage === 'model' ? candidates[0].id : (candidates.find(e => e.level === 'high') ?? candidates[0]).value });
const frontend = (family, preference, task = {}) => ({ ...base, selectedModel: family === 'gpt' ? 'gpt-6.2-sol' : 'claude-opus-5-5',
  frontendPreference: preference, task: { kind: 'implementation', frontend: true, plan, ...task } });

test('frontend asks for a choice before Jev and requires a concrete implementation plan', async () => {
  let called = false;
  const input = { ...frontend('gpt', undefined), judge: async () => { called = true; } };
  assert.equal((await routeTask(input)).status, 'frontend_choice_required');
  assert.equal(called, false);
  assert.equal((await routeTask({ ...input, task: { kind: 'implementation', frontend: true } })).status, 'implementation_plan_required');
});

test('frontend preference pins newest tier and asks Jev only for effort in both families', async () => {
  for (const [family, preference, expected] of [
    ['gpt', 'primary', 'gpt-6-astra'], ['gpt', 'fallback', 'gpt-6.2-sol'],
    ['claude', 'primary', 'claude-fable-5-2'], ['claude', 'fallback', 'claude-opus-5-5'],
  ]) {
    const calls = [];
    const result = await routeTask({ ...frontend(family, preference), judge: async request => {
      calls.push(request); return { choice: 'xhigh' };
    } });
    assert.equal(result.status, 'routed');
    assert.equal(result.route.modelId, expected);
    assert.equal(result.route.effort, 'xhigh');
    assert.deepEqual(calls.map(c => c.stage), ['effort']);
    assert.equal(result.audit.selection.frontendPreference, preference);
    assert.ok(calls[0].candidates.every(e => ['low', 'medium', 'high', 'xhigh'].includes(e.level)));
  }
});

test('missing credentials or failed frontend Jev returns fixed-model effort fallback', async () => {
  for (const extra of [{}, { judge: async () => { throw Error('unavailable'); } }]) {
    const input = frontend('claude', 'primary');
    const r = await routeTask({ ...input, ...extra });
    assert.equal(r.status, 'main_judgment_required');
    assert.equal(r.stage, 'effort');
    assert.deepEqual(r.partial, { modelId: 'claude-fable-5-2' });
    assert.equal((await routeTask({ ...input, judgment: { modelId: 'claude-fable-5-2', effort: 'medium', reason: 'Bounded layout work.' } })).status, 'routed');
    assert.notEqual((await routeTask({ ...input, judgment: { modelId: 'claude-opus-5-5', effort: 'high', reason: 'Try changing the user choice.' } })).status, 'routed');
  }
});

test('frontend risk floors and caps apply to Jev and main judgment; generic fixes retain High cap', async () => {
  for (const task of [{ security: true }, { algorithm: true }, { uncertain: true }]) {
    const input = frontend('gpt', 'primary', task);
    for (const effort of ['low', 'medium', 'max', 'ultra', 'ultracode']) assert.equal(validateRoute({ ...input, route: { modelId: 'gpt-6-astra', effort } }).valid, false);
    for (const effort of ['high', 'xhigh']) assert.equal(validateRoute({ ...input, route: { modelId: 'gpt-6-astra', effort } }).valid, true);
  }
  const ordinary = { ...base, task: { kind: 'fix', plan } };
  assert.equal(validateRoute({ ...ordinary, route: { modelId: 'gpt-6.2-sol', effort: 'xhigh' } }).valid, false);
  assert.equal(validateRoute({ ...ordinary, route: { modelId: 'gpt-6-astra', effort: 'high' } }).valid, false);
});

test('unavailable preferred frontend tier cannot silently fall back to another tier', async () => {
  const input = { ...frontend('claude', 'primary'), catalog: catalog.filter(m => !m.id.includes('fable')) };
  assert.equal((await routeTask(input)).status, 'required_model_blocked');
  assert.equal((await routeTask({ ...frontend('gpt', 'primary'), catalog: catalog.map(m => m.id.includes('astra') ? { ...m, efforts: ['max'] } : m) })).status, 'required_model_blocked');
});

test('retained frontend preference routes retries and watch-pr fixes consistently', async () => {
  const saved = { family: 'claude', choice: 'fallback' };
  for (const kind of ['implementation', 'fix', 'fix']) {
    const r = await routeTask({ ...frontend(saved.family, saved.choice, { kind }), judge });
    assert.equal(r.route.modelId, 'claude-opus-5-5');
  }
});

test('reviews prefer opposite implementation family, regardless of caller family or frontend preference', async () => {
  for (const [authorFamily, expected] of [['gpt', 'claude'], ['claude', 'gpt']]) {
    for (const selectedModel of ['gpt-6.2-sol', 'claude-fable-5-2']) {
      const r = await routeTask({ ...base, selectedModel, authorFamily, frontendPreference: 'primary', judge });
      assert.equal(r.route.family, expected);
      assert.equal(r.audit.selection.implementationFamily, authorFamily);
      assert.equal(r.audit.selection.familyFallbackReason, null);
      assert.equal(r.audit.selection.authorFamilyAssumed, false);
    }
  }
  const r = await routeTask({ ...base, judge });
  assert.equal(r.audit.selection.authorFamilyAssumed, true);
});

test('catalog-only or disabled/unsupported opposite providers trigger same-family routing', async () => {
  for (const dispatchCapabilities of [undefined, capabilities.map(c => c.family === 'claude' ? { ...c, enabled: false } : c),
    capabilities.map(c => c.family === 'claude' ? { ...c, canRunChildTask: false } : c),
    capabilities.map(c => c.family === 'claude' ? { ...c, canRunCrossProviderChildTask: false } : c)]) {
    const r = await routeTask({ ...base, dispatchCapabilities, judge });
    assert.equal(r.route.family, 'gpt');
    assert.equal(r.audit.selection.familyFallbackReason, 'opposite_dispatch_unavailable_or_unconfirmed');
  }
  const r = await routeTask({ ...base, selectedModel: 'claude-opus-5-5', dispatchCapabilities: undefined, judge });
  assert.equal(r.route.family, 'claude');
});

test('cross-provider support is required even for another provider in the same family', async () => {
  const input = { ...base, catalog: [...catalog, { ...catalog[0], id: 'host-other-astra', name: 'GPT 7 Astra', provider: 'other' }],
    dispatchCapabilities: [...capabilities, { provider: 'other', family: 'gpt', enabled: true, canRunChildTask: true, canRunCrossProviderChildTask: false }],
    authorFamily: 'claude', task: { kind: 'review', security: true } };
  const r = await routeTask({ ...input, judge });
  assert.equal(r.route.provider, 'codex');
});

test('missing opposite security tier/effort falls back without lowering the security floor', async () => {
  for (const changedCatalog of [catalog.filter(m => !m.id.includes('opus')),
    catalog.map(m => m.id.includes('opus') ? { ...m, efforts: ['low', 'max'] } : m)]) {
    const r = await routeTask({ ...base, catalog: changedCatalog, task: { kind: 'review', security: true }, judge });
    assert.equal(r.route.modelId, 'gpt-6-astra');
    assert.equal(r.route.effort, 'xhigh');
    assert.equal(r.audit.selection.familyFallbackReason, 'opposite_model_or_effort_unavailable');
  }
  assert.equal((await routeTask({ ...base, catalog: catalog.filter(m => !/opus|astra/.test(m.id)), task: { kind: 'review', security: true } })).status, 'required_model_blocked');
});

test('neither family dispatchable blocks routing and unsupported routes fail revalidation', async () => {
  assert.equal((await routeTask({ ...base, dispatchCapabilities: [] })).status, 'required_model_blocked');
  const r = await routeTask({ ...base, judge });
  const updated = capabilities.map(c => c.family === 'claude' ? { ...c, enabled: false } : c);
  assert.equal(validateRoute({ ...base, dispatchCapabilities: updated, route: r.route }).valid, false);
  const fallback = await routeTask({ ...base, dispatchCapabilities: updated, judge });
  assert.equal(fallback.route.family, 'gpt');
  assert.equal(validateRoute({ ...base, route: { ...r.route, provider: 'wrong' } }).reason, 'provider_mismatch');
});

test('malformed capability evidence, author provenance, and frontend preference cannot route', async () => {
  for (const extra of [{ dispatchCapabilities: {} }, { dispatchCapabilities: [{ provider: 'codex', family: 'gpt' }] },
    { dispatchCapabilities: [...capabilities, capabilities[0]] }, { authorFamily: 'unknown' }, { task: { ...base.task, frontend: 'yes' } }]) {
    assert.equal((await routeTask({ ...base, ...extra })).status, 'invalid_configuration');
  }
  assert.equal((await routeTask({ ...frontend('gpt', 'unrecorded') })).reason, 'invalid_frontend_preference');
});

test('standalone JSON CLI accepts stdin/file/inline, validates, redacts, and never needs SQLite', async t => {
  const input = { ...frontend('gpt', 'fallback'), judgment: { modelId: 'gpt-6.2-sol', effort: 'high', reason: 'Fixture bounded task.' } };
  const json = JSON.stringify(input);
  const cli = fileURLToPath(new URL('../scripts/route.mjs', import.meta.url));
  const withoutSqlite = JSON.parse(execFileSync(process.execPath, ['--no-experimental-sqlite', cli, '--input', json], { encoding: 'utf8' }));
  assert.equal(withoutSqlite.route.modelId, 'gpt-6.2-sol');
  const root = await mkdtemp(join(tmpdir(), 'model-routing-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'input.json'); await writeFile(file, json);
  for (const [value, stream] of [[json], [file], ['-', Readable.from([json])]]) {
    const r = await runCli(['--input', value], stream ? { stdin: stream } : undefined);
    assert.equal(r.route.modelId, 'gpt-6.2-sol');
  }
  const result = await runCli(['--validate', '--input', JSON.stringify({ ...input, route: { modelId: 'gpt-6.2-sol', effort: 'high' } })]);
  assert.equal(result.valid, true);
  const secret = 'ONLY_A_FIXTURE_SECRET_1234';
  const redacted = await runCli(['--input', JSON.stringify({ ...input, env: { JEV_API_KEY: secret }, judgment: { ...input.judgment, reason: secret } })]);
  assert.doesNotMatch(JSON.stringify(redacted), /ONLY_A_FIXTURE_SECRET_1234/);
  await assert.rejects(runCli(['--input', 'PRIVATE_INVALID_JSON']), /not echoed/);
});
