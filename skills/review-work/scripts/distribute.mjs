#!/usr/bin/env node
/** Portable skill-suite packaging. Node 24+, built-ins only; no network access. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat, stat, realpath, readdir, readFile, writeFile, mkdir,
  rename, rm, open,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';

export const SKILLS = Object.freeze(['plan-work', 'execute-work', 'review-work', 'review-loop', 'watch-pr', 'model-routing']);
const FORMAT = 'review-work-skill-bundle';
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 20000;
const execFileAsync = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const errorText = error => error instanceof Error ? error.message : String(error);

function excluded(name) {
  const lower = name.toLowerCase();
  return new Set([
    'node_modules', '.git', '.svn', '.hg', '.cache', 'cache', 'caches', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.coverage', 'coverage', '.ds_store',
    '.env', '.npmrc', '.pypirc', 'secrets', '.secrets', 'credentials', '.credentials',
    'state', '.state', '_install-backups', 'tmp', 'temp', '.tmp', '.temp',
  ]).has(lower)
    || lower.startsWith('.env.')
    || /(?:^|[._-])(?:secret|secrets|credentials)(?:[._-]|$)/.test(lower)
    || /\.(?:db|sqlite|sqlite3)(?:[-.].*)?$/.test(lower)
    || /\.(?:pem|key|p12|pfx|pyc|pyo|log)$/.test(lower);
}

function portablePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000 || value.normalize('NFC') !== value) {
    throw new Error('Invalid portable file path in bundle.');
  }
  const parts = value.split('/');
  if (!SKILLS.includes(parts[0]) || parts.length < 2) throw new Error(`Invalid skill path: ${value}`);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"\\|?*]/.test(part) || /[. ]$/.test(part)) {
      throw new Error(`Unsafe portable path: ${value}`);
    }
    if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error(`Reserved Windows path: ${value}`);
    }
    if (excluded(part)) throw new Error(`Excluded runtime or private path in bundle: ${value}`);
  }
  return parts;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`Invalid ${label} shape.`);
  }
}

/** Validate every payload before any target mutation. Returns decoded files. */
export function validateBundle(bundle) {
  exactKeys(bundle, ['format', 'version', 'manifest', 'manifestDigest', 'contents'], 'bundle');
  if (bundle.format !== FORMAT || bundle.version !== 3) throw new Error('Unsupported bundle format or version; rebuild the six-skill bundle with its matching installer.');
  exactKeys(bundle.manifest, ['algorithm', 'skills', 'files'], 'manifest');
  const manifest = bundle.manifest;
  if (manifest.algorithm !== 'sha256' || JSON.stringify(manifest.skills) !== JSON.stringify(SKILLS)) {
    throw new Error('Manifest must describe the complete approved six-skill suite using SHA-256.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < SKILLS.length || manifest.files.length > MAX_FILES) {
    throw new Error('Invalid manifest file count.');
  }
  if (!bundle.contents || typeof bundle.contents !== 'object' || Array.isArray(bundle.contents)) {
    throw new Error('Invalid bundle contents.');
  }
  const files = [];
  const fileNames = new Set();
  const pathsByFoldedName = new Map();
  let total = 0;
  let previous = '';
  for (const item of manifest.files) {
    exactKeys(item, ['path', 'size', 'sha256'], 'file entry');
    const parts = portablePath(item.path);
    if (previous && compare(previous, item.path) >= 0) throw new Error('Manifest paths must be sorted without duplicates.');
    previous = item.path;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const folded = prefix.toLowerCase();
      const prior = pathsByFoldedName.get(folded);
      if (prior && prior !== prefix) throw new Error(`Portable path case collision: ${prefix}`);
      if (i < parts.length && fileNames.has(prefix)) throw new Error(`File and directory path collision: ${prefix}`);
      pathsByFoldedName.set(folded, prefix);
    }
    fileNames.add(item.path);
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error(`Invalid size or hash for ${item.path}`);
    }
    total += item.size;
    if (total > MAX_BYTES) throw new Error('Bundle exceeds the 128 MiB decoded size limit.');
    const encoded = Object.hasOwn(bundle.contents, item.path) ? bundle.contents[item.path] : undefined;
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Missing or invalid base64 contents for ${item.path}`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length !== item.size || sha256(bytes) !== item.sha256) {
      throw new Error(`File size or SHA-256 hash mismatch: ${item.path}`);
    }
    files.push({ ...item, bytes });
  }
  if (Object.keys(bundle.contents).length !== files.length || Object.keys(bundle.contents).some(p => !fileNames.has(p))) {
    throw new Error('Bundle contains undeclared file contents.');
  }
  for (const skill of SKILLS) {
    if (!fileNames.has(`${skill}/SKILL.md`)) throw new Error(`Missing required file: ${skill}/SKILL.md`);
  }
  // Canonical property ordering makes the digest independent of JSON whitespace or key order.
  const canonical = {
    algorithm: 'sha256', skills: [...SKILLS],
    files: manifest.files.map(({ path: p, size, sha256: hash }) => ({ path: p, size, sha256: hash })),
  };
  if (typeof bundle.manifestDigest !== 'string' || sha256(JSON.stringify(canonical)) !== bundle.manifestDigest) {
    throw new Error('Manifest digest mismatch.');
  }
  return files;
}

async function maybeLstat(file) {
  try { return await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function requiredAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path.`);
  return path.resolve(value);
}

