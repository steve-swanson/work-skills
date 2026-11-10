import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEY_ALIASES, resolveCredentials, discoverCredentials, modelFamily,
  assessRisk, chooseConcurrency, validateRoute, routeTask,
} from '../lib/routing.mjs';

const catalog = [
  { id: 'gpt-6.1-sol', family: 'gpt', provider: 'openai', efforts: ['low', 'medium', 'high'], effortOptionId: 'reasoning_effort' },
  { id: 'gpt-6-astra', family: 'gpt', provider: 'openai', efforts: ['high', 'xhigh'], effortOptionId: 'reasoning_effort' },
  { id: 'claude-haiku-5-5', family: 'claude', provider: 'anthropic', efforts: ['low', 'high'], effortOptionId: 'effort' },
  { id: 'claude-sonnet-5-5', family: 'claude', provider: 'anthropic', efforts: ['low', 'high'], effortOptionId: 'effort' },
  { id: 'claude-opus-5-5', family: 'claude', provider: 'anthropic', efforts: ['high', 'xhigh', 'max'], effortOptionId: 'effort' },
];
const task = { id: 'R001', kind: 'review', description: 'Review a layout change', risk: 'ordinary' };
const base = { callerRole: 'main', selectedModel: 'gpt-6-astra', catalog, task, credentialOptions: { env: {}, homeConfig: false } };
const answer = (request, choice) => ({
  answers: { [request.stage]: { type: 'choice', choice,
    probabilities: Object.fromEntries(request.candidates.map(item => [item.value ?? item.id, (item.value ?? item.id) === choice ? 1 : 0])), confidence: 0.99 } },
  model: 'jev-latest', usage: { input_tokens: 5, output_tokens: 2 },
});

