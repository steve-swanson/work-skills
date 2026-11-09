import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapRuntime } from '../assets/runtime/store.mjs';
import { ROUTING_SOURCE } from '../../model-routing/lib/routing.mjs';
import { resolvePinnedRuntime } from '../scripts/review.mjs';

const wrapper = fileURLToPath(new URL('../scripts/review.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('new review snapshots freeze the canonical router and can route without installed sibling skills', t => {
  const root = fixture(t);
  const runtime = bootstrapRuntime(root);
  const frozen = path.join(runtime.directory, 'routing.mjs');
  assert.ok(fs.readFileSync(frozen).equals(fs.readFileSync(ROUTING_SOURCE)));
  assert.doesNotMatch(fs.readFileSync(frozen, 'utf8'), /export \* from.*model-routing/);
  const input = { callerRole: 'main', selectedModel: 'gpt-6.1-sol', catalog: [
    { id: 'gpt-6.1-sol', efforts: ['high'], effortOptionId: 'reasoningEffort' }],
    task: { kind: 'implementation', plan: { summary: 'Fixture repair', paths: ['a.mjs'], acceptanceCriteria: ['Works'] } },
    judgment: { modelId: 'gpt-6.1-sol', effort: 'high', reason: 'Fixture local route' } };
  const result = JSON.parse(execFileSync(process.execPath, [path.join(runtime.directory, 'cli.mjs'), 'route', '--input', JSON.stringify(input)], { encoding: 'utf8' }));
  assert.equal(result.route.modelId, 'gpt-6.1-sol');
});

test('canonical router bytes participate in snapshot digest and tampering is rejected', t => {
  const root = fixture(t), runtime = bootstrapRuntime(root);
  const directory = path.join(root, 'project', 'branch', 'run'); fs.mkdirSync(directory, { recursive: true });
  const manifest = { schemaVersion: 1, id: 'fixture', repoId: 'fixture', runtime };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.equal(resolvePinnedRuntime(directory), path.join(runtime.directory, 'cli.mjs'));
  fs.appendFileSync(path.join(runtime.directory, 'routing.mjs'), '\n// modified shared routing\n');
  assert.throws(() => resolvePinnedRuntime(directory), /digest|modified/);
});

test('legacy self-contained snapshot executes unchanged through the new wrapper after installation moves', t => {
  const root = fixture(t), state = path.join(root, 'state'), directory = path.join(state, 'project', 'branch', 'run');
  fs.mkdirSync(directory, { recursive: true });
  // Minimal legacy owner CLI fixture, independent of the new shared router.
  const files = { 'cli.mjs': "import {policy} from './routing.mjs'; export async function main(){process.stdout.write(JSON.stringify({policy})+'\\n');}",
    'routing.mjs': "export const policy = 'legacy-1.3.1';" };
  const digest = crypto.createHash('sha256').update(Buffer.concat(Object.keys(files).sort().flatMap(name => [Buffer.from(`${name}\0`), Buffer.from(files[name])]))).digest('hex');
  const runtime = { version: '1.3.1', digest, directory: path.join(state, '_runtime', `1.3.1-${digest.slice(0, 16)}`) };
  fs.mkdirSync(runtime.directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(runtime.directory, name), content);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'fixture', repoId: 'fixture', runtime }));
  const before = fs.readFileSync(path.join(runtime.directory, 'routing.mjs'));
  const movedWrapper = path.join(root, 'moved-wrapper.mjs'); fs.copyFileSync(wrapper, movedWrapper);
  const result = JSON.parse(execFileSync(process.execPath, [movedWrapper, 'state', '--review', directory], { encoding: 'utf8' }));
  assert.equal(result.policy, 'legacy-1.3.1');
  assert.ok(fs.readFileSync(path.join(runtime.directory, 'routing.mjs')).equals(before));
});