/** Refuse source symlinks, including internal ones: payloads contain regular files only. */
export async function buildBundle({ skillsRoot }) {
  const root = requiredAbsolute(skillsRoot, 'skillsRoot');
  const entries = [];
  const contents = Object.create(null);
  let total = 0;
  for (const skill of SKILLS) {
    const skillRoot = path.join(root, skill);
    const rootInfo = await lstat(skillRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Skill root must be a real directory, not a symlink: ${skillRoot}`);
    const canonicalRoot = await realpath(skillRoot);
    async function visit(directory, relative) {
      const names = (await readdir(directory)).sort(compare);
      for (const name of names) {
        if (excluded(name)) continue;
        const source = path.join(directory, name);
        const bundledPath = `${relative}/${name}`;
        portablePath(bundledPath);
        const info = await lstat(source);
        if (info.isSymbolicLink()) throw new Error(`Source symbolic link is not allowed: ${source}`);
        if (!inside(canonicalRoot, await realpath(source))) throw new Error(`Source path escapes skill root: ${source}`);
        if (info.isDirectory()) await visit(source, bundledPath);
        else if (info.isFile()) {
          if (info.size > MAX_BYTES) throw new Error(`Source file exceeds bundle size limit: ${source}`);
          const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let bytes;
          try {
            if (!(await handle.stat()).isFile()) throw new Error(`Source is not a regular file: ${source}`);
            bytes = await handle.readFile();
          } finally { await handle.close(); }
          total += bytes.length;
          if (total > MAX_BYTES || entries.length >= MAX_FILES) throw new Error('Source suite exceeds bundle size or file-count limit.');
          entries.push({ path: bundledPath, size: bytes.length, sha256: sha256(bytes) });
          contents[bundledPath] = bytes.toString('base64');
        } else throw new Error(`Unsupported source file type: ${source}`);
      }
    }
    await visit(skillRoot, skill);
  }
  entries.sort((a, b) => compare(a.path, b.path));
  const manifest = { algorithm: 'sha256', skills: [...SKILLS], files: entries };
  const bundle = {
    format: FORMAT, version: 3, manifest, manifestDigest: sha256(JSON.stringify(manifest)),
    contents: Object.fromEntries(entries.map(entry => [entry.path, contents[entry.path]])),
  };
  validateBundle(bundle);
  return bundle;
}

async function resolvedDestination(destination) {
  const parts = [];
  let cursor = destination;
  while (!(await maybeLstat(cursor))) {
    parts.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...parts);
}

export async function writeBundle({ skillsRoot, output, compress = false }) {
  const root = requiredAbsolute(skillsRoot, 'skillsRoot');
  const destination = requiredAbsolute(output, 'output');
  const actualDestination = await resolvedDestination(destination);
  for (const skill of SKILLS) {
    const skillRoot = path.join(root, skill);
    if (inside(skillRoot, destination) || inside(await realpath(skillRoot), actualDestination)) {
      throw new Error(`Bundle output must not be inside a source skill: ${destination}`);
    }
  }
  const bundle = await buildBundle({ skillsRoot: root });
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  const zipped = compress || destination.toLowerCase().endsWith('.gz');
  await mkdir(path.dirname(destination), { recursive: true });
  // Exclusive creation prevents following an existing destination symlink or overwriting a bundle.
  await writeFile(destination, zipped ? gzipSync(bytes, { level: 9 }) : bytes, { flag: 'wx', mode: 0o600 });
  return {
    status: 'bundled', output: destination, compressed: zipped,
    manifestDigest: bundle.manifestDigest, fileCount: bundle.manifest.files.length,
    installerSha256: bundle.manifest.files.find(entry => entry.path === 'review-work/scripts/distribute.mjs')?.sha256 ?? null,
  };
}

export async function readBundle(filename) {
  const location = requiredAbsolute(filename, 'bundle');
  const info = await stat(location);
  if (!info.isFile() || info.size > MAX_BYTES * 2) throw new Error('Bundle must be a regular file of at most 256 MiB.');
  let bytes = await readFile(location);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes, { maxOutputLength: MAX_BYTES * 2 });
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Bundle is not valid JSON: ${location}`); }
  validateBundle(bundle);
  return bundle;
}