test('all six aliases resolve to opaque handles without serialized key values', () => {
  assert.deepEqual(KEY_ALIASES, ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_KEY', 'JEV_KEY', 'TYPESAFE_API', 'JEV_API']);
  for (const alias of KEY_ALIASES) {
    const secret = `fixture-secret-${alias}`;
    const credential = resolveCredentials({ env: { [alias]: secret } });
    assert.equal(credential.status, 'available');
    assert.equal(credential.variable, alias);
    assert.ok(!JSON.stringify(credential).includes(secret));
    assert.ok(!Object.values(credential).includes(secret));
  }
});

test('empty and URL-like alias values cannot become credentials', () => {
  for (const value of ['', '  ', 'https://api.typesafe.ai', 'http://example.test/key', '//example.test', 'api.typesafe.ai', 'www.example.test/key', 'localhost:8080', 'https:api.typesafe.ai']) {
    assert.equal(resolveCredentials({ env: { JEV_API: value } }).status, 'unavailable', value);
  }
});

test('standard names precede aliases and explicit source order and bindings are authoritative', () => {
  assert.equal(resolveCredentials({ env: { JEV_KEY: 'alias-key', TYPESAFE_API_KEY: 'standard-key' } }).variable, 'TYPESAFE_API_KEY');
  const options = { env: { TYPESAFE_API_KEY: 'environment-key' }, sources: [{ name: '/project/.env', values: { JEV_KEY: 'file-key', CUSTOM_JEV: 'custom-key' } }] };
  assert.equal(resolveCredentials(options).source, 'environment');
  assert.equal(resolveCredentials({ ...options, sourceOrder: ['/project/.env', 'environment'] }).source, '/project/.env');
  const bound = resolveCredentials({ ...options, binding: { source: '/project/.env', variable: 'CUSTOM_JEV' } });
  assert.equal(bound.variable, 'CUSTOM_JEV');
  assert.equal(bound.source, '/project/.env');
  assert.equal(resolveCredentials({ ...options, binding: { variable: 'MISSING' } }).reason, 'bound_credential_missing');
});

test('dotenv discovery with home lookup disabled reads only specified paths and never evaluates shell syntax', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-work-routing-'));
  try {
    const marker = join(dir, 'must-not-exist');
    const envFile = join(dir, 'explicit.env');
    await writeFile(envFile, `export TYPESAFE_API_KEY="fixture-file-secret" # allowed\nJEV_KEY=$(touch ${marker})\nEVIL=\`touch ${marker}\`\nsource /tmp/never\n`);
    await writeFile(join(dir, '.env'), 'TYPESAFE_API_KEY=unrequested-secret\n');
    const credential = await discoverCredentials({ env: {}, envFiles: [envFile], homeConfig: false });
    assert.equal(credential.status, 'available');
    assert.equal(credential.source, envFile);
    assert.deepEqual(credential.inspectedSources, ['environment', envFile]);
    assert.ok(!JSON.stringify(credential).includes('fixture-file-secret'));
    await assert.rejects(access(marker));
    assert.equal((await discoverCredentials({ env: {}, envFiles: [], homeConfig: false })).status, 'unavailable');
    await writeFile(envFile, `JEV_KEY=$(touch ${marker})\n`);
    assert.equal((await discoverCredentials({ env: {}, envFiles: [envFile], homeConfig: false })).status, 'unavailable');
    await assert.rejects(access(marker));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function homeFixture(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'review-work-jev-home-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const folder = join(homeDir, '.config', 'jev');
  await mkdir(folder, { recursive: true });
  return { homeDir, credentialsFile: join(folder, 'credentials.env'), projectFile: join(homeDir, 'project.env') };
}

test('home credentials take precedence over environment and project files for all six aliases', async t => {
  const { homeDir, credentialsFile, projectFile } = await homeFixture(t);
  await writeFile(projectFile, 'JEV_API_KEY=project-fixture-key\n');
  for (const alias of KEY_ALIASES) {
    const secret = `home-fixture-key-${alias}`;
    await writeFile(credentialsFile, `${alias}=${secret}\n`);
    const credential = await discoverCredentials({ homeDir, env: { JEV_API_KEY: 'environment-fixture-key' }, envFiles: [projectFile] });
    assert.equal(credential.source, credentialsFile);
    assert.equal(credential.variable, alias);
    assert.deepEqual(credential.inspectedSources, [credentialsFile, 'environment', projectFile]);
    assert.ok(!JSON.stringify(credential).includes(secret));
  }
});

test('missing, invalid, or unreadable home credentials fall back without searching other home files', async t => {
  const { homeDir, credentialsFile, projectFile } = await homeFixture(t);
  const marker = join(homeDir, 'must-not-exist');
  await writeFile(join(homeDir, '.env'), 'JEV_API_KEY=unrequested-home-key\n');
  await writeFile(projectFile, 'JEV_KEY=project-fixture-key\n');
  const options = { homeDir, env: {}, envFiles: [projectFile] };
  assert.equal((await discoverCredentials(options)).source, projectFile);
  await writeFile(credentialsFile, `JEV_API_KEY=https://example.invalid\nJEV_KEY=$(touch ${marker})\n`);
  assert.equal((await discoverCredentials(options)).source, projectFile);
  assert.equal((await discoverCredentials({ ...options, env: { JEV_API_KEY: 'environment-fixture-key' } })).source, 'environment');
  assert.equal((await discoverCredentials({ homeDir, env: {} })).status, 'unavailable');
  await assert.rejects(access(marker));
  await rm(credentialsFile);
  await mkdir(credentialsFile);
  const unreadable = await discoverCredentials(options);
  assert.equal(unreadable.source, projectFile);
  assert.deepEqual(unreadable.unreadableSources, [credentialsFile]);
});

test('explicit bindings, source order, and disabling home lookup remain authoritative', async t => {
  const { homeDir, credentialsFile, projectFile } = await homeFixture(t);
  await writeFile(credentialsFile, 'JEV_API_KEY=home-fixture-key\n');
  await writeFile(projectFile, 'CUSTOM_JEV=project-bound-fixture-key\n');
  const options = { homeDir, env: { JEV_API_KEY: 'environment-fixture-key' }, envFiles: [projectFile] };
  assert.equal((await discoverCredentials({ ...options, binding: { source: projectFile, variable: 'CUSTOM_JEV' } })).source, projectFile);
  assert.equal((await discoverCredentials({ ...options, binding: { source: projectFile, variable: 'MISSING' } })).reason, 'bound_credential_missing');
  assert.equal((await discoverCredentials({ ...options, sourceOrder: ['environment', credentialsFile] })).source, 'environment');
  const disabled = await discoverCredentials({ ...options, homeConfig: false });
  assert.equal(disabled.source, 'environment');
  assert.ok(!disabled.inspectedSources.includes(credentialsFile));
});

test('routeTask uses the home key for both direct calls without exposing it in its result', async t => {
  const { homeDir, credentialsFile } = await homeFixture(t);
  const secret = 'home-direct-fixture-secret';
  await writeFile(credentialsFile, `JEV_API_KEY=${secret}\n`);
  let calls = 0;
  const result = await routeTask({ ...base, credentialOptions: undefined, homeDir, env: { JEV_API_KEY: 'environment-fixture-key' },
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      const body = JSON.parse(init.body);
      const stage = Object.keys(body.questions)[0];
      const candidates = Object.keys(body.questions[stage].criteria).map(value => ({ value }));
      return { ok: true, json: async () => answer({ stage, candidates }, stage === 'model' ? 'gpt-6.1-sol' : 'high') };
    } });
  assert.equal(result.status, 'routed');
  assert.equal(calls, 2);
  assert.equal(result.audit.credentials.source, credentialsFile);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('selected model family is explicit and unknown families fail closed', async () => {
  assert.equal(modelFamily('gpt-6-astra'), 'gpt');
  assert.equal(modelFamily('claude-opus-5-5'), 'claude');
  assert.equal(modelFamily({ id: 'host-choice-12', family: 'gpt' }), 'gpt');
  assert.equal(modelFamily('unknown'), null);
  assert.equal(modelFamily({ id: 'gpt-6-astra', family: 'claude' }), null);
  assert.equal((await routeTask({ ...base, selectedModel: 'unknown' })).reason, 'unknown_selected_family');
});

test('risk evidence detects security domains and cannot be negated by ordinary labels', () => {
  for (const description of ['authentication callback', 'authorization rules', 'secret token rotation', 'crypto library', 'tenant isolation', 'trust boundaries', 'security review', 'OAuth callback', 'authz policy', 'API key management', 'password storage']) {
    assert.equal(assessRisk({ description, risk: 'ordinary' }).category, 'security', description);
  }
  assert.equal(assessRisk({ description: 'No security concern asserted', risk: 'ordinary' }).security, true);
  assert.equal(assessRisk({ risk: { security: true } }).category, 'security');
  assert.equal(assessRisk({ scope: ['src/auth/session.ts'] }).category, 'security');
  assert.equal(assessRisk({ description: 'Compare sorting algorithms' }).category, 'algorithm');
  assert.equal(assessRisk({ readOnly: true, kind: 'inventory' }).minimumEffort, 'low');
  assert.equal(assessRisk({ description: 'Unsure what changes are needed' }).minimumEffort, 'high');
});

test('Auto concurrency uses partitions, real capacity, and hard maximum; batch width is irrelevant', () => {
  const auto = chooseConcurrency({ mode: 'auto', independentPartitions: 9, maxReviewers: 7, maxBatchThreads: 1 });
  assert.equal(auto.count, 4);
  assert.equal(auto.capacitySource, 'default');
  assert.match(auto.disclosure, /4/);
  assert.equal(chooseConcurrency({ mode: 'auto', independentPartitions: 8, availableCapacity: 6, maxReviewers: 2 }).count, 2);
  assert.equal(chooseConcurrency({ mode: 7, independentPartitions: 2, availableCapacity: 5 }).count, 2);
  assert.equal(chooseConcurrency({ mode: 'auto', independentPartitions: 5, availableCapacity: 0 }).count, 0);
  assert.equal(chooseConcurrency({ mode: 'auto', independentPartitions: 0 }).count, 0);
  assert.equal(chooseConcurrency({ mode: 'auto', independentPartitions: 10, maxReviewers: 0 }).count, 0);
  assert.equal(chooseConcurrency({ availableCapacity: -1 }).status, 'invalid_configuration');
});

test('ordinary Jev routing chooses model before that model supported effort', async () => {
  const requests = [];
  const result = await routeTask({ ...base, judge: async request => {
    requests.push(request);
    return { choice: request.stage === 'model' ? 'gpt-6.1-sol' : 'medium', confidence: 0.95 };
  } });
  assert.equal(result.status, 'routed');
  assert.equal(result.route.modelId, 'gpt-6.1-sol');
  assert.equal(result.route.effort, 'medium');
  assert.equal(result.route.effortOptionId, 'reasoning_effort');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].candidates.every(model => model.family === 'gpt'));
  assert.deepEqual(requests[1].candidates.map(effort => effort.value), ['low', 'medium', 'high']);
  assert.equal(requests[1].modelId, 'gpt-6.1-sol');
});

test('configured judge adapter takes priority over direct transport', async () => {
  const result = await routeTask({ ...base, judge: async ({ stage }) => ({ choice: stage === 'model' ? 'gpt-6.1-sol' : 'high' }),
    transport: { ask() { throw new Error('transport must not be used'); } } });
  assert.equal(result.status, 'routed');
});

test('routing passes task evidence to a configured adapter for both review and fix tasks', async () => {
  for (const kind of ['review', 'fix']) {
    const result = await routeTask({ ...base, catalog: implementationCatalog, task: { ...task, kind, plan: kind === 'fix' ? implementationPlan : undefined, evidence: ['Observed failing assertion in the requested scope'] }, judge: async request => {
      assert.equal(request.task.kind, kind);
      assert.deepEqual(request.task.evidence, ['Observed failing assertion in the requested scope']);
      return { choice: request.stage === 'model' ? (kind === 'fix' ? 'gpt-6.1-sol' : 'gpt-6.1-sol') : 'high' };
    } });
    assert.equal(result.status, 'routed');
  }
});

test('custom adapters that ignore cancellation are bounded; an already cancelled request never calls an adapter', async () => {
  const result = await routeTask({ ...base, timeoutMs: 10, judge: async () => new Promise(() => {}) });
  assert.equal(result.status, 'main_judgment_required');
  assert.equal(result.reason, 'jev_aborted_or_timed_out');
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await routeTask({ ...base, signal: controller.signal, judge: async () => { called = true; return { choice: 'gpt-6.1-sol' }; } });
  assert.equal(cancelled.reason, 'jev_aborted_or_timed_out');
  assert.equal(called, false);
});

test('Claude selection restricts routing to available 5.5 Claude models', async () => {
  const result = await routeTask({ ...base, selectedModel: 'claude-sonnet-5-5', catalog: [...catalog,
    { id: 'claude-sonnet-4', family: 'claude', efforts: ['high'], effortOptionId: 'effort' }],
    judge: async ({ stage, candidates }) => {
      if (stage === 'model') assert.deepEqual(candidates.map(item => item.id), ['claude-sonnet-5-5', 'claude-opus-5-5']);
      return { choice: stage === 'model' ? 'claude-sonnet-5-5' : 'high' };
    } });
  assert.equal(result.status, 'routed');
});

test('Jev unavailable, inconclusive, malformed, or thrown errors request main judgment without fallback', async () => {
  for (const extra of [ {}, { judge: async () => { throw new Error('sensitive-provider-error'); } },
    { judge: async () => ({ choice: 'gpt-6.1-sol', confidence: 0.2 }) },
    { judge: async () => ({ choice: 'invented-model' }) } ]) {
    const result = await routeTask({ ...base, ...extra });
    assert.equal(result.status, 'main_judgment_required');
    assert.ok(!result.route);
    assert.equal(result.taskEvidence.id, 'R001');
    assert.equal(result.allowedCandidates.length, 2);
    assert.ok(!JSON.stringify(result).includes('sensitive-provider-error'));
  }
});

test('no direct credential reports configured MCP as available next path', async () => {
  const result = await routeTask({ ...base, mcpAvailable: true });
  assert.equal(result.status, 'main_judgment_required');
  assert.equal(result.reason, 'configured_mcp_adapter_required');
});

test('main judgment is validated before dispatch and rejects unknown model/effort and option mismatches', async () => {
  const good = { modelId: 'gpt-6.1-sol', effort: 'high', reason: 'Task scope is bounded and fully understood.' };
  assert.equal((await routeTask({ ...base, judgment: good })).route.source, 'main_judgment');
  for (const route of [ { ...good, modelId: 'unknown' }, { ...good, effort: 'max' },
    { ...good, modelId: 'claude-opus-5-5', effort: 'max' }, { ...good, effortOptionId: 'wrong_option' } ]) {
    assert.equal(validateRoute({ ...base, route }).valid, false);
    assert.notEqual((await routeTask({ ...base, judgment: route })).status, 'routed');
  }
});

test('reviewer and fixer subagents cannot route and inline override cannot bypass fanout rules', async () => {
  for (const callerRole of ['reviewer', 'fixer', undefined]) {
    assert.equal((await routeTask({ ...base, callerRole, judgment: { modelId: 'gpt-6.1-sol', effort: 'high' } })).reason, 'main_agent_required');
    assert.equal(validateRoute({ ...base, callerRole, route: { modelId: 'gpt-6.1-sol', effort: 'high' } }).valid, false);
  }
  const result = await routeTask({ ...base, task: { description: 'Change authorization rules' }, inlineOverride: true,
    judgment: { modelId: 'gpt-6.1-sol', effort: 'high', reason: 'Override requested' } });
  assert.notEqual(result.status, 'routed');
});

test('security work requires Astra xhigh or Opus 5.5 xhigh, including explicit main judgment', async () => {
  const securityTask = { description: 'Review authentication middleware' };
  for (const [selectedModel, modelId, effort] of [['gpt-6.1-sol', 'gpt-6-astra', 'xhigh'], ['claude-sonnet-5-5', 'claude-opus-5-5', 'xhigh']]) {
    const calls = [];
    const result = await routeTask({ ...base, selectedModel, task: securityTask, judge: async request => {
      calls.push(request); return { choice: request.stage === 'model' ? modelId : effort };
    } });
    assert.equal(result.status, 'routed');
    assert.deepEqual(calls[0].candidates.map(item => item.id), [modelId]);
    assert.deepEqual(calls[1].candidates.map(item => item.value), [effort]);
    assert.equal(validateRoute({ ...base, selectedModel, task: securityTask, route: { modelId, effort: 'high' } }).valid, false);
  }
});

test('missing required security model or any usable effort is a blocker, never a downgrade', async () => {
  for (const models of [catalog.filter(item => item.id !== 'gpt-6-astra'), catalog.map(item => item.id === 'gpt-6-astra' ? { ...item, efforts: ['low', 'medium'] } : item)]) {
    let called = false;
    const result = await routeTask({ ...base, catalog: models, task: { risk: 'security' }, judge: async () => { called = true; } });
    assert.equal(result.status, 'required_model_blocked');
    assert.equal(result.required.effort, 'xhigh');
    assert.equal(called, false);
  }
});

test('algorithm and uncertain work cannot select low effort', async () => {
  for (const riskyTask of [{ description: 'Rewrite graph traversal algorithm' }, { description: 'Unknown scope' }]) {
    const result = await routeTask({ ...base, task: riskyTask, judge: async ({ stage, candidates }) => {
      if (stage === 'effort') assert.ok(candidates.every(item => ['high', 'xhigh', 'max'].includes(item.level)));
      return { choice: stage === 'model' ? 'gpt-6.1-sol' : 'low' };
    } });
    assert.equal(result.status, 'main_judgment_required');
    assert.equal(validateRoute({ ...base, task: riskyTask, route: { modelId: 'gpt-6.1-sol', effort: 'low' } }).valid, false);
  }
});

test('catalog preserves exact option IDs and values, with explicit semantic levels for opaque host values', async () => {
  const custom = [{ id: 'host-gpt-astra', name: 'GPT Astra', family: 'gpt', efforts: [{ value: 'EXTRA_HIGH_TOKEN', level: 'xhigh' }], effortOptionId: 'host_effort_17' }];
  const result = await routeTask({ ...base, selectedModel: { family: 'gpt', id: 'selected-gpt' }, catalog: custom, task: { risk: 'security' },
    judgment: { modelId: 'host-gpt-astra', effort: 'EXTRA_HIGH_TOKEN', reason: 'Required security route' } });
  assert.equal(result.status, 'routed');
  assert.equal(result.route.effort, 'EXTRA_HIGH_TOKEN');
  assert.equal(result.route.effortOptionId, 'host_effort_17');
  assert.equal((await routeTask({ ...base, catalog: [{ ...catalog[0], efforts: ['invented'] }] })).status, 'invalid_configuration');
});

test('reviews cap at xhigh for every model, even when the host offers max or ultra', async () => {
  const hostCatalog = [{ ...catalog[1], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { ...catalog[4], efforts: ['low', 'high', 'xhigh', 'max'] }];
  for (const [selectedModel, modelId] of [['gpt-6-astra', 'gpt-6-astra'], ['claude-opus-5-5', 'claude-opus-5-5']]) {
    for (const reviewTask of [task, { risk: 'security' }, { description: 'Unknown scope' }]) {
      const input = { ...base, catalog: hostCatalog, selectedModel, task: reviewTask };
      assert.equal(validateRoute({ ...input, route: { modelId, effort: 'xhigh' } }).valid, true);
      for (const effort of ['max', 'ultra']) assert.equal(validateRoute({ ...input, route: { modelId, effort } }).valid, false);
    }
    const result = await routeTask({ ...base, catalog: hostCatalog, selectedModel, judge: async ({ stage, candidates }) => {
      if (stage === 'effort') assert.ok(candidates.every(item => ['low', 'medium', 'high', 'xhigh'].includes(item.level)));
      return { choice: stage === 'model' ? modelId : 'xhigh' };
    } });
    assert.equal(result.status, 'routed');
  }
});

test('security review without xhigh falls back to the same model at its highest level under the cap', async () => {
  for (const [efforts, fallback] of [[['low', 'high', 'max'], 'high'], [['high'], 'high']]) {
    const models = catalog.map(item => item.id === 'claude-opus-5-5' ? { ...item, efforts } : item);
    const input = { ...base, catalog: models, selectedModel: 'claude-opus-5-5', task: { risk: 'security' } };
    const result = await routeTask({ ...input, judgment: { modelId: 'claude-opus-5-5', effort: fallback, reason: 'Security fallback' } });
    assert.equal(result.status, 'routed');
    assert.equal(result.route.effortFallback, true);
    for (const effort of efforts.filter(item => item !== fallback)) {
      assert.equal(validateRoute({ ...input, route: { modelId: 'claude-opus-5-5', effort } }).valid, false, effort);
    }
  }
  const maxOnly = catalog.map(item => item.id === 'claude-opus-5-5' ? { ...item, efforts: ['max'] } : item);
  const blocked = await routeTask({ ...base, catalog: maxOnly, selectedModel: 'claude-opus-5-5', task: { risk: 'security' } });
  assert.equal(blocked.status, 'required_model_blocked');
  const exact = await routeTask({ ...base, selectedModel: 'claude-opus-5-5', task: { risk: 'security' },
    judgment: { modelId: 'claude-opus-5-5', effort: 'xhigh', reason: 'Exact security route' } });
  assert.equal(exact.route.effortFallback, undefined);
});

test('direct TypeSafe transport uses the verified official endpoint and typed model then effort questions', async () => {
  const calls = [];
  const key = 'fixture-direct-secret';
  const result = await routeTask({ ...base, credentials: resolveCredentials({ env: { JEV_API_KEY: key, TYPESAFE_BASE_URL: 'https://untrusted.example' } }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'jev-latest');
      const stage = Object.keys(body.questions)[0];
      assert.equal(body.questions[stage].type, 'choice');
      const candidates = Object.keys(body.questions[stage].criteria).map(value => ({ value }));
      const choice = stage === 'model' ? 'gpt-6.1-sol' : 'high';
      return { ok: true, json: async () => answer({ stage, candidates }, choice) };
    } });
  assert.equal(result.status, 'routed');
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('transport failures and response echoes never expose credential values', async () => {
  const key = 'fixture-credential-do-not-expose';
  for (const fetchImpl of [async () => { throw new Error(key); }, async () => ({ ok: false, status: 401, text: async () => key }),
    async () => ({ ok: true, json: async () => ({ answers: { model: { type: 'choice', choice: key } } }) })]) {
    const result = await routeTask({ ...base, credentials: resolveCredentials({ env: { TYPESAFE_API_KEY: key } }), fetchImpl });
    assert.equal(result.status, 'main_judgment_required');
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('malformed probability distributions and tied/inconclusive answers require main judgment', async () => {
  for (const probabilities of [{ 'gpt-6.1-sol': 2, 'gpt-6-astra': -1 }, { 'gpt-6.1-sol': 0.5, 'gpt-6-astra': 0.5 }, { 'gpt-6.1-sol': 1 }]) {
    const result = await routeTask({ ...base, transport: { ask: async () => ({ answers: { model: {
      type: 'choice', choice: 'gpt-6.1-sol', probabilities, confidence: 0.95 } }, model: 'jev-latest' }) } });
    assert.equal(result.status, 'main_judgment_required');
  }
});

test('TYPESAFE_API_KEY is the first name checked within one source', () => {
  const credential = resolveCredentials({ env: { JEV_API_KEY: 'jev-fixture-key', TYPESAFE_API_KEY: 'typesafe-fixture-key' } });
  assert.equal(credential.variable, 'TYPESAFE_API_KEY');
});

const implementationCatalog = [
  ...catalog.filter(item => item.id !== 'gpt-6.1-sol'),
  ...['sol', 'terra'].map(name => ({ id: `gpt-6.1-${name}`, family: 'gpt', efforts: ['low', 'high', 'xhigh'], effortOptionId: 'reasoning_effort' })),
];
const implementationPlan = {
  summary: 'Reject the invalid cookie before reading session data.',
  paths: ['src/session.mjs'],
  acceptanceCriteria: ['Invalid cookie is rejected; valid session behavior is preserved.'],
};

test('planned fixes use implementation models in the selected family, including security fixes', async () => {
  for (const [selectedModel, modelId] of [
    ['gpt-6-astra', 'gpt-6.1-sol'], ['gpt-6-astra', 'gpt-6.1-terra'],
    ['claude-opus-5-5', 'claude-sonnet-5-5'], ['claude-opus-5-5', 'claude-haiku-5-5'],
  ]) {
    const fix = { kind: 'fix', description: 'Fix authentication cookie validation', plan: implementationPlan };
    const result = await routeTask({ ...base, catalog: implementationCatalog, selectedModel, task: fix,
      judgment: { modelId, effort: 'high', reason: 'Bounded implementation with concrete acceptance criteria.' } });
    assert.equal(result.status, 'routed', modelId);
    assert.equal(result.audit.risk.security, true);
    assert.equal(validateRoute({ ...base, catalog: implementationCatalog, selectedModel, task: fix,
      route: { modelId, effort: 'low' } }).valid, false);
  }
});

test('Jev gets the plan and only implementation candidates for planned fixes', async () => {
  const result = await routeTask({ ...base, catalog: implementationCatalog,
    task: { kind: 'implementation', description: 'Fix session validation', plan: implementationPlan },
    judge: async request => {
      assert.deepEqual(request.task.plan, implementationPlan);
      if (request.stage === 'model') assert.deepEqual(request.candidates.map(model => model.id), ['gpt-6.1-sol', 'gpt-6.1-terra']);
      return { choice: request.stage === 'model' ? 'gpt-6.1-terra' : 'high' };
    } });
  assert.equal(result.status, 'routed');
});

test('fixes require a concrete plan before model selection; planning retains security reasoning floor', async () => {
  for (const plan of [undefined, true, {}, { summary: 'Fix it', paths: [], acceptanceCriteria: [] }]) {
    let called = false;
    const result = await routeTask({ ...base, catalog: implementationCatalog, task: { kind: 'fix', risk: 'ordinary', plan },
      judge: async () => { called = true; } });
    assert.equal(result.status, 'implementation_plan_required');
    assert.equal(called, false);
  }
  assert.equal(validateRoute({ ...base, catalog: implementationCatalog,
    task: { kind: 'planning', description: 'Decide authentication cookie policy' },
    route: { modelId: 'gpt-6.1-sol', effort: 'high' } }).valid, false);
});

test('planned fixes cannot inherit premium models or silently substitute unavailable implementation models', async () => {
  for (const [selectedModel, modelId, effort] of [['gpt-6-astra', 'gpt-6-astra', 'xhigh'], ['claude-opus-5-5', 'claude-opus-5-5', 'max']]) {
    const result = await routeTask({ ...base, catalog: implementationCatalog, selectedModel,
      task: { kind: 'fix', risk: 'ordinary', plan: implementationPlan },
      judgment: { modelId, effort, reason: 'Reuse reviewer model' } });
    assert.equal(result.reason, 'model_not_allowed');
  }
  const result = await routeTask({ ...base, catalog: catalog.filter(item => item.id !== 'gpt-6.1-sol'), task: { kind: 'fix', plan: implementationPlan } });
  assert.equal(result.status, 'required_model_blocked');
});

test('ordinary mechanical fixes can use low effort while plan-only security evidence retains High', async () => {
  const ordinaryPlan = { summary: 'Correct the label.', paths: ['src/label.mjs'], acceptanceCriteria: ['Label reads Save.'] };
  const input = { ...base, catalog: implementationCatalog, task: { kind: 'fix', risk: 'ordinary', plan: ordinaryPlan } };
  assert.equal(validateRoute({ ...input, route: { modelId: 'gpt-6.1-sol', effort: 'low' } }).valid, true);
  assert.equal(validateRoute({ ...input, route: { modelId: 'claude-haiku-5-5', effort: 'high' } }).valid, false);
  assert.equal(validateRoute({ ...input, task: { ...input.task, plan: implementationPlan },
    route: { modelId: 'gpt-6.1-sol', effort: 'low' } }).valid, false);
});

test('fixes cap at High for every model, and security fixes run at exactly High', async () => {
  const fixCatalog = implementationCatalog.map(item => ['claude-sonnet-5-5', 'claude-haiku-5-5'].includes(item.id)
    ? { ...item, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } : item);
  for (const [selectedModel, modelId] of [['gpt-6-astra', 'gpt-6.1-sol'], ['gpt-6-astra', 'gpt-6.1-terra'],
    ['claude-opus-5-5', 'claude-sonnet-5-5'], ['claude-opus-5-5', 'claude-haiku-5-5']]) {
    for (const fix of [{ kind: 'fix', risk: 'ordinary', plan: { summary: 'Correct the label.', paths: ['src/label.mjs'], acceptanceCriteria: ['Label reads Save.'] } },
      { kind: 'fix', description: 'Fix authentication cookie validation', plan: implementationPlan },
      { kind: 'implementation', description: 'Rewrite graph traversal algorithm', plan: implementationPlan }]) {
      const input = { ...base, catalog: fixCatalog, selectedModel, task: fix };
      assert.equal(validateRoute({ ...input, route: { modelId, effort: 'high' } }).valid, true, `${modelId} high`);
      for (const effort of ['xhigh', 'max']) {
        if (fixCatalog.find(item => item.id === modelId).efforts.includes(effort)) {
          assert.equal(validateRoute({ ...input, route: { modelId, effort } }).valid, false, `${modelId} ${effort}`);
        }
      }
    }
  }
});

const versionCatalog = [
  ...['claude-opus-5-5', 'claude-opus-6-0-20270115', 'claude-sonnet-4-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'opus']
    .map(id => ({ id, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortOptionId: 'effort' })),
  { id: 'gpt-6-astra', efforts: ['high', 'xhigh'], effortOptionId: 'reasoning_effort' },
  { id: 'host-astra-next', name: 'GPT 6.5 Astra', family: 'gpt', efforts: ['high', 'xhigh'], effortOptionId: 'reasoning_effort' },
  { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high'], effortOptionId: 'reasoning_effort' },
  { id: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high'], effortOptionId: 'reasoning_effort' },
  { id: 'gpt-6.1-terra', efforts: ['low', 'medium', 'high'], effortOptionId: 'reasoning_effort' },
];
const routineFix = { kind: 'fix', plan: { summary: 'Rename the helper.', paths: ['src/a.mjs'], acceptanceCriteria: ['Tests pass.'] } };

test('only the newest host version of each tier is eligible, matched by tier name and not a fixed version', async () => {
  const valid = (selectedModel, task, modelId, effort) => validateRoute({ ...base, catalog: versionCatalog, selectedModel, task, route: { modelId, effort } }).valid;
  assert.equal(valid('claude-opus-5-5', { risk: 'security' }, 'claude-opus-6-0-20270115', 'xhigh'), true);
  for (const id of ['claude-opus-5-5', 'opus']) assert.equal(valid('claude-opus-5-5', { risk: 'security' }, id, 'xhigh'), false, id);
  assert.equal(valid('gpt-6-astra', { risk: 'security' }, 'host-astra-next', 'xhigh'), true);
  assert.equal(valid('gpt-6-astra', { risk: 'security' }, 'gpt-6-astra', 'xhigh'), false);
  assert.equal(valid('gpt-6-astra', routineFix, 'gpt-6.2-sol', 'medium'), true);
  assert.equal(valid('gpt-6-astra', routineFix, 'gpt-6.1-terra', 'medium'), true);
  assert.equal(valid('gpt-6-astra', routineFix, 'gpt-6.1-sol', 'medium'), false);
  assert.equal(valid('claude-opus-5-5', routineFix, 'claude-sonnet-5-5', 'medium'), true);
  for (const id of ['claude-sonnet-4-5', 'claude-fable-5-1']) assert.equal(valid('claude-opus-5-5', routineFix, id, 'medium'), false, id);
  const result = await routeTask({ ...base, catalog: versionCatalog, selectedModel: 'claude-opus-5-5', task: routineFix, judge: async request => {
    if (request.stage === 'model') assert.deepEqual(request.candidates.map(model => model.id), ['claude-sonnet-5-5', 'claude-haiku-5-5']);
    return { choice: request.stage === 'model' ? 'claude-haiku-5-5' : 'medium' };
  } });
  assert.equal(result.status, 'routed');
});

test('a tier with no versioned entry keeps its unversioned host aliases', () => {
  const aliases = [{ id: 'opus', family: 'claude', efforts: ['high', 'xhigh'], effortOptionId: 'effort' }];
  assert.equal(validateRoute({ ...base, catalog: aliases, selectedModel: 'opus', task: { risk: 'security' }, route: { modelId: 'opus', effort: 'xhigh' } }).valid, true);
});

test('unclassified planned fixes may use Low or Medium; explicitly uncertain, algorithm, and security fixes need High', () => {
  const valid = (task, effort) => validateRoute({ ...base, catalog: versionCatalog, selectedModel: 'gpt-6-astra', task, route: { modelId: 'gpt-6.2-sol', effort } }).valid;
  for (const effort of ['low', 'medium', 'high']) assert.equal(valid(routineFix, effort), true, effort);
  for (const task of [{ ...routineFix, uncertain: true }, { ...routineFix, algorithm: true }, { ...routineFix, description: 'Fix session cookie parsing' }]) {
    assert.equal(valid(task, 'medium'), false);
    assert.equal(valid(task, 'high'), true);
  }
  assert.equal(valid({ kind: 'review', description: 'Review the change' }, 'medium'), false);
});
