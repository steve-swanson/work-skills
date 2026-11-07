import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const VERSION = '1.2.1';
const SCHEMA_VERSION = 1;
const DECISIONS = new Set(['fix', 'dont_fix', 'clarify']);
const LABELS = new Set(['issue', 'question', 'suggestion', 'nitpick', 'praise', 'todo', 'thought', 'chore', 'note', 'typo', 'polish', 'quibble']);
const TASK_STATUSES = new Set(['dispatching', 'running', 'verifying', 'completed', 'failed']);
const TASK_ROLES = new Set(['review', 'implementation', 'coordinator', 'verification']);
const ACTIVE = new Set(['dispatching', 'running', 'verifying']);
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function fail(code, message, status = 400) { const e = new Error(message); e.code = code; e.status = status; throw e; }
export function text(value, name, max = 100000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || value.includes('\0')) fail('invalid_input', `${name} must be a valid string.`);
  return value;
}
function integer(value, name, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail('invalid_input', `${name} must be an integer >= ${minimum}.`); return value; }
function ident(value, name = 'id') { text(value, name, 160); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)) fail('invalid_input', `${name} contains invalid characters.`); return value; }
function excerptOf(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_input', 'excerpt must be an object.');
  if (Object.keys(raw).some(key => !['startLine', 'code', 'highlight'].includes(key))) fail('invalid_input', 'excerpt accepts only startLine, code, and highlight.');
  const startLine = integer(raw.startLine, 'excerpt.startLine', 1);
  const code = text(raw.code, 'excerpt.code', 4000).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const lines = code.split('\n').length;
  if (!code.trim() || lines > 20) fail('invalid_input', 'excerpt.code must have 1 to 20 lines.');
  const highlight = raw.highlight ?? [];
  if (!Array.isArray(highlight) || new Set(highlight).size !== highlight.length) fail('invalid_input', 'excerpt.highlight must be a list of unique line numbers.');
  for (const line of highlight) if (integer(line, 'excerpt.highlight', 1) < startLine || line >= startLine + lines) fail('invalid_input', 'excerpt.highlight lines must be inside the excerpt.');
  return { startLine, code, highlight: [...highlight].sort((a, b) => a - b) };
}
export function slug(value) { return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 65) || 'review'; }
function git(repo, ...args) { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (error) { if (['EPERM','EACCES','ERR_ACCESS_DENIED'].includes(error.code)) fail('git_process_denied', `Git metadata subprocess was denied (${error.code}). Check process and pipe permissions in this runtime; repository/ref validity was not established.`); fail('git_error', `Cannot resolve Git metadata (${args[0]}). Check the repository and requested refs.`); } }
function canonicalRemote(remote) {
  if (!remote) return 'local';
  try { const url = new URL(remote); return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/, '')}`; } catch { return remote.replace(/^[^@]+@/, '').replace(':', '/').replace(/\.git$/, ''); }
}
export function atomicJson(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, filename);
}
export function ensureStateRoot(home = os.homedir()) {
  const root = path.resolve(home, '.agents', 'state', 'review-work');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) { try { fs.writeFileSync(ignore, '*\n', { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  else if (!fs.readFileSync(ignore, 'utf8').split(/\r?\n/).includes('*')) fs.appendFileSync(ignore, '\n*\n');
  return root;
}
function runtimeFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) fail('invalid_runtime', 'Runtime templates must not contain symlinks.');
    if (entry.isDirectory()) files.push(...runtimeFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
export function bootstrapRuntime(stateRoot, source = path.dirname(fileURLToPath(import.meta.url))) {
  const files = runtimeFiles(source);
  const contents = files.map(name => ({ name, content: fs.readFileSync(path.join(source, name)) }));
  const digest = hash(Buffer.concat(contents.flatMap(x => [Buffer.from(`${x.name}\0`), x.content])));
  const destination = path.join(stateRoot, '_runtime', `${VERSION}-${digest.slice(0, 16)}`);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const { name, content } of contents) {
    const target = path.join(destination, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) { if (!fs.readFileSync(target).equals(content)) fail('runtime_modified', 'A versioned runtime file was modified; preserve it and repair the runtime cache.'); }
    else { try { fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST' || !fs.readFileSync(target).equals(content)) throw e; } }
  }
  return { version: VERSION, digest, directory: destination };
}
export function readManifest(reviewDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(path.resolve(reviewDir), 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== SCHEMA_VERSION || !manifest.id || !manifest.repoId) fail('invalid_review', 'Unsupported or invalid review manifest.');
  return manifest;
}
export function createReview(options) {
  const repo = fs.realpathSync(text(options.repo, 'repo'));
  const checkout = fs.realpathSync(git(repo, 'rev-parse', '--show-toplevel'));
  const common = fs.realpathSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const branch = text(options.branch ?? git(repo, 'symbolic-ref', '--short', 'HEAD'), 'branch', 255);
  const reviewedSha = git(repo, 'rev-parse', '--verify', `${branch}^{commit}`);
  const shortBranch = branch.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
  const scope = options.scope ?? (shortBranch === 'develop' || shortBranch === 'origin/develop' ? 'snapshot' : 'diff');
  if (!['snapshot', 'diff'].includes(scope)) fail('invalid_input', 'scope must be snapshot or diff.');
  if (scope === 'diff' && !options.base) fail('missing_base', 'A feature diff review requires an explicit base ref.');
  const baseRef = options.base ?? null;
  const baseSha = scope === 'diff' ? git(repo, 'merge-base', reviewedSha, text(baseRef, 'base', 255)) : null;
  let remote = ''; try { remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* A local fixture or repository needs no origin. */ }
  const repositoryIdentity = canonicalRemote(remote);
  const repoId = hash(`${repositoryIdentity}\0${common}`).slice(0, 12);
  const project = path.basename(repositoryIdentity === 'local' ? path.dirname(common) : repositoryIdentity);
  const reviewMode = options.reviewMode ?? 'inline';
  if (!['inline', 'fanout'].includes(reviewMode)) fail('invalid_input', 'reviewMode must be inline or fanout.');
  const maxReviewers = integer(options.maxReviewers ?? 4, 'maxReviewers', 1);
  const deliveryMode = options.deliveryMode ?? 'terminal';
  if (!['terminal', 't3'].includes(deliveryMode)) fail('invalid_input', 'deliveryMode must be terminal or t3.');
  const { conversationId, t3Command, t3Launcher } = t3Options(options, deliveryMode);
  const stateRoot = ensureStateRoot(options.home);
  const runtime = bootstrapRuntime(stateRoot, options.runtimeSource);
  const id = crypto.randomUUID();
  const reviewDir = path.join(stateRoot, `${slug(project)}-${repoId}`, `${slug(shortBranch)}-review`, `${now().slice(0, 10)}-${id}`);
  fs.mkdirSync(path.join(reviewDir, 'artifacts'), { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: SCHEMA_VERSION, id, repoId, project, repositoryIdentity, repoPath: checkout, gitCommonDir: common, branch, baseRef, baseSha, reviewedSha, scope, reviewMode, maxReviewers, deliveryMode, conversationId, host: os.hostname(), createdAt: now(), runtime, t3Command, t3Launcher, t3BaseDir: options.t3BaseDir ?? null };
  atomicJson(path.join(reviewDir, 'manifest.json'), manifest);
  const store = new ReviewStore(reviewDir); store.close();
  return { reviewDir, stateRoot, manifest };
}
function t3Options(options, deliveryMode) {
  const conversationId = options.conversationId ?? null;
  if (conversationId !== null) text(conversationId, 'conversationId', 255);
  if (deliveryMode === 't3' && !conversationId) fail('missing_conversation', 'T3 delivery requires the original conversation ID.');
  const t3Command = options.t3Command ?? null;
  if (t3Command !== null && (!Array.isArray(t3Command) || !t3Command.length || t3Command.some(x => typeof x !== 'string' || !x || x.includes('\0')))) fail('invalid_input', 't3Command must be a nonempty argument array.');
  const t3Launcher = options.t3Launcher ?? 'native';
  if (!['native', 'electron'].includes(t3Launcher)) fail('invalid_input', 't3Launcher must be native or electron.');
  return { conversationId, t3Command, t3Launcher };
}

// Remote page relay. A review on one machine can show its page on another
// linked T3 machine. Data moves as framed, digest-checked JSON in T3 messages.
export const RELAY_MAX_CHARS = 100000;
const FRAMES = { page: 'REVIEW-WORK-PAGE', decisions: 'REVIEW-WORK-DECISIONS' };
const relayDigest = body => hash(JSON.stringify(body));
export function frameRelay(kind, body) {
  const marker = FRAMES[kind]; if (!marker) fail('invalid_input', 'Unknown relay kind.');
  return `${marker} v1 BEGIN\n${JSON.stringify({ ...body, digest: relayDigest(body) })}\n${marker} v1 END`;
}
/** Returns the newest framed body in `source` (a string or a list of strings, newest last), or null. */
export function unframeRelay(kind, source) {
  const marker = FRAMES[kind]; if (!marker) fail('invalid_input', 'Unknown relay kind.');
  const texts = (Array.isArray(source) ? source : [source]).filter(x => typeof x === 'string');
  for (let index = texts.length - 1; index >= 0; index--) {
    const value = texts[index]; const begin = `${marker} v1 BEGIN`; const start = value.lastIndexOf(begin);
    if (start < 0) continue;
    const stop = value.indexOf(`${marker} v1 END`, start);
    if (stop < 0) fail('relay_truncated', 'The relayed data has no end marker. Ask the other machine to send it again.');
    let parsed; try { parsed = JSON.parse(value.slice(start + begin.length, stop).trim()); } catch { fail('relay_invalid', 'The relayed data is not valid JSON. Ask the other machine to send it again.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('relay_invalid', 'The relayed data must be an object.');
    const { digest, ...body } = parsed;
    if (digest !== relayDigest(body)) fail('relay_digest', 'The relayed data changed in transit. Ask the other machine to send it again.');
    return body;
  }
  return null;
}
const sha = (value, name) => { if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/.test(value)) fail('invalid_input', `${name} must be a commit SHA.`); return value; };
/** Creates a page-only copy of a review from another machine. It has no repository and never runs fixes. */
export function createMirror(options) {
  const bundle = options.bundle;
  if (!bundle || bundle.kind !== 'review-work-page' || bundle.version !== 1) fail('invalid_input', 'This is not a review-work page bundle.');
  const source = bundle.source ?? {}; const review = bundle.review ?? {};
  const mirror = { sourceReviewId: ident(source.reviewId, 'source.reviewId'), sourceEnvironmentId: ident(source.environmentId, 'source.environmentId'), sourceThreadId: ident(source.threadId, 'source.threadId'), sourceHost: text(source.host, 'source.host', 255), pageHost: os.hostname(), bundleCreatedAt: text(bundle.createdAt, 'createdAt', 64) };
  const project = text(review.project, 'review.project', 255); const branch = text(review.branch, 'review.branch', 255);
  const reviewedSha = sha(review.reviewedSha, 'review.reviewedSha');
  const scope = review.scope; if (!['snapshot', 'diff'].includes(scope)) fail('invalid_input', 'review.scope must be snapshot or diff.');
  if (!Array.isArray(bundle.findings) || !bundle.findings.length || bundle.findings.length > 1000) fail('invalid_input', 'The bundle needs 1 to 1000 findings.');
  const { conversationId, t3Command, t3Launcher } = t3Options(options, 't3');
  const stateRoot = ensureStateRoot(options.home);
  const runtime = bootstrapRuntime(stateRoot, options.runtimeSource);
  const id = crypto.randomUUID(); const repoId = hash(`mirror\0${mirror.sourceReviewId}`).slice(0, 12);
  const reviewDir = path.join(stateRoot, `${slug(project)}-${repoId}`, `${slug(branch)}-page`, `${now().slice(0, 10)}-${id}`);
  fs.mkdirSync(path.join(reviewDir, 'artifacts'), { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: SCHEMA_VERSION, id, repoId, project, repositoryIdentity: text(review.repositoryIdentity ?? 'remote', 'review.repositoryIdentity', 1000), repoPath: null, gitCommonDir: null, branch, baseRef: review.baseRef ?? null, baseSha: null, reviewedSha, scope, reviewMode: 'inline', maxReviewers: 1, deliveryMode: 't3', conversationId, host: mirror.sourceHost, createdAt: now(), runtime, t3Command, t3Launcher, t3BaseDir: options.t3BaseDir ?? null, mirror };
  atomicJson(path.join(reviewDir, 'manifest.json'), manifest);
  const store = new ReviewStore(reviewDir);
  try { store.seedMirror(bundle); } finally { store.close(); }
  return { reviewDir, stateRoot, manifest };
}

export class ReviewStore {
  constructor(reviewDir) {
    this.directory = fs.realpathSync(path.resolve(reviewDir)); this.manifest = readManifest(this.directory);
    this.db = new DatabaseSync(path.join(this.directory, 'review.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, payload TEXT NOT NULL, decision TEXT, context TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, submitted_revision INTEGER, status TEXT NOT NULL DEFAULT 'unreviewed', resolution TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (batch_id TEXT PRIMARY KEY REFERENCES batches(id), status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments (finding_id TEXT NOT NULL REFERENCES findings(id), task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(finding_id,task_id));
      CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('schemaVersion', String(SCHEMA_VERSION));
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('reviewId', this.manifest.id);
    if (this.db.prepare('SELECT value FROM metadata WHERE key=?').get('reviewId').value !== this.manifest.id) fail('invalid_review', 'Database and manifest review IDs do not match.');
    try { fs.chmodSync(path.join(this.directory, 'review.sqlite'), 0o600); } catch { /* Home ACLs govern Windows. */ }
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  event(type, payload) { this.db.prepare('INSERT INTO events(type,payload,created_at) VALUES (?,?,?)').run(type, JSON.stringify(payload), now()); }
  requireOpen() { if (this.db.prepare('SELECT value FROM metadata WHERE key=?').get('closed')?.value === 'true') fail('review_closed', 'This review is closed. Reopen it through the owner CLI.', 409); }
  finding(id) {
    const row = this.db.prepare('SELECT * FROM findings WHERE id=?').get(id);
    if (!row) fail('not_found', `Finding ${id} does not exist.`, 404);
    return { ...JSON.parse(row.payload), decision: row.decision, context: row.context, revision: row.revision, submittedRevision: row.submitted_revision, status: row.status, resolution: row.resolution };
  }
  findingPayload(raw) {
    if (!raw || typeof raw !== 'object') fail('invalid_input', 'Each finding must be an object.');
    const id = ident(raw.id, 'finding id');
    if (!LABELS.has(raw.label) || typeof raw.blocking !== 'boolean') fail('invalid_input', 'Findings require a conventional label and explicit blocking boolean.');
    if (['nitpick', 'note', 'thought', 'praise'].includes(raw.label) && raw.blocking) fail('invalid_input', `${raw.label} must be non-blocking.`);
    const payload = { id, label: raw.label, blocking: raw.blocking, title: text(raw.title, 'title', 1000), discussion: text(raw.discussion ?? '', 'discussion', 100000, true), evidence: text(raw.evidence, 'evidence'), suggestion: text(raw.suggestion ?? '', 'suggestion', 100000, true), location: { path: text(raw.location?.path, 'location.path', 4000), line: integer(raw.location?.line, 'location.line', 1), commit: raw.location?.commit ?? this.manifest.reviewedSha } };
    const excerpt = excerptOf(raw.excerpt); if (excerpt) payload.excerpt = excerpt;
    if (path.isAbsolute(payload.location.path) || payload.location.path.split(/[\\/]/).includes('..')) fail('invalid_input', 'Finding paths must be repository-relative.');
    if (payload.location.commit !== this.manifest.reviewedSha) fail('stale_commit', 'Finding evidence must reference the reviewed commit.');
    return payload;
  }
  addFindings(findings) {
    this.requireSource();
    if (!Array.isArray(findings) || findings.length > 1000) fail('invalid_input', 'findings must be an array of at most 1000 items.');
    return this.transaction(() => {
      this.requireOpen(); const output = [];
      for (const raw of findings) {
        const payload = this.findingPayload(raw); const { id } = payload;
        const existing = this.db.prepare('SELECT payload FROM findings WHERE id=?').get(id);
        if (existing && existing.payload !== JSON.stringify(payload)) fail('finding_conflict', `Finding ${id} already exists with different evidence.`, 409);
        if (!existing) { this.db.prepare('INSERT INTO findings(id,payload) VALUES (?,?)').run(id, JSON.stringify(payload)); this.event('finding_added', { id }); }
        output.push(this.finding(id));
      }
      return output;
    });
  }
  editDraft(id, input) {
    return this.transaction(() => {
      this.requireOpen(); const current = this.finding(id);
      if (Object.keys(input).some(key => !['decision', 'context', 'expectedRevision'].includes(key))) fail('invalid_input', 'Only decision, context and expectedRevision may be edited.');
      if (current.submittedRevision !== null) fail('submitted', 'Submitted decisions are immutable here; discuss changes in the original conversation.', 409);
      if (integer(input.expectedRevision, 'expectedRevision') !== current.revision) fail('revision_conflict', 'This finding has a newer revision. Reload it before saving.', 409);
      if (input.decision !== null && !DECISIONS.has(input.decision)) fail('invalid_input', 'Invalid decision.');
      const context = text(input.context ?? '', 'context', 32000, true);
      this.db.prepare('UPDATE findings SET decision=?,context=?,revision=revision+1 WHERE id=?').run(input.decision, context, id);
      return this.finding(id);
    });
  }
  batch(id) { const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id); if (!row) fail('not_found', 'Batch not found.', 404); return { id: row.id, requestId: row.request_id, source: row.source, createdAt: row.created_at, items: JSON.parse(row.payload) }; }
  commitBatch(items, requestId, source) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO batches(id,request_id,source,payload,created_at) VALUES (?,?,?,?,?)').run(id, requestId, source, JSON.stringify(items), now());
    for (const item of items) {
      const status = item.decision === 'fix' ? 'queued' : item.decision === 'clarify' ? 'clarify' : 'dropped';
      this.db.prepare('UPDATE findings SET submitted_revision=revision,status=? WHERE id=?').run(status, item.id);
    }
    this.db.prepare('INSERT INTO deliveries(batch_id,status,updated_at) VALUES (?,?,?)').run(id, this.manifest.deliveryMode === 't3' && source === 'page' ? 'pending' : 'manual', now());
    this.event('batch_committed', { id, requestId, source, findingIds: items.map(x => x.id) });
    return this.batch(id);
  }
  submit({ requestId, reviewId, reviewedSha, findings }) {
    ident(requestId, 'requestId');
    if (reviewId !== this.manifest.id) fail('wrong_review', 'Submission belongs to another review.', 409);
    if (reviewedSha !== this.manifest.reviewedSha) fail('stale_commit', 'Submission refers to a different reviewed commit.', 409);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM batches WHERE request_id=?').get(requestId);
      if (existing) return this.batch(existing.id);
      this.requireOpen();
      if (!Array.isArray(findings) || findings.length > 1000 || new Set(findings.map(x => x?.id)).size !== findings.length) fail('invalid_input', 'Submission requires a unique finding/revision snapshot.');
      const items = findings.map(({ id, expectedRevision }) => {
        const current = this.finding(ident(id));
        if (current.revision !== integer(expectedRevision, 'expectedRevision') || current.submittedRevision !== null || current.decision === null) fail('submission_conflict', 'A submitted choice changed in another tab. Reload and review the choices before submitting.', 409);
        return { id, decision: current.decision, context: current.context, revision: current.revision };
      });
      if (!items.length) return null;
      return this.commitBatch(items, requestId, 'page');
    });
  }
  resolve(id, { decision, context, resolution, requestId }) {
    this.requireSource(); ident(requestId, 'requestId');
    if (!DECISIONS.has(decision)) fail('invalid_input', 'Invalid resolution decision.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM batches WHERE request_id=?').get(requestId);
      if (existing) return this.batch(existing.id);
      this.requireOpen(); const current = this.finding(id);
      if (!['clarify', 'dropped', 'failed', 'unreviewed', 'queued'].includes(current.status)) fail('work_started', 'Active or completed fixes require an explicit change-of-scope task; do not discard their commits.', 409);
      const note = text(resolution, 'resolution'); const nextContext = text(context ?? current.context, 'context', 32000, true);
      this.db.prepare('UPDATE findings SET decision=?,context=?,resolution=?,revision=revision+1 WHERE id=?').run(decision, nextContext, note, id);
      const item = this.finding(id);
      return this.commitBatch([{ id, decision, context: nextContext, revision: item.revision, resolution: note }], requestId, 'chat');
    });
  }
  reserveTask(input) {
    this.requireSource(); const id = ident(input.id, 'task id');
    if (!TASK_ROLES.has(input.role)) fail('invalid_input', 'Unknown task role.');
    if (!Array.isArray(input.findingIds) || new Set(input.findingIds).size !== input.findingIds.length) fail('invalid_input', 'findingIds must contain unique IDs.');
    if (input.role !== 'implementation' && input.findingIds.length) fail('invalid_input', 'Only implementation tasks may own findings; use referenceFindingIds for other roles.');
    const task = { ...input, id, model: text(input.model, 'model', 200), effort: text(input.effort, 'effort', 100), provider: text(input.provider, 'provider', 100), startSha: text(input.startSha, 'startSha', 100), clientRequestId: `review-${this.manifest.id}-${id}` };
    const fingerprint = hash(JSON.stringify(task));
    return this.transaction(() => {
      this.requireOpen(); const old = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (old) { if (old.fingerprint !== fingerprint) fail('task_conflict', 'Task ID already has a different assignment.', 409); return { ...JSON.parse(old.payload), status: old.status }; }
      const activeCount = this.db.prepare("SELECT payload FROM tasks WHERE status IN ('dispatching','running','verifying')").all().filter(row => JSON.parse(row.payload).role !== 'coordinator').length;
      if (input.role !== 'coordinator' && activeCount >= this.manifest.maxReviewers) fail('capacity', 'The configured concurrent agent capacity is full.', 409);
      if (input.role === 'implementation' && !input.findingIds.length) fail('invalid_input', 'Implementation tasks must reference approved findings.');
      for (const findingId of input.findingIds) {
        const item = this.finding(findingId);
        const owners = this.db.prepare("SELECT tasks.status FROM assignments JOIN tasks ON tasks.id=assignments.task_id WHERE finding_id=?").all(findingId);
        if (owners.some(x => x.status !== 'failed')) fail('already_assigned', `Finding ${findingId} is already assigned.`, 409);
        if (item.decision !== 'fix' || !['queued', 'failed'].includes(item.status)) fail('not_approved', 'Every implementation finding must be approved and queued or failed.', 409);
      }
      this.db.prepare('INSERT INTO tasks(id,fingerprint,payload,status,created_at) VALUES (?,?,?,?,?)').run(id, fingerprint, JSON.stringify(task), 'dispatching', now());
      for (const findingId of input.findingIds) {
        this.db.prepare('INSERT INTO assignments(finding_id,task_id) VALUES (?,?)').run(findingId, id);
        this.db.prepare('UPDATE findings SET status=? WHERE id=?').run('dispatching', findingId);
      }
      this.event('task_reserved', { id, clientRequestId: task.clientRequestId, findingIds: task.findingIds });
      return { ...task, status: 'dispatching' };
    });
  }
  updateTask(id, update) {
    this.requireSource();
    if (!TASK_STATUSES.has(update.status)) fail('invalid_input', 'Invalid task status.');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); if (!row) fail('not_found', 'Task not found.', 404);
      const old = JSON.parse(row.payload);
      if (['completed', 'failed'].includes(row.status) && update.status !== row.status) fail('terminal_task', 'A terminal task cannot be restarted; reserve a new retry task.', 409);
      if (['completed', 'failed'].includes(row.status)) {
        if (Object.entries(update).some(([key, value]) => JSON.stringify(old[key]) !== JSON.stringify(value))) fail('terminal_task', 'Terminal task results are immutable.', 409);
        return { ...old, status: row.status };
      }
      if (update.status === 'completed' && old.role === 'implementation' && (!update.commit || !Array.isArray(update.checks) || !update.checks.length || update.checks.some(x => x.status !== 'passed'))) fail('unverified', 'Completed implementation tasks require an integrated commit and passing checks.');
      const allowed = ['status', 'externalId', 'commit', 'checks', 'error', 'branch', 'worktreePath', 'summary'];
      if (Object.keys(update).some(key => !allowed.includes(key))) fail('invalid_input', 'Task identity, route and finding ownership cannot be changed.');
      const payload = { ...old, ...update, updatedAt: now() };
      this.db.prepare('UPDATE tasks SET payload=?,status=? WHERE id=?').run(JSON.stringify(payload), update.status, id);
      for (const findingId of old.findingIds) this.db.prepare('UPDATE findings SET status=? WHERE id=?').run(update.status, findingId);
      this.event('task_updated', { id, status: update.status });
      return payload;
    });
  }
  record(kind, payload) {
    if (!['coverage', 'routing', 'verification', 'worktree', 'coordinator', 'pull_request', 'inline_override', 'note'].includes(kind)) fail('invalid_input', 'Unknown record kind.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid_input', 'Record must be an object.');
    if (kind === 'coverage' && !['checked', 'skipped', 'incomplete'].includes(payload.status)) fail('invalid_input', 'Coverage requires checked/skipped/incomplete status.');
    if (kind === 'coordinator' && (typeof payload.branch !== 'string' || /integration/i.test(payload.branch))) fail('invalid_input', 'Use a meaningful coordinator branch name without integration.');
    if (kind === 'verification' && payload.scope === 'combined') payload = { ...payload, taskCommits: this.implementationCommits(), coordinatorRecordId: this.coordinatorRecordId() };
    this.db.prepare('INSERT INTO records(kind,payload,created_at) VALUES (?,?,?)').run(kind, JSON.stringify(payload), now());
    return payload;
  }
  claimDelivery(batchId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM deliveries WHERE batch_id=?').get(batchId); if (!row) fail('not_found', 'Delivery not found.', 404);
      if (['sent', 'manual'].includes(row.status)) return false;
      if (row.status === 'sending' && Date.now() - Date.parse(row.updated_at) < 30000) return false;
      this.db.prepare('UPDATE deliveries SET status=?,attempts=attempts+1,error=NULL,updated_at=? WHERE batch_id=?').run('sending', now(), batchId);
      return true;
    });
  }
  finishDelivery(batchId, status, error = null) { this.db.prepare('UPDATE deliveries SET status=?,error=?,updated_at=? WHERE batch_id=?').run(status, error, now(), batchId); }
  requireSource() { if (this.manifest.mirror) fail('page_copy', 'This is a page-only copy of a review on another machine. Do this in the review chat there.', 409); }
  requireMirror() { if (!this.manifest.mirror) fail('not_page_copy', 'This command needs the page-only copy of a review.', 409); }
  seedMirror(bundle) {
    this.requireMirror();
    return this.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM findings').get().n) fail('already_seeded', 'This page copy already has findings.', 409);
      const sourceRevisions = {};
      const raw = bundle.findings.map(item => { if (!item || typeof item !== 'object') fail('invalid_input', 'Each finding must be an object.'); sourceRevisions[ident(item.id, 'finding id')] = integer(item.sourceRevision, 'sourceRevision'); const { sourceRevision, decision, context, ...finding } = item; return finding; });
      for (const finding of raw) {
        const payload = this.findingPayload(finding);
        if (this.db.prepare('SELECT 1 FROM findings WHERE id=?').get(payload.id)) fail('invalid_input', 'Finding IDs must be unique.');
        this.db.prepare('INSERT INTO findings(id,payload) VALUES (?,?)').run(payload.id, JSON.stringify(payload));
      }
      for (const item of bundle.findings) {
        if (item.decision === null || item.decision === undefined) continue;
        if (!DECISIONS.has(item.decision)) fail('invalid_input', 'Invalid draft decision in bundle.');
        this.db.prepare('UPDATE findings SET decision=?,context=?,revision=1 WHERE id=?').run(item.decision, text(item.context ?? '', 'context', 32000, true), item.id);
      }
      for (const record of Array.isArray(bundle.coverage) ? bundle.coverage.slice(0, 500) : []) { const { recordedAt, ...payload } = record ?? {}; if (['checked', 'skipped', 'incomplete'].includes(payload.status)) this.record('coverage', payload); }
      this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('sourceRevisions', JSON.stringify(sourceRevisions));
      this.event('mirror_seeded', { sourceReviewId: this.manifest.mirror.sourceReviewId, findingIds: raw.map(x => x.id) });
    });
  }
  /** Source side: the open (not yet submitted) findings, ready to show on another machine. */
  pageBundle({ environmentId }) {
    this.requireSource(); this.requireOpen();
    if (this.manifest.deliveryMode !== 't3' || !this.manifest.conversationId) fail('needs_t3', 'A remote page needs a T3 review chat (deliveryMode t3).', 409);
    const state = this.state();
    const findings = state.findings.filter(f => f.submittedRevision === null).map(({ id, label, blocking, title, discussion, evidence, suggestion, location, excerpt, revision, decision, context }) => ({ id, label, blocking, title, discussion, evidence, suggestion, location, ...(excerpt ? { excerpt } : {}), sourceRevision: revision, decision, context }));
    if (!findings.length) fail('nothing_to_decide', 'Every finding already has a submitted choice.', 409);
    const m = this.manifest;
    return { kind: 'review-work-page', version: 1, source: { reviewId: m.id, environmentId: ident(environmentId, 'environmentId'), threadId: m.conversationId, host: m.host }, review: { project: m.project, repositoryIdentity: m.repositoryIdentity, branch: m.branch, baseRef: m.baseRef, reviewedSha: m.reviewedSha, scope: m.scope }, coverage: state.coverage, findings, createdAt: now() };
  }
  /** Page side: one submitted batch, ready to send back to the review chat. */
  relayExport(batchId) {
    this.requireMirror();
    const batch = this.batch(batchId); const revisions = JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('sourceRevisions')?.value ?? '{}');
    const m = this.manifest.mirror;
    return { kind: 'review-work-decisions', version: 1, sourceReviewId: m.sourceReviewId, pageReviewId: this.manifest.id, pageHost: m.pageHost, batchId: batch.id, items: batch.items.map(({ id, decision, context }) => ({ id, decision, context, sourceRevision: revisions[id] })), createdAt: now() };
  }
  /** Source side: apply decisions made on another machine's page. Safe to repeat. */
  relayImport(body) {
    this.requireSource();
    if (!body || body.kind !== 'review-work-decisions' || body.version !== 1) fail('invalid_input', 'This is not a review-work decisions message.');
    if (body.sourceReviewId !== this.manifest.id) fail('wrong_review', 'These decisions belong to another review.', 409);
    const requestId = `relay-${ident(body.batchId, 'batchId')}`;
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000 || new Set(body.items.map(x => x?.id)).size !== body.items.length) fail('invalid_input', 'Decisions need unique finding IDs.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM batches WHERE request_id=?').get(requestId);
      if (existing) return { batch: this.batch(existing.id), conflicts: [], repeated: true, pageHost: body.pageHost ?? null };
      this.requireOpen(); const applied = []; const conflicts = [];
      for (const item of body.items) {
        const id = ident(item.id, 'finding id');
        if (!DECISIONS.has(item.decision)) fail('invalid_input', 'Invalid decision.');
        const context = text(item.context ?? '', 'context', 32000, true); const sourceRevision = integer(item.sourceRevision, 'sourceRevision');
        const row = this.db.prepare('SELECT revision,submitted_revision FROM findings WHERE id=?').get(id);
        if (!row) { conflicts.push({ id, reason: 'unknown finding' }); continue; }
        if (row.submitted_revision !== null) { conflicts.push({ id, reason: 'already decided here' }); continue; }
        if (row.revision !== sourceRevision) { conflicts.push({ id, reason: 'changed here after the page was sent' }); continue; }
        this.db.prepare('UPDATE findings SET decision=?,context=?,revision=revision+1 WHERE id=?').run(item.decision, context, id);
        applied.push({ id, decision: item.decision, context, revision: row.revision + 1 });
      }
      const batch = applied.length ? this.commitBatch(applied, requestId, 'relay') : null;
      this.event('relay_imported', { batchId: body.batchId, applied: applied.map(x => x.id), conflicts });
      return { batch, conflicts, repeated: false, pageHost: body.pageHost ?? null };
    });
  }
  implementationCommits() { return this.db.prepare('SELECT id,payload,status FROM tasks ORDER BY id').all().filter(x => JSON.parse(x.payload).role === 'implementation' && x.status === 'completed').map(x => ({ id: x.id, commit: JSON.parse(x.payload).commit })); }
  coordinatorRecordId() { return this.db.prepare("SELECT seq FROM records WHERE kind='coordinator' ORDER BY seq DESC LIMIT 1").get()?.seq ?? null; }
  state() {
    const records = this.db.prepare('SELECT kind,payload,created_at FROM records ORDER BY seq').all();
    const ofKind = kind => records.filter(x => x.kind === kind).map(x => ({ ...JSON.parse(x.payload), recordedAt: x.created_at }));
    const rows = this.db.prepare('SELECT id FROM findings ORDER BY id').all();
    const batches = this.db.prepare('SELECT id FROM batches ORDER BY rowid').all().map(x => this.batch(x.id));
    const deliveries = this.db.prepare('SELECT * FROM deliveries ORDER BY rowid').all();
    const latest = deliveries.at(-1);
    const { t3Command, t3BaseDir, runtime, gitCommonDir, ...publicManifest } = this.manifest;
    return { review: { ...publicManifest, closed: this.db.prepare('SELECT value FROM metadata WHERE key=?').get('closed')?.value === 'true' }, findings: rows.map(x => this.finding(x.id)), coverage: ofKind('coverage'), routing: ofKind('routing'), verification: ofKind('verification'), worktrees: ofKind('worktree'), coordinator: ofKind('coordinator').at(-1) ?? null, pullRequest: ofKind('pull_request').at(-1) ?? null, tasks: this.db.prepare('SELECT payload,status FROM tasks ORDER BY rowid').all().map(x => ({ ...JSON.parse(x.payload), status: x.status })), batches, delivery: { mode: this.manifest.deliveryMode, status: latest?.status ?? (this.manifest.deliveryMode === 'terminal' ? 'manual' : 'idle'), error: latest?.error ?? null }, deliveries: deliveries.map(x => ({ batchId: x.batch_id, status: x.status, attempts: x.attempts, error: x.error })) };
  }
  readiness() {
    const state = this.state(); const blockers = [];
    const latestCoverage = new Map(state.coverage.map(x => [JSON.stringify(x.scope ?? x.id ?? x.paths), x]));
    if (!latestCoverage.size || [...latestCoverage.values()].some(x => x.status === 'incomplete')) blockers.push('Review coverage is missing or incomplete.');
    if (state.findings.some(x => x.submittedRevision === null || x.status === 'clarify')) blockers.push('Findings still need decisions or clarification.');
    if (state.findings.some(x => x.decision === 'fix' && x.status !== 'completed')) blockers.push('Approved fixes are not all verified and integrated.');
    if (state.tasks.some(x => ACTIVE.has(x.status))) blockers.push('Tasks are still active.');
    const hasFixes = state.findings.some(x => x.decision === 'fix');
    const combined = state.verification.filter(x => x.scope === 'combined').at(-1);
    if (hasFixes && (combined?.status !== 'passed' || JSON.stringify(combined.taskCommits) !== JSON.stringify(this.implementationCommits()) || combined.coordinatorRecordId !== this.coordinatorRecordId())) blockers.push('Combined verification has not passed for the current fixes.');
    return { ready: blockers.length === 0, needsPr: hasFixes, blockers };
  }
  setClosed(closed) {
    if (typeof closed !== 'boolean') fail('invalid_input', 'closed must be boolean.');
    if (closed && !this.readiness().ready) fail('not_ready', this.readiness().blockers.join(' '), 409);
    this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run('closed', String(closed));
    this.event(closed ? 'closed' : 'reopened', {});
  }
}

export function listReviews({ home = os.homedir(), conversationId } = {}) {
  const root = path.resolve(home, '.agents', 'state', 'review-work'); if (!fs.existsSync(root)) return [];
  const result = [];
  function walk(directory, depth) {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('_')) walk(path.join(directory, entry.name), depth + 1);
      if (entry.isFile() && entry.name === 'manifest.json') {
        try { const m = readManifest(directory); if (!conversationId || m.conversationId === conversationId) result.push({ id: m.id, project: m.project, branch: m.branch, createdAt: m.createdAt, conversationId: m.conversationId, host: m.host, reviewDir: directory }); } catch { /* Incomplete unrelated directories are not resumable reviews. */ }
      }
    }
  }
  walk(root, 0); return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