/** Refuse symlinked/non-directory ancestors to avoid writing through unrelated targets. */
async function checkAncestors(directory) {
  const parsed = path.parse(directory);
  let cursor = parsed.root;
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const info = await maybeLstat(cursor);
    if (info?.isSymbolicLink()) throw new Error(`Install ancestor is a symbolic link: ${cursor}`);
    if (info && !info.isDirectory()) throw new Error(`Install ancestor is not a directory: ${cursor}`);
  }
}

async function locations(home) {
  const requestedHome = requiredAbsolute(home, 'home');
  // A home reached via /tmp or a platform alias is fine; all managed descendants must be real directories.
  const homeInfo = await lstat(requestedHome);
  if (!homeInfo.isDirectory() && !homeInfo.isSymbolicLink()) throw new Error(`Home is not a directory: ${requestedHome}`);
  const actualHome = await realpath(requestedHome);
  const roots = {
    home: actualHome,
    canonical: path.join(actualHome, '.agents', 'skills'),
    claude: path.join(actualHome, '.claude', 'skills'),
    state: path.join(actualHome, '.agents', 'state', 'review-work'),
  };
  // Only <home>/.agents/skills is written. <home>/.claude/skills is read, never changed.
  await checkAncestors(roots.canonical);
  return roots;
}

async function directoryIssues(directory, expected) {
  const info = await maybeLstat(directory);
  if (!info) return [{ path: directory, reason: 'Missing skill directory.' }];
  if (info.isSymbolicLink() || !info.isDirectory()) return [{ path: directory, reason: 'Canonical skill must be a real directory, not a symlink or file.' }];
  const expectedByPath = new Map(expected.map(file => [file.path.split('/').slice(1).join('/'), file]));
  const seen = new Set();
  const issues = [];
  async function visit(current, prefix = '') {
    for (const name of (await readdir(current)).sort(compare)) {
      // Local caches/metadata/private state are outside the bundle contract and remain untouched.
      if (excluded(name)) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(current, name);
      const entry = await lstat(absolute);
      if (entry.isDirectory()) {
        if (![...expectedByPath.keys()].some(p => p.startsWith(`${relative}/`))) issues.push({ path: absolute, reason: 'Unexpected extra directory.' });
        else await visit(absolute, relative);
      } else if (entry.isFile()) {
        const wanted = expectedByPath.get(relative);
        seen.add(relative);
        if (!wanted) issues.push({ path: absolute, reason: 'Unexpected extra file.' });
        else if (entry.size !== wanted.size || sha256(await readFile(absolute)) !== wanted.sha256) issues.push({ path: absolute, reason: 'File size or SHA-256 hash differs.' });
      } else issues.push({ path: absolute, reason: 'Unexpected symlink or unsupported file type.' });
    }
  }
  await visit(directory);
  for (const relative of expectedByPath.keys()) if (!seen.has(relative)) issues.push({ path: path.join(directory, relative), reason: 'Missing expected file.' });
  return issues;
}

async function windowsLinkType(link) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; (Get-Item -LiteralPath $env:REVIEW_WORK_LINK_PATH -Force).LinkType',
    ], { env: { ...process.env, REVIEW_WORK_LINK_PATH: link }, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    return stdout.trim();
  } catch {
    throw new Error(`Cannot verify Windows link type with PowerShell. Ensure powershell.exe is available, then retry: ${link}`);
  }
}

