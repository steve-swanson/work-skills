import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function acquireLock(directory, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${key}.lock`), token = randomUUID();
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error(`Watcher lock exists: ${filename}. Check its PID and remove only this lock if its owner has stopped.`);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
  await handle.close();
  return async () => {
    if (JSON.parse(await readFile(filename, 'utf8')).token === token) await unlink(filename);
  };
}

export async function readState(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch(e) { if(e.code === 'ENOENT') return null; throw new Error('Unreadable saved state; inspect it before resuming.'); }
}
export async function writeState(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, filename);
}
