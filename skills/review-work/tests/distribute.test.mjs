import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, realpath, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildBundle, writeBundle, readBundle, installBundle, verifyBundle,
} from '../scripts/distribute.mjs';

const skills = ['plan-work', 'execute-work', 'review-work', 'review-loop', 'watch-pr', 'model-routing'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const run = promisify(execFile);
const helper = fileURLToPath(new URL('../scripts/distribute.mjs', import.meta.url));

test('real six-skill bundle includes dependency references and watcher helper', async () => {
  const skillsRoot = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await buildBundle({ skillsRoot });
  assert.equal(bundle.version, 3);
  assert.deepEqual(bundle.manifest.skills, skills);
  for (const relative of ['review-loop/references/review-code.md', 'watch-pr/scripts/watch.mjs', 'watch-pr/scripts/request.mjs',
    'watch-pr/lib/identity.mjs', 'watch-pr/lib/merge-policy.mjs', 'review-work/references/merge-policy.md',
    ...['github', 'gitlab', 'bitbucket', 'azure'].map(name => `watch-pr/lib/providers/${name}.mjs`),
    'model-routing/lib/routing.mjs', 'model-routing/scripts/route.mjs']) {
    assert.equal(Buffer.from(bundle.contents[relative], 'base64').toString('utf8'),
      await readFile(path.join(skillsRoot, relative), 'utf8'));
  }
  const root = await mkdtemp(path.join(tmpdir(), 'old-bundle-test-'));
  try {
    for (const version of [1, 2]) {
      const old = structuredClone(bundle); old.version = version;
      await assert.rejects(installBundle({ bundle: old, home: root }), /rebuild.*six-skill/);
      assert.deepEqual(await readdir(root), []);
    }
    assert.equal((await installBundle({ bundle, home: root })).status, 'installed');
    assert.equal((await verifyBundle({ bundle, home: root })).status, 'verified');
    const { stdout } = await run(process.execPath, [path.join(root, '.agents', 'skills', 'watch-pr', 'scripts', 'request.mjs'), '--help']);
    assert.match(JSON.parse(stdout).help, /resolve-thread\|merge/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-distribute-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const home = path.join(root, 'home');
  await mkdir(home);
  for (const skill of skills) {
    await mkdir(path.join(source, skill, 'scripts'), { recursive: true });
    await writeFile(path.join(source, skill, 'SKILL.md'), `# ${skill}\n`);
    await writeFile(path.join(source, skill, 'scripts', 'helper.mjs'), 'export const ok = true;\n');
  }
  return { root, source, home, bundle: await buildBundle({ skillsRoot: source }) };
}

test('bundle is deterministic, excludes runtime/private files, and round-trips JSON and gzip', async t => {
  const f = await fixture(t);
  for (const name of ['.env', '.env.local', 'review.db', 'review.sqlite3-wal', '.DS_Store', 'private.key']) {
    await writeFile(path.join(f.source, 'review-work', name), 'must never leave source');
  }
  for (const name of ['node_modules', '.git', '.cache', '__pycache__', 'secrets']) {
    await mkdir(path.join(f.source, 'review-work', name));
    await writeFile(path.join(f.source, 'review-work', name, 'private.json'), 'private');
  }
  const bundle = await buildBundle({ skillsRoot: f.source });
  assert.deepEqual(bundle, f.bundle);
  assert.equal(bundle.manifest.files.length, skills.length * 2);
  for (const ext of ['json', 'json.gz']) {
    const output = path.join(f.root, `suite.${ext}`);
    const report = await writeBundle({ skillsRoot: f.source, output });
    assert.equal(report.manifestDigest, bundle.manifestDigest);
    assert.deepEqual(await readBundle(output), bundle);
  }
  await assert.rejects(writeBundle({ skillsRoot: f.source, output: path.join(f.source, 'review-work', 'bundle.json') }), /inside.*skill/i);
});

test('install writes only .agents/skills; identical repeat install does not rewrite files', async t => {
  const f = await fixture(t);
  const first = await installBundle({ bundle: f.bundle, home: f.home });
  assert.equal(first.status, 'installed');
  assert.equal(first.claudeLayout, 'none');
  assert.match(first.notice, /\.claude\/skills/);
  await assert.rejects(lstat(path.join(f.home, '.claude')), { code: 'ENOENT' });
  const target = path.join(f.home, '.agents', 'skills', 'plan-work');
  const before = await lstat(path.join(target, 'SKILL.md'));
  for (const skill of skills) assert.equal((await lstat(path.join(f.home, '.agents', 'skills', skill))).isDirectory(), true);
  assert.equal((await verifyBundle({ bundle: f.bundle, home: f.home })).status, 'verified');
  await writeFile(path.join(target, '.DS_Store'), 'local metadata is never transferred or changed');
  assert.equal((await installBundle({ bundle: f.bundle, home: f.home })).status, 'unchanged');
  assert.equal((await lstat(path.join(target, 'SKILL.md'))).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(path.join(target, '.DS_Store'), 'utf8'), 'local metadata is never transferred or changed');
  await assert.rejects(lstat(path.join(f.home, '.agents', 'state')), { code: 'ENOENT' });
});

test('existing per-skill Claude links are reported and left exactly as they are', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.claude', 'skills'), { recursive: true });
  for (const skill of skills) await symlink(path.join(f.home, '.agents', 'skills', skill), path.join(f.home, '.claude', 'skills', skill), 'dir');
  const installed = await installBundle({ bundle: f.bundle, home: f.home });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.claudeLayout, 'per-skill-links');
  assert.equal(installed.notice, null);
  for (const skill of skills) assert.equal(await readlink(path.join(f.home, '.claude', 'skills', skill)), path.join(f.home, '.agents', 'skills', skill));
  const win = await verifyBundle({ bundle: f.bundle, home: f.home, platform: 'win32', inspectWindowsLink: async () => 'Junction' });
  assert.equal(win.status, 'verified');
  assert.equal(win.claudeLayout, 'none');
});
test('divergent content reports conflicts and leaves every existing entry unchanged', async t => {
  const f = await fixture(t);
  await installBundle({ bundle: f.bundle, home: f.home });
  const file = path.join(f.home, '.agents', 'skills', 'plan-work', 'SKILL.md');
  await writeFile(file, 'local edits');
  const result = await installBundle({ bundle: f.bundle, home: f.home });
  assert.equal(result.status, 'conflicts');
  assert.ok(result.conflicts.some(c => c.path.endsWith('plan-work')));
  assert.equal(await readFile(file, 'utf8'), 'local edits');
  await assert.rejects(lstat(path.join(f.home, '.agents', 'state')), { code: 'ENOENT' });
});

test('explicit backup preserves conflicting directories and installs ignore guard before moving them', async t => {
  const f = await fixture(t);
  await installBundle({ bundle: f.bundle, home: f.home });
  const file = path.join(f.home, '.agents', 'skills', 'plan-work', 'SKILL.md');
  await writeFile(file, 'local edits');
  const claudeDir = path.join(f.home, '.claude', 'skills', 'execute-work');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'notes.txt'), 'keep me');
  const result = await installBundle({ bundle: f.bundle, home: f.home, backupConflicts: true });
  assert.equal(result.status, 'installed');
  assert.match(result.backupPath, /_install-backups/);
  assert.equal(await readFile(path.join(result.backupPath, 'canonical', 'plan-work', 'SKILL.md'), 'utf8'), 'local edits');
  assert.equal(await readFile(path.join(claudeDir, 'notes.txt'), 'utf8'), 'keep me');
  const guard = path.join(f.home, '.agents', 'state', 'review-work', '.gitignore');
  assert.match(await readFile(guard, 'utf8'), /^\*\n!\.gitignore\n$/);
  assert.ok((await lstat(guard)).mtimeMs <= (await lstat(result.backupPath)).mtimeMs);
  assert.equal((await verifyBundle({ bundle: f.bundle, home: f.home })).status, 'verified');
});
test('an unrelated Claude link is never followed, changed, or reported as a conflict', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'unrelated');
  await mkdir(outside);
  await writeFile(path.join(outside, 'precious.txt'), 'keep');
  const link = path.join(f.home, '.claude', 'skills', 'review-work');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(outside, link, 'dir');
  const result = await installBundle({ bundle: f.bundle, home: f.home });
  assert.equal(result.status, 'installed');
  assert.equal(result.claudeLayout, 'none');
  assert.equal(await readlink(link), outside);
  assert.deepEqual(await readdir(outside), ['precious.txt']);
});
test('canonical skill symlink is backed up as a link without changing its target', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'canonical-outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'original');
  const canonical = path.join(f.home, '.agents', 'skills', 'execute-work');
  await mkdir(path.dirname(canonical), { recursive: true });
  await symlink(outside, canonical, 'dir');
  assert.equal((await installBundle({ bundle: f.bundle, home: f.home })).status, 'conflicts');
  const result = await installBundle({ bundle: f.bundle, home: f.home, backupConflicts: true });
  const saved = path.join(result.backupPath, 'canonical', 'execute-work');
  assert.equal((await lstat(saved)).isSymbolicLink(), true);
  assert.equal(await readlink(saved), outside);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
});