async function windowsTrueLink(link, platform, inspectWindowsLink) {
  if (platform !== 'win32') return true;
  try { return await inspectWindowsLink(link) === 'SymbolicLink'; } catch { return false; }
}

/**
 * Reports how Claude Code sees <home>/.agents/skills. It only reads; it never creates, changes,
 * or removes a link. "shared-folder-link": <home>/.claude/skills is one true directory symlink to
 * <home>/.agents/skills. "per-skill-links": each suite skill has its own true link. "none": neither.
 */
export async function claudeLayout(roots, platform = process.platform, inspectWindowsLink = windowsLinkType) {
  try {
    const info = await maybeLstat(roots.claude);
    if (!info) return 'none';
    if (info.isSymbolicLink()) {
      const same = await realpath(roots.claude).then(async r => r === await realpath(roots.canonical), () => false);
      return same && await windowsTrueLink(roots.claude, platform, inspectWindowsLink) ? 'shared-folder-link' : 'none';
    }
    if (!info.isDirectory()) return 'none';
    for (const skill of SKILLS) {
      const link = path.join(roots.claude, skill);
      const entry = await maybeLstat(link);
      if (!entry?.isSymbolicLink()) return 'none';
      const same = await realpath(link).then(async r => r === await realpath(path.join(roots.canonical, skill)), () => false);
      if (!same || !await windowsTrueLink(link, platform, inspectWindowsLink)) return 'none';
    }
    return 'per-skill-links';
  } catch { return 'none'; }
}

function layoutNotice(layout) {
  return layout === 'none'
    ? 'Claude Code cannot see these skills yet. Make <home>/.claude/skills a directory symlink to <home>/.agents/skills. The helper never changes .claude.'
    : null;
}

async function inspect(files, roots) {
  const plans = [];
  const conflicts = [];
  for (const skill of SKILLS) {
    const target = path.join(roots.canonical, skill);
    const expected = files.filter(file => file.path.startsWith(`${skill}/`));
    const existing = await maybeLstat(target);
    const issues = await directoryIssues(target, expected);
    if (existing && issues.length) conflicts.push({ path: target, reason: issues.map(issue => issue.reason).join(' ') });
    plans.push({ skill, target, expected, replaceTarget: issues.length > 0, targetExists: !!existing });
  }
  return { plans, conflicts };
}

