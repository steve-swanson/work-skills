const draftOf = finding => ({ decision: finding.decision ?? null, context: finding.context ?? '' });
const submitted = finding => finding.submittedRevision !== null && finding.submittedRevision !== undefined;
const revisionOf = finding => Number(finding.revision ?? 0);

export class DraftStore {
  constructor({ patch, onChange = () => {}, onConflict = () => {}, debounceMs = 550 }) {
    this.patch = patch;
    this.onChange = onChange;
    this.onConflict = onConflict;
    this.debounceMs = debounceMs;
    this.records = new Map();
  }

  ingest(findings) {
    for (const finding of findings) {
      let record = this.records.get(finding.id);
      if (!record) {
        record = { server: finding, remote: finding, working: draftOf(finding), version: 0, savedVersion: 0, timer: null, saving: null, error: null, conflict: null };
        this.records.set(finding.id, record);
        continue;
      }
      if (revisionOf(finding) < revisionOf(record.server) || revisionOf(finding) < revisionOf(record.remote)) continue;
      record.remote = finding;
      if (record.saving) continue;
      if (record.version !== record.savedVersion || record.conflict) {
        if (revisionOf(finding) > revisionOf(record.server) || record.conflict) {
          record.conflict = { message: submitted(finding) ? 'This finding was submitted elsewhere. Your draft is preserved below.' : 'This finding changed in another tab. Your draft is preserved below.', latest: finding };
          clearTimeout(record.timer);
          record.timer = null;
        }
      } else {
        record.server = finding;
        record.working = draftOf(finding);
      }
    }
    this.onChange();
  }

  get(id) {
    const record = this.records.get(id);
    if (!record) return null;
    const dirty = record.version !== record.savedVersion;
    return {
      ...record.remote, ...record.working,
      persistedDecision: record.server.decision ?? null,
      persistedContext: record.server.context ?? '',
      persistedRevision: revisionOf(record.server),
      dirty, saving: Boolean(record.saving), locked: submitted(record.remote) || submitted(record.server),
      saveError: record.error?.message ?? null, conflict: record.conflict,
      saveState: record.conflict ? 'conflict' : record.error ? 'error' : record.saving ? 'saving' : dirty ? 'pending' : 'saved',
    };
  }

  list() { return [...this.records.keys()].map(id => this.get(id)); }

  update(id, update) {
    const record = this.records.get(id);
    if (!record) throw new Error('Finding not found.');
    if (this.get(id).locked) throw new Error('Submitted findings are read-only.');
    const next = { ...record.working, ...update };
    if (![null, 'fix', 'dont_fix', 'clarify'].includes(next.decision)) throw new Error('Invalid decision.');
    if (next.decision === record.working.decision && next.context === record.working.context) return;
    record.working = next;
    record.version += 1;
    record.error = null;
    this.schedule(id);
    this.onChange();
  }

  schedule(id) {
    const record = this.records.get(id);
    clearTimeout(record.timer);
    record.timer = null;
    if (record.conflict || record.saving) return;
    record.timer = setTimeout(() => { record.timer = null; this.save(id).catch(() => {}); }, this.debounceMs);
  }

  save(id) {
    const record = this.records.get(id);
    clearTimeout(record.timer);
    record.timer = null;
    if (record.saving) return record.saving;
    if (record.conflict) return Promise.reject(new Error(record.conflict.message));
    if (record.version === record.savedVersion) return Promise.resolve();
    if (this.get(id).locked) return Promise.reject(new Error('Submitted findings are read-only.'));
    // Start on the next microtask so saving is visible before patch can settle.
    record.saving = Promise.resolve().then(async () => {
      while (record.version !== record.savedVersion) {
        if (submitted(record.remote)) throw Object.assign(new Error('This finding was submitted elsewhere.'), { status: 409 });
        const version = record.version;
        const payload = { ...record.working, expectedRevision: revisionOf(record.server) };
        const result = await this.patch(id, payload);
        const saved = result.finding ?? result;
        record.server = saved;
        record.savedVersion = version;
        record.error = null;
        if (version === record.version) record.working = draftOf(saved);
        if (revisionOf(record.remote) <= revisionOf(saved)) record.remote = saved;
        else if (record.version !== record.savedVersion) {
          record.conflict = { message: 'This finding changed in another tab. Your newer draft is preserved.', latest: record.remote };
          throw Object.assign(new Error(record.conflict.message), { status: 409 });
        } else {
          record.server = record.remote;
          record.working = draftOf(record.remote);
        }
        this.onChange();
      }
    }).catch(error => {
      record.error = error;
      if (error.status === 409) {
        record.conflict ??= { message: error.message, latest: revisionOf(record.remote) > revisionOf(record.server) ? record.remote : null };
        this.onConflict(id);
      }
      throw error;
    }).finally(() => { record.saving = null; this.onChange(); });
    this.onChange();
    return record.saving;
  }