test('all hashes are validated before the target home is mutated', async t => {
  const f = await fixture(t);
  const tampered = structuredClone(f.bundle);
  tampered.contents['plan-work/SKILL.md'] = Buffer.from('tampered').toString('base64');
  await assert.rejects(installBundle({ bundle: tampered, home: f.home }), /hash|size/i);
  assert.deepEqual(await readdir(f.home), []);
  const badDigest = structuredClone(f.bundle);
  badDigest.manifestDigest = '0'.repeat(64);
  await assert.rejects(installBundle({ bundle: badDigest, home: f.home }), /digest/i);
  assert.deepEqual(await readdir(f.home), []);
});

test('traversal, absolute paths, Windows path tricks, and case collisions are rejected before writes', async t => {
  const f = await fixture(t);
  for (const unsafe of ['../outside', '/tmp/outside', 'C:/outside', 'plan-work/../outside', 'plan-work/..\\outside', 'plan-work/CON', 'plan-work/file:stream', 'plan-work/trailing.']) {
    const bad = structuredClone(f.bundle);
    const original = bad.manifest.files[0].path;
    bad.manifest.files[0].path = unsafe;
    bad.contents[unsafe] = bad.contents[original];
    delete bad.contents[original];
    bad.manifestDigest = digest(bad.manifest);
    await assert.rejects(installBundle({ bundle: bad, home: f.home }), /path|portable|reserved/i, unsafe);
    assert.deepEqual(await readdir(f.home), []);
  }
  const collision = structuredClone(f.bundle);
  const existing = collision.manifest.files.find(x => x.path === 'plan-work/SKILL.md');
  collision.manifest.files.push({ ...existing, path: 'plan-work/skill.md' });
  collision.contents['plan-work/skill.md'] = collision.contents[existing.path];
  collision.manifestDigest = digest(collision.manifest);
  await assert.rejects(installBundle({ bundle: collision, home: f.home }), /collision|duplicate|sorted/i);
});