async function ensureIgnoreGuard(state) {
  await checkAncestors(state);
  const guard = path.join(state, '.gitignore');
  const existing = await maybeLstat(guard);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`State ignore guard is not a regular file: ${guard}`);
  await mkdir(state, { recursive: true });
  const content = existing ? await readFile(guard, 'utf8') : '';
  const required = '*\n!.gitignore\n';
  if (!content.endsWith(required)) {
    await writeFile(guard, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${required}`, { mode: 0o600 });
  }
}

/** Transactional installation; backups preserve original entries by rename, never by following links. */
export async function installBundle({ bundle, home, backupConflicts = false, platform = process.platform, inspectWindowsLink = windowsLinkType, onReplaced = null }) {
  const files = validateBundle(bundle);
  const roots = await locations(home);
  const { plans, conflicts } = await inspect(files, roots);
  const layout = await claudeLayout(roots, platform, inspectWindowsLink);
  const summary = { manifestDigest: bundle.manifestDigest, fileCount: files.length, home: roots.home, claudeLayout: layout, notice: layoutNotice(layout) };
  if (conflicts.length && !backupConflicts) return { status: 'conflicts', ...summary, conflicts };
  if (plans.every(plan => !plan.replaceTarget)) return { status: 'unchanged', ...summary, backupPath: null };

  let backupPath = null;
  let stage = null;
  const undo = [];
  try {
    if (conflicts.length) {
      await ensureIgnoreGuard(roots.state);
      const backupRoot = path.join(roots.state, '_install-backups');
      await checkAncestors(backupRoot);
      await mkdir(backupRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      backupPath = path.join(backupRoot, `${stamp}-${randomUUID().slice(0, 8)}`);
      await mkdir(backupPath, { mode: 0o700 });
      await mkdir(path.join(backupPath, 'canonical'));
    }
    await mkdir(roots.canonical, { recursive: true });
    stage = path.join(roots.canonical, `.review-work-install-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    for (const plan of plans.filter(plan => plan.replaceTarget)) {
      for (const file of plan.expected) {
        const destination = path.join(stage, ...file.path.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o644 });
      }
    }
    for (const plan of plans) {
      if (plan.replaceTarget) {
        if (plan.targetExists) {
          const saved = path.join(backupPath, 'canonical', plan.skill);
          await rename(plan.target, saved);
          undo.push(() => rename(saved, plan.target));
        }
        await rename(path.join(stage, plan.skill), plan.target);
        undo.push(() => rm(plan.target, { recursive: true, force: true }));
        if (onReplaced) await onReplaced(plan.skill); // test hook for rollback
      }
    }
    const verification = await verifyBundle({ bundle, home: roots.home, platform, inspectWindowsLink });
    if (verification.status !== 'verified') throw new Error(`Post-install verification failed: ${JSON.stringify(verification.issues)}`);
    await rm(stage, { recursive: true, force: true });
    stage = null;
    return { status: 'installed', ...summary, claudeLayout: verification.claudeLayout, notice: verification.notice, backupPath, changedSkills: plans.filter(plan => plan.replaceTarget).map(plan => plan.skill) };
  } catch (error) {
    const failures = [];
    for (const operation of undo.reverse()) {
      try { await operation(); } catch (rollbackError) { failures.push(errorText(rollbackError)); }
    }
    if (stage) {
      try { await rm(stage, { recursive: true, force: true }); } catch (cleanupError) { failures.push(errorText(cleanupError)); }
    }
    if (backupPath && failures.length === 0) {
      try { await rm(backupPath, { recursive: true, force: true }); } catch (cleanupError) { failures.push(errorText(cleanupError)); }
    }
    if (failures.length) throw new Error(`${errorText(error)} Rollback needs attention; preserved backups: ${backupPath ?? 'none'}. ${failures.join('; ')}`, { cause: error });
    throw error;
  }
}

export async function verifyBundle({ bundle, home, platform = process.platform, inspectWindowsLink = windowsLinkType }) {
  const files = validateBundle(bundle);
  const roots = await locations(home);
  const issues = [];
  for (const skill of SKILLS) {
    const target = path.join(roots.canonical, skill);
    issues.push(...await directoryIssues(target, files.filter(file => file.path.startsWith(`${skill}/`))));
  }
  const layout = await claudeLayout(roots, platform, inspectWindowsLink);
  return { status: issues.length ? 'invalid' : 'verified', manifestDigest: bundle.manifestDigest, fileCount: files.length, home: roots.home, claudeLayout: layout, notice: layoutNotice(layout), issues };
}

const USAGE = `Usage (Node 24+):
  node distribute.mjs bundle --skills-root ABSOLUTE_PATH --output ABSOLUTE_FILE [--compress]
  node distribute.mjs install --bundle ABSOLUTE_FILE --home ABSOLUTE_HOME [--backup-conflicts]
  node distribute.mjs verify --bundle ABSOLUTE_FILE --home ABSOLUTE_HOME
Outputs JSON paths, counts, and hashes only. Exit codes: 0 success, 2 conflicts/invalid install, 1 error.
`;

async function main(argv) {
  if (argv.length === 0 || argv.includes('--help')) { process.stdout.write(USAGE); return; }
  const [command, ...rest] = argv;
  const allowed = command === 'bundle' ? ['--skills-root', '--output', '--compress']
    : command === 'install' ? ['--bundle', '--home', '--backup-conflicts']
      : command === 'verify' ? ['--bundle', '--home'] : null;
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate option: ${key}`);
    if (key === '--compress' || key === '--backup-conflicts') options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key] = value;
    }
  }
  let result;
  if (command === 'bundle') result = await writeBundle({ skillsRoot: options['--skills-root'], output: options['--output'], compress: !!options['--compress'] });
  else {
    const bundle = await readBundle(options['--bundle']);
    result = command === 'install'
      ? await installBundle({ bundle, home: options['--home'], backupConflicts: !!options['--backup-conflicts'] })
      : await verifyBundle({ bundle, home: options['--home'] });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (['conflicts', 'invalid'].includes(result.status)) process.exitCode = 2;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ status: 'error', message: errorText(error) })}\n`);
    process.exitCode = 1;
  });
}
