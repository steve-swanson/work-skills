import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask, validateRoute } from '../lib/routing.mjs';

const catalog = [
  'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-mini',
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-6', 'claude-haiku-5-5', 'claude-fable-5-2',
].map(id => ({ id, provider: id.startsWith('gpt') ? 'codex' : 'claudeAgent',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortOptionId: 'effort' }));
const capabilities = [
  { provider: 'codex', family: 'gpt', enabled: true, canRunChildTask: true, canRunCrossProviderChildTask: true },
  { provider: 'claudeAgent', family: 'claude', enabled: true, canRunChildTask: true, canRunCrossProviderChildTask: true },
];
const base = { callerRole: 'main', selectedModel: 'gpt-6.2-sol', catalog, dispatchCapabilities: capabilities,
  credentialOptions: { env: {}, homeConfig: false }, task: { kind: 'review', complexity: 'routine', risk: 'ordinary' } };

test('routine reviewer candidates are newest Sol/Astra or Sonnet/Opus, never cheaper or frontend tiers', async () => {
  for (const [authorFamily, expected] of [['gpt', ['claude-opus-5-5', 'claude-sonnet-5-6']], ['claude', ['gpt-6-astra', 'gpt-6.2-sol']]]) {
    const requests = [];
    const input = { ...base, authorFamily };
    const result = await routeTask({ ...input, judge: async r => {
      requests.push(r); return { choice: r.stage === 'model' ? r.candidates[0].id : 'medium' };
    } });
    assert.equal(result.status, 'routed');
    assert.deepEqual(requests[0].candidates.map(m => m.id), expected);
    assert.equal(result.audit.selection.reviewComplexity, 'routine');
    for (const modelId of catalog.filter(m => !expected.includes(m.id)).map(m => m.id)) {
      assert.equal(validateRoute({ ...input, route: { modelId, effort: 'high' } }).valid, false, modelId);
      assert.notEqual((await routeTask({ ...input, judgment: { modelId, effort: 'high', reason: 'Attempt weaker reviewer' } })).status, 'routed');
    }
  }
});

test('Jev cannot select Terra/Haiku/Fable/untiered reviewers', async () => {
  for (const [authorFamily, modelId] of [['claude', 'gpt-6.1-terra'], ['claude', 'gpt-6-mini'],
    ['gpt', 'claude-haiku-5-5'], ['gpt', 'claude-fable-5-2']]) {
    const result = await routeTask({ ...base, authorFamily, judge: async () => ({ choice: modelId }) });
    assert.equal(result.status, 'main_judgment_required');
  }
});

test('complex reviews require premium tiers and at least High, preserving evidence for Jev and audit', async () => {
  for (const [authorFamily, modelId] of [['gpt', 'claude-opus-5-5'], ['claude', 'gpt-6-astra']]) {
    const input = { ...base, authorFamily, task: { ...base.task, complexity: 'complex', evidence: ['Cross-cutting state transitions require careful review.'] } };
    const requests = [];
    const result = await routeTask({ ...input, judge: async r => {
      requests.push(r); return { choice: r.stage === 'model' ? modelId : 'high' };
    } });
    assert.equal(result.status, 'routed');
    assert.equal(result.audit.selection.reviewComplexity, 'complex');
    assert.deepEqual(requests[0].candidates.map(m => m.id), [modelId]);
    assert.equal(requests[0].task.complexity, 'complex');
    assert.deepEqual(requests[0].task.evidence, input.task.evidence);
    assert.deepEqual(requests[1].candidates.map(e => e.value), ['high', 'xhigh']);
    for (const effort of ['low', 'medium', 'max']) assert.equal(validateRoute({ ...input, route: { modelId, effort } }).valid, false);
    assert.equal(validateRoute({ ...input, route: { modelId, effort: 'xhigh' } }).valid, true);
  }
});

test('security floor dominates routine/complex classification and never lowers to High when xhigh exists', () => {
  for (const complexity of ['routine', 'complex']) {
    const input = { ...base, task: { ...base.task, complexity, security: true } };
    assert.equal(validateRoute({ ...input, route: { modelId: 'claude-opus-5-5', effort: 'high' } }).valid, false);
    assert.equal(validateRoute({ ...input, route: { modelId: 'claude-opus-5-5', effort: 'xhigh' } }).valid, true);
  }
});

test('family fallback enforces reviewer floor and blocks if both families have only cheaper models', async () => {
  const cheap = catalog.filter(m => /terra|mini|haiku|fable/.test(m.id));
  const blocked = await routeTask({ ...base, catalog: cheap });
  assert.equal(blocked.status, 'required_model_blocked');
  const onlySameFloor = [...cheap, catalog.find(m => m.id === 'gpt-6.2-sol')];
  const input = { ...base, catalog: onlySameFloor };
  const fallback = await routeTask({ ...input, judgment: { modelId: 'gpt-6.2-sol', effort: 'high', reason: 'Opposite family lacks a qualifying reviewer.' } });
  assert.equal(fallback.status, 'routed');
  assert.equal(fallback.route.family, 'gpt');
  assert.equal(fallback.audit.selection.familyFallbackReason, 'opposite_model_or_effort_unavailable');
  const complex = await routeTask({ ...input, task: { ...base.task, complexity: 'complex' } });
  assert.equal(complex.status, 'required_model_blocked');
});

test('complex review may use same-family premium fallback, with same-model security fallback unchanged', async () => {
  const input = { ...base, catalog: catalog.filter(m => m.id !== 'claude-opus-5-5'), task: { ...base.task, complexity: 'complex' } };
  const result = await routeTask({ ...input, judgment: { modelId: 'gpt-6-astra', effort: 'high', reason: 'Use eligible same-family premium reviewer.' } });
  assert.equal(result.status, 'routed');
  assert.equal(result.route.modelId, 'gpt-6-astra');
  const security = { ...base, catalog: catalog.map(m => m.id === 'claude-opus-5-5' ? { ...m, efforts: ['low', 'high', 'max'] } : m), task: { ...base.task, security: true } };
  const r = await routeTask({ ...security, judgment: { modelId: 'claude-opus-5-5', effort: 'high', reason: 'Same model has no xhigh.' } });
  assert.equal(r.route.effortFallback, true);
});

test('review complexity validates input; Terra/Haiku remain eligible for simple implementation and inventory', () => {
  for (const complexity of ['unknown', true, null, 3]) {
    const result = validateRoute({ ...base, task: { ...base.task, complexity }, route: { modelId: 'claude-opus-5-5', effort: 'high' } });
    assert.equal(result.reason, 'invalid_task_complexity');
  }
  const plan = { summary: 'Rename a local helper.', paths: ['helper.mjs'], acceptanceCriteria: ['Existing tests pass.'] };
  for (const [selectedModel, modelId] of [['gpt-6.2-sol', 'gpt-6.1-terra'], ['claude-sonnet-5-6', 'claude-haiku-5-5']]) {
    for (const task of [{ kind: 'implementation', risk: 'ordinary', plan }, { kind: 'inventory', readOnly: true, description: 'Read file inventory.' }]) {
      assert.equal(validateRoute({ ...base, selectedModel, task, route: { modelId, effort: 'low' } }).valid, true);
    }
  }
});