test('source symlinks escaping a skill and symlinked install ancestors are refused', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'private');
  await symlink(path.join(outside, 'secret.txt'), path.join(f.source, 'review-work', 'leak.txt'));
  await assert.rejects(buildBundle({ skillsRoot: f.source }), /symlink|symbolic link/i);
  await symlink(outside, path.join(f.home, '.agents'), 'dir');
  await assert.rejects(installBundle({ bundle: f.bundle, home: f.home }), /symlink|symbolic link/i);
  assert.deepEqual(await readdir(outside), ['secret.txt']);
});

test('a whole-folder Claude skills link to the canonical folder is accepted without per-skill links', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.agents', 'skills', 'other-skill'), { recursive: true });
  await writeFile(path.join(f.home, '.agents', 'skills', 'other-skill', 'SKILL.md'), 'unrelated');
  await mkdir(path.join(f.home, '.claude'));
  await symlink(path.join(f.home, '.agents', 'skills'), path.join(f.home, '.claude', 'skills'), 'dir');
  const installed = await installBundle({ bundle: f.bundle, home: f.home });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.claudeLayout, 'shared-folder-link');
  for (const skill of skills) {
    const entry = path.join(f.home, '.agents', 'skills', skill);
    assert.equal((await lstat(entry)).isDirectory(), true);
    assert.equal(await readFile(path.join(f.home, '.claude', 'skills', skill, 'SKILL.md'), 'utf8'), `# ${skill}\n`);
  }
  assert.equal((await lstat(path.join(f.home, '.claude', 'skills'))).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(f.home, '.agents', 'skills', 'other-skill', 'SKILL.md'), 'utf8'), 'unrelated');
  const verified = await verifyBundle({ bundle: f.bundle, home: f.home });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.claudeLayout, 'shared-folder-link');
  assert.equal((await installBundle({ bundle: f.bundle, home: f.home })).status, 'unchanged');
  const win = await verifyBundle({ bundle: f.bundle, home: f.home, platform: 'win32', inspectWindowsLink: async () => 'Junction' });
  assert.equal(win.status, 'verified');
  assert.equal(win.claudeLayout, 'none');
});