  async flush() {
    const results = await Promise.allSettled([...this.records.keys()].map(id => this.save(id)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  acceptRemote(id) {
    const record = this.records.get(id);
    if (!record?.conflict?.latest) throw new Error('Wait for the latest saved version to load.');
    if (record.saving) throw new Error('Wait for the current save to finish.');
    clearTimeout(record.timer);
    record.timer = null;
    record.server = record.conflict.latest;
    record.remote = record.server;
    record.working = draftOf(record.server);
    record.savedVersion = record.version;
    record.conflict = null;
    record.error = null;
    this.onChange();
  }

  retryLocal(id) {
    const record = this.records.get(id);
    if (this.get(id).locked) throw new Error('Submitted findings are read-only.');
    if (!record?.conflict?.latest) throw new Error('Wait for the latest saved version to load.');
    record.server = record.conflict.latest;
    record.conflict = null;
    record.error = null;
    record.version += 1;
    this.schedule(id);
    this.onChange();
  }

  destroy() { for (const record of this.records.values()) clearTimeout(record.timer); }
}

export class SubmissionAttempt {
  constructor({ storage, reviewId, randomUUID }) {
    this.storage = storage;
    this.reviewId = reviewId;
    this.randomUUID = randomUUID;
    this.key = `review-work:submit:${reviewId}`;
    this.pending = null;
    this.reloadRequired = null;
    try {
      const value = JSON.parse(storage?.getItem(this.key) ?? 'null');
      if (value?.reviewId === reviewId && typeof value.requestId === 'string' && typeof value.reviewedSha === 'string') {
        this.pending = immutableSubmission(value);
        this.reloadRequired = storage?.getItem(`${this.key}:reload`) || null;
      }
    } catch { /* Storage can be unavailable in private browser contexts. */ }
  }

  begin(reviewedSha, findings = []) {
    if (!this.pending) {
      this.pending = immutableSubmission({ requestId: this.randomUUID(), reviewId: this.reviewId, reviewedSha, findings });
      try { this.storage?.setItem(this.key, JSON.stringify(this.pending)); } catch { /* In-memory retries remain stable. */ }
    }
    return this.pending;
  }

  restore(payload) {
    if (!this.pending && payload?.reviewId === this.reviewId) {
      this.pending = immutableSubmission(payload);
      try { this.storage?.setItem(this.key, JSON.stringify(this.pending)); } catch { /* In-memory retries remain stable. */ }
    }
    return this.pending;
  }

  requireReload(reason) {
    this.reloadRequired = reason;
    try { this.storage?.setItem(`${this.key}:reload`, reason); } catch { /* The current page still blocks retry. */ }
  }

  complete() {
    this.pending = null;
    this.reloadRequired = null;
    try { this.storage?.removeItem(this.key); this.storage?.removeItem(`${this.key}:reload`); } catch { /* Best effort. */ }
  }
}

function immutableSubmission(payload) {
  return Object.freeze({
    requestId: payload.requestId, reviewId: payload.reviewId, reviewedSha: payload.reviewedSha,
    findings: Object.freeze((payload.findings ?? []).map(item => Object.freeze({ id: item.id, expectedRevision: item.expectedRevision }))),
  });
}

export async function sendSubmission({ drafts, attempt, reviewedSha, send }) {
  if (attempt.reloadRequired) throw Object.assign(new Error('Reload findings and review the current choices before submitting again.'), { status: 409, code: 'reload_required' });
  if (!attempt.pending) {
    await drafts.flush();
    const findings = drafts.list().filter(finding => finding.decision && !finding.locked).map(finding => ({ id: finding.id, expectedRevision: finding.persistedRevision }));
    attempt.begin(reviewedSha, findings);
  }
  try { return await send(attempt.pending); }
  catch (error) {
    if (error.status === 409) attempt.requireReload(error.message);
    throw error;
  }
}

export function recoverSubmission(state) {
  const retryStatuses = ['failed', 'pending', 'sending'];
  const batches = state.batches ?? [];
  let batch;
  if (Array.isArray(state.deliveries)) {
    for (const delivery of [...state.deliveries].reverse()) {
      if (!retryStatuses.includes(delivery.status)) continue;
      batch = batches.find(item => item.id === delivery.batchId && item.source === 'page');
      if (batch) break;
    }
  } else if (retryStatuses.includes(state.delivery?.status)) batch = [...batches].reverse().find(item => item.source === 'page');
  return batch?.requestId ? { requestId: batch.requestId, reviewId: state.review.id, reviewedSha: state.review.reviewedSha, findings: (batch.items ?? []).map(item => ({ id: item.id, expectedRevision: item.revision })) } : null;
}

// Submitted work that is not finished yet, and submitted work that is finished.
const IN_PROGRESS = ['queued', 'dispatching', 'running', 'verifying', 'clarify', 'failed'];
const FINISHED = ['completed', 'dropped'];
export const TABS = ['pending', 'decided', 'progress', 'done', 'all'];

// Type filters at the top of the list. None picked shows everything. Picks in
// one group widen the list (OR); the two groups narrow each other (AND).
const SEVERITY = { blocking: 'Blocking', 'non-blocking': 'Non-blocking' };
const LABEL_ORDER = ['issue', 'suggestion', 'question', 'todo', 'nitpick', 'thought', 'chore', 'note', 'typo', 'polish', 'quibble', 'praise'];
const severityKey = finding => finding.blocking ? 'blocking' : 'non-blocking';
const labelKey = finding => `label:${finding.label || 'comment'}`;

export function matchesKinds(finding, kinds) {
  if (!kinds?.size) return true;
  const severity = [...kinds].filter(key => Object.hasOwn(SEVERITY, key));
  const labels = [...kinds].filter(key => key.startsWith('label:'));
  return (!severity.length || severity.includes(severityKey(finding))) && (!labels.length || labels.includes(labelKey(finding)));
}

// The filter buttons for these findings, in a stable order, with counts.
export function kindFilters(findings) {
  const counts = new Map();
  for (const finding of findings) for (const key of [severityKey(finding), labelKey(finding)]) counts.set(key, (counts.get(key) ?? 0) + 1);
  const rank = key => { const i = LABEL_ORDER.indexOf(key.slice(6)); return i === -1 ? LABEL_ORDER.length : i; };
  const severity = Object.keys(SEVERITY).filter(key => counts.has(key)).map(key => ({ key, text: SEVERITY[key], count: counts.get(key) }));
  const labels = [...counts.keys()].filter(key => key.startsWith('label:')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(key => ({ key, text: key.slice(6).charAt(0).toUpperCase() + key.slice(7), count: counts.get(key) }));
  return [...severity, ...labels];
}

export function visibleFindings(findings, { query = '', filter = 'all', showDropped = false, kinds = null } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return findings.filter(finding => {
    if (!matchesKinds(finding, kinds)) return false;
    if (!showDropped && filter !== 'done' && finding.status === 'dropped') return false;
    const locked = finding.locked ?? submitted(finding);
    if (filter === 'pending' && (locked || finding.decision)) return false;
    if (filter === 'decided' && (locked || !finding.decision)) return false;
    if (filter === 'blocking' && !finding.blocking) return false;
    if (filter === 'active' && !['queued', 'dispatching', 'running', 'verifying'].includes(finding.status)) return false;
    if (filter === 'progress' && !IN_PROGRESS.includes(finding.status)) return false;
    if (filter === 'done' && !FINISHED.includes(finding.status)) return false;
    if (!needle) return true;
    return [finding.id, finding.label, finding.title, finding.discussion, finding.evidence, finding.suggestion, finding.context, finding.location?.path, finding.status].some(value => String(value ?? '').toLocaleLowerCase().includes(needle));
  });
}

export function tabCounts(findings, kinds = null) {
  return Object.fromEntries(TABS.map(tab => [tab, visibleFindings(findings, { filter: tab, showDropped: tab === 'all', kinds }).length]));
}

const DRAFT_TAGS = { fix: ['Fix', 'fix'], dont_fix: ['Don’t fix', 'skip'], clarify: ['Clarify', 'ask'] };
const SUBMITTED_TAGS = { queued: ['Queued', 'run'], dispatching: ['Starting', 'run'], running: ['Fixing', 'run'], verifying: ['Checking', 'run'], completed: ['Fixed', 'fix'], failed: ['Failed', 'danger'], clarify: ['In chat', 'ask'], dropped: ['Don’t fix', 'skip'] };

// The short status shown next to a finding in the list and in its header.
export function findingTag(finding) {
  if (finding.saveState === 'conflict') return { text: 'Conflict', tone: 'danger' };
  if (finding.saveState === 'error') return { text: 'Not saved', tone: 'danger' };
  const locked = finding.locked ?? submitted(finding);
  const [text, tone] = (locked ? SUBMITTED_TAGS[finding.status] : DRAFT_TAGS[finding.decision]) ?? (locked ? ['Submitted', 'none'] : ['No choice', 'none']);
  return { text, tone };
}

// Moves the selection inside the visible list. An unlisted selection starts at an end.
export function stepSelection(ids, currentId, delta) {
  if (!ids.length) return null;
  const index = ids.indexOf(currentId);
  if (index === -1) return delta < 0 ? ids.at(-1) : ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
}
