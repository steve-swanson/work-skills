import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Also resolves to the frozen local copy when running inside a pinned review.
export const ROUTING_SOURCE = fileURLToPath(import.meta.url);

/** Credential handles contain metadata only. Values never leave this module. */
const credentialValues = new WeakMap();
export const KEY_ALIASES = Object.freeze([
  'TYPESAFE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_KEY', 'JEV_KEY', 'TYPESAFE_API', 'JEV_API',
]);
const LEVELS = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 });
/** Reviews/planning cap at xhigh; fixes cap at high except explicit frontend policy. */
const REVIEW_EFFORT_CAP = 'xhigh';
const FIX_EFFORT_CAP = 'high';
const OFFICIAL_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const failure = reason => ({ status: 'invalid_configuration', reason });

function validKey(value) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return key.length > 0 && !/[\s`$;|&<>]/.test(key)
    && !/^(?:[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(key)
    && !/^[a-z\d](?:[a-z\d-]*\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(key);
}

/** Resolve explicit sources without reading files or revealing a usable key. */
export function resolveCredentials({ env = process.env, sources = [], sourceOrder, binding } = {}) {
  if (!record(env) || !Array.isArray(sources)) return { status: 'unavailable', reason: 'invalid_credential_configuration' };
  const all = [{ name: 'environment', values: env }, ...sources];
  if (all.some(source => !record(source) || !nonempty(source.name) || !record(source.values))
    || new Set(all.map(source => source.name)).size !== all.length
    || (sourceOrder !== undefined && (!Array.isArray(sourceOrder) || new Set(sourceOrder).size !== sourceOrder.length
      || sourceOrder.some(name => !all.some(source => source.name === name))))
    || (binding !== undefined && (!record(binding) || !nonempty(binding.variable)
      || (binding.source !== undefined && !nonempty(binding.source))))) {
    return { status: 'unavailable', reason: 'invalid_credential_configuration' };
  }
  const order = [...(sourceOrder ?? []), ...all.map(source => source.name).filter(name => !sourceOrder?.includes(name))];
  const names = binding ? [binding.variable] : KEY_ALIASES;
  for (const sourceName of order) {
    if (binding?.source !== undefined && sourceName !== binding.source) continue;
    const source = all.find(item => item.name === sourceName);
    for (const variable of names) {
      if (!Object.hasOwn(source.values, variable) || !validKey(source.values[variable])) continue;
      const handle = Object.freeze({ status: 'available', source: sourceName, variable, inspectedSources: order });
      credentialValues.set(handle, source.values[variable].trim());
      return handle;
    }
  }
  return Object.freeze({ status: 'unavailable', reason: binding ? 'bound_credential_missing' : 'credentials_missing', inspectedSources: order });
}

// Deliberately restricted dotenv: literal assignments, optional export and comments.
// No expansion, commands, sourcing, interpolation, or arbitrary JavaScript evaluation.
function parseDotenv(contents) {
  const values = Object.create(null);
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      let end = -1;
      for (let index = 1; index < value.length; index++) {
        if (quote === '"' && value[index] === '\\') { index++; continue; }
        if (value[index] === quote) { end = index; break; }
      }
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) continue;
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\([\\"nrt])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t' })[char] ?? char);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
      if (/['"]/.test(value)) continue;
    }
    if (validKey(value)) values[match[1]] = value;
  }
  return values;
}

/** One fixed home credential file, then caller-listed sources; never a directory walk. */
export async function discoverCredentials({ env = process.env, envFiles = [], sourceOrder, binding,
  homeDir = homedir(), homeConfig = true } = {}) {
  if (!Array.isArray(envFiles) || envFiles.some(path => !nonempty(path))
    || typeof homeConfig !== 'boolean' || (homeConfig && (!nonempty(homeDir) || !isAbsolute(homeDir)))) {
    return { status: 'unavailable', reason: 'invalid_credential_configuration' };
  }
  const homeFile = homeConfig ? join(homeDir, '.config', 'jev', 'credentials.env') : null;
  const files = [...new Set([...(homeFile ? [homeFile] : []), ...envFiles])];
  const sources = [];
  const unreadableSources = [];
  for (const path of files) {
    try {
      const contents = await readFile(path, 'utf8');
      if (contents.length > 1_048_576) throw new Error('oversize');
      sources.push({ name: path, values: parseDotenv(contents) });
    } catch {
      sources.push({ name: path, values: {} });
      unreadableSources.push(path);
    }
  }
  const resolved = resolveCredentials({ env, sources, sourceOrder: sourceOrder ?? (homeFile ? [homeFile, 'environment'] : undefined), binding });
  const result = Object.freeze({ ...resolved, unreadableSources });
  if (credentialValues.has(resolved)) credentialValues.set(result, credentialValues.get(resolved));
  return result;
}

function familyFromName(name) {
  if (typeof name !== 'string') return null;
  if (/^gpt(?:[-\s]|$)/i.test(name)) return 'gpt';
  if (/^(?:claude(?:[-\s]|$)|(?:opus|sonnet|haiku|fable)[-\s])/i.test(name)) return 'claude';
  return null;
}

/** The selected model must come from the main agent's authoritative host metadata. */
export function modelFamily(selectedModel, catalog = []) {
  if (record(selectedModel)) {
    const declared = selectedModel.family;
    const inferred = familyFromName(selectedModel.id);
    if (declared !== undefined) return ['gpt', 'claude'].includes(declared) && (!inferred || inferred === declared) ? declared : null;
    return modelFamily(selectedModel.id, catalog);
  }
  if (!nonempty(selectedModel)) return null;
  const matching = catalog.find(item => item.id === selectedModel);
  if (matching?.family !== undefined) return modelFamily({ id: selectedModel, family: matching.family });
  return familyFromName(selectedModel);
}

function textValues(value, depth = 0) {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => textValues(item, depth + 1));
  if (record(value)) return Object.entries(value).flatMap(([key, item]) => item === true ? [key] : textValues(item, depth + 1));
  return [];
}

/** Conservative evidence classification; an ordinary label never cancels a security signal. */
export function assessRisk(task = {}) {
  const evidence = [];
  const securityPattern = /(?:^|[^a-z])(?:security|auth[nz]?|authentication|authorization|authorisation|oauth|sso|rbac|abac|jwt|secrets?|credentials?|passwords?|api[-_\s]+keys?|crypt(?:o|ography|ographic)|encryption|decryption|tenant[-_\s/]+isolation|trust[-_\s]+boundar(?:y|ies)|(?:sql|command|code|prompt)[-_\s]+injection|csrf|xss|ssrf|access[-_\s]+control|sessions?|cookies?|cross[-_\s]+site[-_\s]+(?:scripting|request[-_\s]+forgery)|path[-_\s]+traversal|remote[-_\s]+code[-_\s]+execution)(?:[^a-z]|$)/i;
  const fields = ['title', 'description', 'scope', 'paths', 'areas', 'kind', 'evidence', 'risk', 'plan'];
  for (const field of fields) {
    if (textValues(task[field]).some(value => securityPattern.test(value))) evidence.push(`${field}:security_signal`);
  }
  if (task.security === true || task.securitySensitive === true) evidence.push('explicit:security');
  if (evidence.length) return { category: 'security', security: true, minimumEffort: 'security_floor', evidence };
  const combined = fields.flatMap(field => textValues(task[field])).join('\n');
  if (/\balgorithms?\b|\b(?:graph traversal|sorting|dynamic programming|concurrency correctness|numerical stability)\b/i.test(combined)
    || task.algorithm === true) return { category: 'algorithm', security: false, minimumEffort: 'high', evidence: ['task:algorithm'] };
  if (task.readOnly === true && /\binventory\b/i.test(combined)) {
    return { category: 'inventory', security: false, minimumEffort: 'low', evidence: ['task:read_only_inventory'] };
  }
  const uncertain = task.uncertain === true || /\b(?:uncertain|unknown|unsure|inconclusive)\b/i.test(combined);
  if (!uncertain && (task.risk === 'ordinary' || task.risk?.category === 'ordinary')) {
    return { category: 'ordinary', security: false, minimumEffort: 'low', evidence: ['task:explicit_ordinary'] };
  }
  return { category: 'uncertain', security: false, minimumEffort: 'high', unclassified: !uncertain,
    evidence: [uncertain ? 'task:explicit_uncertain' : 'task:uncertain_effort_defaults_high'] };
}

/** availableCapacity means free concurrent agent slots, never batch width. */
export function chooseConcurrency({ mode = 'auto', independentPartitions = 1, availableCapacity, maxReviewers } = {}) {
  const partitions = Array.isArray(independentPartitions) ? independentPartitions.length : independentPartitions;
  const auto = typeof mode === 'string' && mode.toLowerCase() === 'auto';
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!count(partitions) || (availableCapacity !== undefined && !count(availableCapacity))
    || (maxReviewers !== undefined && !count(maxReviewers)) || (!auto && !count(mode))) return failure('invalid_concurrency');
  const capacity = availableCapacity ?? 4;
  return {
    status: 'ok', count: Math.min(partitions, capacity, maxReviewers ?? Infinity, auto ? Infinity : mode),
    mode: auto ? 'auto' : 'explicit', independentPartitions: partitions, capacity,
    capacitySource: availableCapacity === undefined ? 'default' : 'host',
    disclosure: availableCapacity === undefined ? 'Host capacity was unavailable; concurrency uses a ceiling of 4.' : null,
    maxReviewers: maxReviewers ?? null,
  };
}

function effortLevel(value) {
  if (typeof value !== 'string') return null;
  const level = value.toLowerCase().replace(/[ _-]/g, '');
  return Object.hasOwn(LEVELS, level) ? level : level === 'extrahigh' ? 'xhigh' : null;
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.some(item => !record(item) || !nonempty(item.id))
    || new Set(catalog.map(item => item.id)).size !== catalog.length) return null;
  const normalized = [];
  for (const model of catalog) {
    if (model.available === false) continue;
    const family = modelFamily(model);
    if (!family) continue;
    if (!Array.isArray(model.efforts) || !model.efforts.length || !nonempty(model.effortOptionId)) return null;
    const efforts = model.efforts.map(option => typeof option === 'string'
      ? { value: option, level: effortLevel(option) }
      : { value: option?.value, level: effortLevel(option?.level) });
    if (efforts.some(option => !nonempty(option.value))
      || new Set(efforts.map(option => option.value)).size !== efforts.length) return null;
    const recognizedEfforts = efforts.filter(option => option.level);
    if (!recognizedEfforts.length) return null;
    const entry = { id: model.id, name: nonempty(model.name) ? model.name : model.id, family,
      provider: nonempty(model.provider) ? model.provider : null, efforts: recognizedEfforts, effortOptionId: model.effortOptionId };
    entry.tier = modelTier(entry, family);
    entry.version = entry.tier ? modelVersion(entry, entry.tier) : null;
    normalized.push(entry);
  }
  return normalized;
}

/**
 * Models are matched by tier name, never by a fixed version. Only the newest
 * version of each tier in the host's live catalog is eligible.
 */
const TIERS = Object.freeze({ gpt: ['astra', 'sol', 'terra'], claude: ['opus', 'sonnet', 'haiku', 'fable'] });
const SECURITY_TIER = Object.freeze({ gpt: 'astra', claude: 'opus' });
const REVIEW_TIERS = Object.freeze({ gpt: ['sol', 'astra'], claude: ['sonnet', 'opus'] });
const IMPLEMENTATION_TIERS = Object.freeze({ gpt: ['sol', 'terra'], claude: ['sonnet', 'haiku'] });
const modelLabel = model => `${model.id} ${model.name}`.toLowerCase()
  .replace(/(?:^|[^\d])(?:19|20)\d{2}-?\d{2}-?\d{2}(?!\d)/g, ' ');

function modelTier(model, family) {
  const label = modelLabel(model);
  return TIERS[family].find(tier => new RegExp(`(?:^|[^a-z])${tier}(?:[^a-z]|$)`).test(label)) ?? null;
}

/** Reads "opus-5-5", "Opus 5.5", "gpt-6.1-sol", or "GPT 6.1 Sol" as [major, minor]. */
function modelVersion(model, tier) {
  const label = modelLabel(model);
  const number = '(\\d{1,3})(?:[.\\-](\\d{1,3}))?(?!\\d)';
  const match = label.match(new RegExp(`(?:^|[^a-z])${tier}[-_\\s]*${number}`))
    ?? label.match(new RegExp(`(?:^|[^\\d.])${number}[-_\\s]+${tier}(?:[^a-z]|$)`));
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1];

/** Keep the newest version per tier. Unversioned entries count only when a tier has no versioned entry. */
function newestPerTier(models, family) {
  const newest = new Map();
  for (const model of models) {
    if (!model.tier || !model.version) continue;
    const current = newest.get(model.tier);
    if (!current || compareVersions(model.version, current) > 0) newest.set(model.tier, model.version);
  }
  return models.filter(model => {
    if (!model.tier) return family === 'gpt';
    const top = newest.get(model.tier);
    return top ? model.version && compareVersions(model.version, top) === 0 : true;
  });
}

/** Security review: exact xhigh, else the same model's highest level at or below the cap and at least High. */
function securityEfforts(model) {
  const exact = model.efforts.filter(effort => effort.level === 'xhigh');
  if (exact.length) return { efforts: exact, effortFallback: false };
  const usable = model.efforts.filter(effort => LEVELS[effort.level] >= LEVELS.high && LEVELS[effort.level] <= LEVELS[REVIEW_EFFORT_CAP]);
  const best = Math.max(-1, ...usable.map(effort => LEVELS[effort.level]));
  return { efforts: usable.filter(effort => LEVELS[effort.level] === best), effortFallback: true };
}
const implementationTask = task => ['fix', 'implementation'].includes(task.kind);
const concretePlan = plan => record(plan) && nonempty(plan.summary)
  && ['paths', 'acceptanceCriteria'].every(key => Array.isArray(plan[key])
    && plan[key].length > 0 && plan[key].every(nonempty));

function taskEvidence(task) {
  const evidence = {};
  for (const name of ['id', 'kind', 'title', 'description', 'scope', 'paths', 'areas', 'evidence', 'readOnly', 'risk', 'uncertain', 'security', 'securitySensitive', 'algorithm', 'plan', 'frontend', 'complexity']) {
    if (task[name] !== undefined) evidence[name] = structuredClone(task[name]);
  }
  return evidence;
}

function contextFor({ callerRole, selectedModel, catalog, task, authorFamily, frontendPreference, dispatchCapabilities }) {
  if (callerRole !== 'main') return failure('main_agent_required');
  if (!record(task)) return failure('invalid_task');
  const normalized = normalizeCatalog(catalog);
  if (!normalized) return failure('invalid_model_catalog');
  const callerFamily = modelFamily(selectedModel, normalized);
  if (!callerFamily) return failure('unknown_selected_family');
  if (authorFamily !== undefined && !['gpt', 'claude'].includes(authorFamily)) return failure('invalid_author_family');
  if (task.frontend !== undefined && typeof task.frontend !== 'boolean') return failure('invalid_frontend_classification');
  if (task.complexity !== undefined && !['routine', 'complex'].includes(task.complexity)) return failure('invalid_task_complexity');
  if (dispatchCapabilities !== undefined && (!Array.isArray(dispatchCapabilities)
    || dispatchCapabilities.some(c => !record(c) || !nonempty(c.provider) || !['gpt', 'claude'].includes(c.family)
      || ['enabled', 'canRunChildTask', 'canRunCrossProviderChildTask'].some(k => typeof c[k] !== 'boolean'))
    || new Set(dispatchCapabilities.map(c => `${c.provider}:${c.family}`)).size !== dispatchCapabilities.length)) {
    return failure('invalid_dispatch_capabilities');
  }
  const callerId = typeof selectedModel === 'string' ? selectedModel : selectedModel.id;
  const callerProvider = normalized.find(m => m.id === callerId)?.provider;
  const dispatchable = model => {
    // Without an adapter's evidence, only the current family/catalog scope is
    // assumed usable. Catalog presence alone never proves cross-family dispatch.
    if (dispatchCapabilities === undefined) return model.family === callerFamily;
    return dispatchCapabilities.some(c => c.provider === model.provider && c.family === model.family && c.enabled && c.canRunChildTask
      && ((c.provider === callerProvider && c.family === callerFamily) || c.canRunCrossProviderChildTask));
  };
  const implementing = implementationTask(task);
  if (implementing && !concretePlan(task.plan)) return { status: 'implementation_plan_required', reason: 'concrete_fix_plan_required' };
  const frontend = implementing && task.frontend === true;
  if (frontend && frontendPreference === undefined) return { status: 'frontend_choice_required', family: callerFamily,
    primary: callerFamily === 'gpt' ? 'Astra' : 'Fable', fallback: callerFamily === 'gpt' ? 'Sol' : 'Opus' };
  if (frontend && !['primary', 'fallback'].includes(frontendPreference)) return failure('invalid_frontend_preference');
  const risk = assessRisk(task);
  const reviewing = task.kind === 'review';
  const complexReview = reviewing && task.complexity === 'complex';
  // A concrete plan settles an unclassified fix, so it may use any effort up to the fix cap.
  const minimumEffort = risk.security || complexReview ? 'high' : implementing && risk.unclassified ? 'low' : risk.minimumEffort;
  const maximumEffort = frontend ? 'xhigh' : implementing ? FIX_EFFORT_CAP : REVIEW_EFFORT_CAP;
  const implementationFamily = authorFamily ?? callerFamily;
  const opposite = implementationFamily === 'gpt' ? 'claude' : 'gpt';
  const eligible = family => {
    let models = newestPerTier(normalized.filter(m => m.family === family && dispatchable(m)), family);
    if (frontend) {
      const tier = family === 'gpt' ? (frontendPreference === 'primary' ? 'astra' : 'sol')
        : frontendPreference === 'primary' ? 'fable' : 'opus';
      models = models.filter(m => m.tier === tier);
    } else if (implementing) models = models.filter(m => IMPLEMENTATION_TIERS[family].includes(m.tier));
    else {
      if (reviewing) models = models.filter(m => REVIEW_TIERS[family].includes(m.tier));
      if (risk.security || complexReview) models = models.filter(m => m.tier === SECURITY_TIER[family]);
    }
    return models.map(model => risk.security && !implementing ? { ...model, ...securityEfforts(model) }
      : { ...model, efforts: model.efforts.filter(e => LEVELS[e.level] >= LEVELS[minimumEffort]
        && LEVELS[e.level] <= LEVELS[maximumEffort]) }).filter(m => m.efforts.length);
  };
  let family = reviewing ? opposite : callerFamily;
  let candidates = eligible(family);
  let familyFallbackReason = null;
  if (reviewing && !candidates.length) {
    familyFallbackReason = normalized.some(m => m.family === opposite && dispatchable(m))
      ? 'opposite_model_or_effort_unavailable' : 'opposite_dispatch_unavailable_or_unconfirmed';
    family = implementationFamily;
    candidates = eligible(family);
  }
  const required = risk.security && !implementing ? { model: family === 'gpt' ? 'newest Astra' : 'newest Opus', effort: 'xhigh' }
    : complexReview ? { model: family === 'gpt' ? 'newest Astra' : 'newest Opus', minimumEffort: 'high', maximumEffort: REVIEW_EFFORT_CAP } : null;
  const selection = { callerFamily, ...(reviewing ? { implementationFamily, authorFamilyAssumed: authorFamily === undefined,
    preferredFamily: opposite, familyFallbackReason, reviewComplexity: task.complexity ?? 'routine' } : {}), ...(frontend ? { frontendPreference } : {}),
    capabilities: dispatchCapabilities?.map(c => ({ provider: c.provider, family: c.family, enabled: c.enabled,
      canRunChildTask: c.canRunChildTask, canRunCrossProviderChildTask: c.canRunCrossProviderChildTask })) ?? 'current_family_only' };
  const context = { family, risk, required, maximumEffort, selection, fixedModel: frontend,
    allowedCandidates: candidates, taskEvidence: taskEvidence(task) };
  if (!candidates.length) return { ...context, status: 'required_model_blocked', reason: risk.security && !implementing ? 'required_security_model_or_effort_unavailable' : complexReview ? 'required_complex_review_model_or_effort_unavailable' : 'no_eligible_model_effort',
    required: required ?? { effort: minimumEffort, maximumEffort } };
  return { ...context, status: 'ready' };
}

/** Recheck every main-agent or Jev decision against the same immutable fanout floors. */
export function validateRoute(input = {}) {
  const context = contextFor(input);
  if (context.status !== 'ready') return { valid: false, ...context };
  const route = input.route;
  if (!record(route) || !nonempty(route.modelId) || !nonempty(route.effort)) return { valid: false, ...failure('invalid_route') };
  const selected = context.allowedCandidates.find(model => model.id === route.modelId);
  if (!selected) return { valid: false, ...failure('model_not_allowed') };
  if (route.provider !== undefined && route.provider !== selected.provider) return { valid: false, ...failure('provider_mismatch') };
  if (!selected.efforts.some(effort => effort.value === route.effort)) return { valid: false, ...failure('effort_not_allowed') };
  if (route.effortOptionId !== undefined && route.effortOptionId !== selected.effortOptionId) return { valid: false, ...failure('effort_option_id_mismatch') };
  return { valid: true, status: 'validated', route: { modelId: selected.id, family: context.family,
    effort: route.effort, effortOptionId: selected.effortOptionId, ...(selected.provider ? { provider: selected.provider } : {}),
    ...(selected.effortFallback ? { effortFallback: true } : {}) } };
}

function choiceRequest(stage, context, model) {
  const candidates = model ? model.efforts : context.allowedCandidates;
  return { stage, task: context.taskEvidence, risk: context.risk, family: context.family,
    candidates, ...(model ? { modelId: model.id } : {}) };
}

function wireInput(request, jevModel, signal) {
  const instructions = request.stage === 'model'
    ? 'Choose the least costly adequately capable model for this task phase. Candidates are already limited to the newest version of each tier the host offers. Reviews require at least Sol or Sonnet; complex reviews are restricted to Astra or Opus. For planned fixes, use the supplied plan and acceptance criteria to judge implementation difficulty, not the reviewer model or original finding severity. Use only the supplied host model IDs. The main agent will separately choose a supported reasoning effort.'
    : request.task?.frontend === true && ['fix', 'implementation'].includes(request.task?.kind)
      ? 'Choose the lowest supplied exact effort adequate for this frontend implementation. The user-selected model tier is fixed. Frontend work may use up to extra-high; security, algorithmic and uncertain work requires at least High. Max and Ultra are excluded.'
    : ['fix', 'implementation'].includes(request.task?.kind)
      ? 'Choose the lowest supported reasoning effort adequate for this planned fix, judged from the plan and acceptance criteria. Mechanical edits can use Low; typical bounded fixes can use Medium; use High only for fixes that need real code judgment. Fixes are capped at High, and security fixes are already restricted to High. Use only a supplied exact effort value.'
      : 'Choose supported reasoning effort for the already selected model and this review or planning task. Read-only inventory can use Low. Algorithms need High or higher. When effort is uncertain choose High. Security floors and the extra-high review ceiling have already restricted the available choices. Use only a supplied exact effort value.';
  return { state: { task: request.task, risk: request.risk, family: request.family, ...(request.modelId ? { modelId: request.modelId } : {}) },
    questions: { [request.stage]: { type: 'choice', instructions, criteria: Object.fromEntries(request.candidates.map(candidate => [candidate.value ?? candidate.id, candidate])) } },
    model: jevModel, signal };
}

function checkedChoice(result, candidates, minimumConfidence, raw = false) {
  const choices = candidates.map(candidate => candidate.value ?? candidate.id);
  if (!record(result) || !choices.includes(result.choice)) return { reason: 'jev_invalid_choice' };
  if (result.confidence !== undefined && result.confidence !== null && (typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)) return { reason: 'jev_invalid_confidence' };
  if (result.confidence != null && result.confidence < minimumConfidence) return { reason: 'jev_inconclusive' };
  if (raw) {
    if (result.type !== 'choice' || !record(result.probabilities)
      || Object.keys(result.probabilities).length !== choices.length
      || choices.some(choice => !Object.hasOwn(result.probabilities, choice))) return { reason: 'jev_invalid_distribution' };
    const probabilities = choices.map(choice => result.probabilities[choice]);
    if (probabilities.some(probability => typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)) return { reason: 'jev_invalid_distribution' };
    const tolerance = Math.min(0.05, Math.max(0.01, probabilities.filter(probability => probability > 0).length * 0.005)) + 1e-9;
    if (Math.abs(probabilities.reduce((sum, probability) => sum + probability, 0) - 1) > tolerance) return { reason: 'jev_invalid_distribution' };
    const selected = result.probabilities[result.choice];
    if (Math.max(...probabilities) - selected > 0.01 + 1e-9) return { reason: 'jev_invalid_choice' };
    if (choices.length > 1 && (selected < minimumConfidence || choices.some(choice => choice !== result.choice && result.probabilities[choice] >= selected - 0.01))) {
      return { reason: 'jev_inconclusive' };
    }
  }
  return { choice: result.choice, confidence: result.confidence ?? null };
}

function redacted(value, credential) {
  const secret = credentialValues.get(credential);
  if (!secret) return value;
  const walk = item => {
    if (typeof item === 'string') return item.split(secret).join('[REDACTED]');
    if (Array.isArray(item)) return item.map(walk);
    if (record(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [walk(key), walk(child)]));
    return item;
  };
  return walk(value);
}

async function directAsk(input, credentials, fetchImpl) {
  const secret = credentialValues.get(credentials);
  if (!secret) throw new Error('credentials unavailable');
  // Never trust env-derived base URLs or follow redirects with an authorization header.
  const response = await fetchImpl(OFFICIAL_ENDPOINT, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: input.state, questions: input.questions, model: input.model }), signal: input.signal });
  if (!response.ok) throw new Error('TypeSafe request failed');
  return response.json();
}

/** Main-owner-only policy selection. This function never dispatches agents or mutates review state. */
export async function routeTask(input = {}) {
  const context = contextFor(input);
  if (context.status !== 'ready') return context;
  let credentials = input.credentials;
  const audit = { authority: 'main', family: context.family, risk: context.risk, selection: context.selection, stages: [] };
  const needMain = (reason, stage = 'model', partial) => redacted({ status: 'main_judgment_required', reason, stage,
    taskEvidence: context.taskEvidence, allowedCandidates: context.allowedCandidates, required: context.required,
    ...(partial ? { partial } : {}), audit }, credentials);
  const routed = (decision, source) => {
    const validated = validateRoute({ ...input, route: decision });
    if (!validated.valid) return needMain(validated.reason);
    return redacted({ status: 'routed', route: { ...validated.route, source }, audit }, credentials);
  };
  if (input.judgment !== undefined) {
    if (!record(input.judgment) || !nonempty(input.judgment.reason)) return needMain('main_judgment_reason_required');
    audit.mainReason = input.judgment.reason;
    return routed(input.judgment, 'main_judgment');
  }
  const minimumConfidence = input.minimumConfidence ?? 0.6;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const jevModel = input.jevModel ?? 'jev-latest';
  if (typeof minimumConfidence !== 'number' || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !nonempty(jevModel)) return failure('invalid_jev_configuration');
  if (input.judge !== undefined && typeof input.judge !== 'function') return failure('invalid_judge_adapter');
  if (input.transport !== undefined && !(typeof input.transport === 'function' || typeof input.transport?.ask === 'function')) return failure('invalid_transport_adapter');
  if (!input.judge && !input.transport) {
    credentials ??= await discoverCredentials(input.credentialOptions ?? { envFiles: input.envFiles ?? [], env: input.env ?? process.env,
      sourceOrder: input.sourceOrder, binding: input.binding, homeDir: input.homeDir, homeConfig: input.homeConfig });
    audit.credentials = { status: credentials?.status ?? 'unavailable', ...(credentials?.variable ? { variable: credentials.variable, source: credentials.source } : {}) };
    if (!credentialValues.has(credentials)) return needMain(input.mcpAvailable ? 'configured_mcp_adapter_required' : 'jev_credentials_unavailable',
      context.fixedModel ? 'effort' : 'model', context.fixedModel ? { modelId: context.allowedCandidates[0].id } : undefined);
  }
  const ask = async request => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
    const work = async () => {
      if (input.judge) return checkedChoice(await input.judge({ ...redacted(request, credentials), signal }), request.candidates, minimumConfidence);
      const wire = wireInput(redacted(request, credentials), jevModel, signal);
      const reply = input.transport ? await (typeof input.transport === 'function' ? input.transport(wire) : input.transport.ask(wire))
        : await directAsk(wire, credentials, input.fetchImpl ?? fetch);
      if (!record(reply) || !record(reply.answers) || Object.keys(reply.answers).length !== 1 || !Object.hasOwn(reply.answers, request.stage)) return { reason: 'jev_malformed_response' };
      return checkedChoice(reply.answers[request.stage], request.candidates, minimumConfidence, true);
    };
    // Bound custom adapters too: they may ignore AbortSignal. Late replies never dispatch.
    let onAbort;
    try {
      if (signal.aborted) return { reason: 'jev_aborted_or_timed_out' };
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('routing deadline'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([work(), aborted]);
    } catch {
      return { reason: signal.aborted ? 'jev_aborted_or_timed_out' : 'jev_unavailable' };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
  const selected = context.fixedModel ? { choice: context.allowedCandidates[0].id } : await ask(choiceRequest('model', context));
  audit.stages.push({ stage: 'model', status: context.fixedModel ? 'frontend_preference' : selected.reason ? 'unavailable_or_inconclusive' : 'selected', ...(selected.choice ? { choice: selected.choice } : {}) });
  if (selected.reason) return needMain(selected.reason);
  const model = context.allowedCandidates.find(candidate => candidate.id === selected.choice);
  const effort = await ask(choiceRequest('effort', context, model));
  audit.stages.push({ stage: 'effort', status: effort.reason ? 'unavailable_or_inconclusive' : 'selected', ...(effort.choice ? { choice: effort.choice } : {}) });
  if (effort.reason) return needMain(effort.reason, 'effort', { modelId: model.id });
  return routed({ modelId: model.id, effort: effort.choice }, 'jev');
}

export function sanitizeRoute(result, input) {
  const values = new Set();
  const sources = [input.env, input.credentialOptions?.env, ...((input.sources ?? []).map?.(source => source.values) ?? [])];
  for (const source of sources) if (source && typeof source === 'object') for (const value of Object.values(source)) if (typeof value === 'string' && value) values.add(value);
  for (const [key, value] of Object.entries(process.env)) if (/(?:key|token|secret|password|credential|jev_api|typesafe_api)/i.test(key) && value) values.add(value);
  const secrets = [...values].sort((a, b) => b.length - a.length);
  const walk = value => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(?:authorization|api[_-]?key|token|password|secret|credentials|credentialOptions|env|envFiles|sources)$/i.test(key))
      .map(([key, child]) => [walk(key), walk(child)]));
    return value;
  };
  return walk(result);
}