test('a whole-folder Claude skills link to any other folder is never written through', async t => {
  const f = await fixture(t);
  const elsewhere = path.join(f.root, 'elsewhere');
  await mkdir(elsewhere);
  await mkdir(path.join(f.home, '.claude'));
  await symlink(elsewhere, path.join(f.home, '.claude', 'skills'), 'dir');
  const result = await installBundle({ bundle: f.bundle, home: f.home });
  assert.equal(result.status, 'installed');
  assert.equal(result.claudeLayout, 'none');
  assert.deepEqual(await readdir(elsewhere), []);
  assert.equal(await readlink(path.join(f.home, '.claude', 'skills')), elsewhere);
});
test('a failure partway through rolls back every replaced skill and keeps prior directories', async t => {
  const f = await fixture(t);
  await installBundle({ bundle: f.bundle, home: f.home });
  for (const skill of skills) await writeFile(path.join(f.home, '.agents', 'skills', skill, 'SKILL.md'), `prior ${skill}`);
  let calls = 0;
  await assert.rejects(installBundle({
    bundle: f.bundle, home: f.home, backupConflicts: true,
    onReplaced: async () => { if (++calls === 2) throw new Error('injected failure'); },
  }), /injected failure/);
  for (const skill of skills) assert.equal(await readFile(path.join(f.home, '.agents', 'skills', skill, 'SKILL.md'), 'utf8'), `prior ${skill}`);
  assert.deepEqual((await readdir(path.join(f.home, '.agents', 'skills'))).sort(), [...skills].sort());
});
test('verification detects missing and changed files and extra files', async t => {
  const f = await fixture(t);
  await installBundle({ bundle: f.bundle, home: f.home });
  await rm(path.join(f.home, '.agents', 'skills', 'plan-work', 'SKILL.md'));
  await writeFile(path.join(f.home, '.agents', 'skills', 'execute-work', 'SKILL.md'), 'changed');
  await writeFile(path.join(f.home, '.agents', 'skills', 'review-work', 'extra.txt'), 'extra');
  const result = await verifyBundle({ bundle: f.bundle, home: f.home });
  assert.equal(result.status, 'invalid');
  const reasons = result.issues.map(x => x.reason).join(' ');
  assert.match(reasons, /missing/i);
  assert.match(reasons, /hash|differ/i);
  assert.match(reasons, /extra|unexpected/i);
});

test('CLI reports JSON status and exit codes and does not echo malformed bundle contents', async t => {
  const f = await fixture(t);
  const bundle = path.join(f.root, 'cli.json.gz');
  const built = JSON.parse((await run(process.execPath, [helper, 'bundle', '--skills-root', f.source, '--output', bundle])).stdout);
  assert.equal(built.manifestDigest, f.bundle.manifestDigest);
  const args = [helper, 'install', '--bundle', bundle, '--home', f.home];
  assert.equal(JSON.parse((await run(process.execPath, args)).stdout).status, 'installed');
  await writeFile(path.join(f.home, '.agents', 'skills', 'plan-work', 'SKILL.md'), 'edited');
  await assert.rejects(run(process.execPath, args), error => error.code === 2 && JSON.parse(error.stdout).status === 'conflicts');
  const malformed = path.join(f.root, 'malformed.json');
  await writeFile(malformed, 'DO_NOT_PRINT_THIS_PRIVATE_CONTENT');
  await assert.rejects(run(process.execPath, [helper, 'install', '--bundle', malformed, '--home', f.home]), error => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(error.stderr, /DO_NOT_PRINT_THIS_PRIVATE_CONTENT/);
    assert.match(JSON.parse(error.stderr).message, /not valid JSON/);
    return true;
  });
});
