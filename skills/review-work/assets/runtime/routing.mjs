import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Credential handles contain metadata only. Values never leave this module. */
const credentialValues = new WeakMap();
export const KEY_ALIASES = Object.freeze([
  'TYPESAFE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_KEY', 'JEV_KEY', 'TYPESAFE_API', 'JEV_API',
]);
const LEVELS = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 });
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
  if (/^(?:claude(?:[-\s]|$)|(?:opus|sonnet|haiku)[-\s])/i.test(name)) return 'claude';
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
  const fields = ['title', 'description', 'scope', 'paths', 'areas', 'kind', 'evidence', 'risk'];
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
  return { category: 'uncertain', security: false, minimumEffort: 'high', evidence: ['task:uncertain_effort_defaults_high'] };
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
    if (efforts.some(option => !nonempty(option.value) || !option.level)
      || new Set(efforts.map(option => option.value)).size !== efforts.length) return null;
    normalized.push({ id: model.id, name: nonempty(model.name) ? model.name : model.id, family,
      provider: nonempty(model.provider) ? model.provider : null, efforts, effortOptionId: model.effortOptionId });
  }
  return normalized;
}

const claude55 = model => /\b(?:opus|sonnet|haiku)[-\s]*5[.\-]5\b/i.test(`${model.id} ${model.name}`);
const securityModel = (model, family) => family === 'gpt'
  ? /(?:^|[^a-z])astra(?:[^a-z]|$)/i.test(`${model.id} ${model.name}`)
  : /\bopus[-\s]*5[.\-]5\b/i.test(`${model.id} ${model.name}`);

function taskEvidence(task) {
  const evidence = {};
  for (const name of ['id', 'kind', 'title', 'description', 'scope', 'paths', 'areas', 'evidence', 'readOnly', 'risk', 'uncertain', 'security', 'securitySensitive', 'algorithm']) {
    if (task[name] !== undefined) evidence[name] = structuredClone(task[name]);
  }
  return evidence;
}

function contextFor({ callerRole, selectedModel, catalog, task }) {
  if (callerRole !== 'main') return failure('main_agent_required');
  if (!record(task)) return failure('invalid_task');
  const normalized = normalizeCatalog(catalog);
  if (!normalized) return failure('invalid_model_catalog');
  const family = modelFamily(selectedModel, normalized);
  if (!family) return failure('unknown_selected_family');
  const risk = assessRisk(task);
  const required = risk.security ? { model: family === 'gpt' ? 'Astra' : 'Opus 5.5', effort: family === 'gpt' ? 'xhigh' : 'max' } : null;
  let candidates = normalized.filter(model => model.family === family && (family !== 'claude' || claude55(model)));
  if (risk.security) candidates = candidates.filter(model => securityModel(model, family));
  candidates = candidates.map(model => ({ ...model, efforts: model.efforts.filter(effort => required
    ? effort.level === required.effort : LEVELS[effort.level] >= LEVELS[risk.minimumEffort]) })).filter(model => model.efforts.length);
  const context = { family, risk, required, allowedCandidates: candidates, taskEvidence: taskEvidence(task) };
  if (!candidates.length) return { ...context, status: 'required_model_blocked', reason: required ? 'required_security_model_or_effort_unavailable' : 'no_eligible_model_effort',
    required: required ?? { effort: risk.minimumEffort } };
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
  if (!selected.efforts.some(effort => effort.value === route.effort)) return { valid: false, ...failure('effort_not_allowed') };
  if (route.effortOptionId !== undefined && route.effortOptionId !== selected.effortOptionId) return { valid: false, ...failure('effort_option_id_mismatch') };
  return { valid: true, status: 'validated', route: { modelId: selected.id, family: context.family,
    effort: route.effort, effortOptionId: selected.effortOptionId } };
}

function choiceRequest(stage, context, model) {
  const candidates = model ? model.efforts : context.allowedCandidates;
  return { stage, task: context.taskEvidence, risk: context.risk, family: context.family,
    candidates, ...(model ? { modelId: model.id } : {}) };
}

function wireInput(request, jevModel, signal) {
  const instructions = request.stage === 'model'
    ? 'Choose the best available model for this review or fix task. Consider task complexity, risk, and adequate capability. Use only the supplied host model IDs. The main agent will separately choose a supported reasoning effort.'
    : 'Choose supported reasoning effort for the already selected model and this review or fix task. Read-only inventory can use Low. Algorithms need High or higher. When effort is uncertain choose High. Security floors have already restricted the available choices. Use only a supplied exact effort value.';
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
  const audit = { authority: 'main', family: context.family, risk: context.risk, stages: [] };
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
    if (!credentialValues.has(credentials)) return needMain(input.mcpAvailable ? 'configured_mcp_adapter_required' : 'jev_credentials_unavailable');
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
  const selected = await ask(choiceRequest('model', context));
  audit.stages.push({ stage: 'model', status: selected.reason ? 'unavailable_or_inconclusive' : 'selected', ...(selected.choice ? { choice: selected.choice } : {}) });
  if (selected.reason) return needMain(selected.reason);
  const model = context.allowedCandidates.find(candidate => candidate.id === selected.choice);
  const effort = await ask(choiceRequest('effort', context, model));
  audit.stages.push({ stage: 'effort', status: effort.reason ? 'unavailable_or_inconclusive' : 'selected', ...(effort.choice ? { choice: effort.choice } : {}) });
  if (effort.reason) return needMain(effort.reason, 'effort', { modelId: model.id });
  return routed({ modelId: model.id, effort: effort.choice }, 'jev');
}
