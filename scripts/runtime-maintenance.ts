import { lstat, readdir, readFile, readlink, realpath, rm, unlink, writeFile, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isRecord, assert } from '../src/core/values.ts';

const day = 86400000;
const missing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
/** Never follow directory links or collect a tree referenced by a process. */
export async function processPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
    try {
      paths.push(await readlink(`/proc/${pid}/cwd`).catch(error => { if (missing(error)) return ''; throw error; }));
      for (const name of ['cmdline', 'environ']) paths.push((await readFile(`/proc/${pid}/${name}`)).toString().replaceAll('\0', '\n'));
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        paths.push(await readlink(`/proc/${pid}/fd/${fd}`).catch(error => { if (missing(error)) return ''; throw error; }));
      }
    } catch (error) { if (!missing(error) && !(isRecord(error) && error.code === 'ESRCH')) throw error; }
  }
  return paths;
}
async function regularDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && await realpath(path) === resolve(path);
}
async function entries(path: string): Promise<string[]> {
  if (!await regularDirectory(path)) return [];
  const names = await readdir(path);
  assert(names.length <= 20000, 'MAINTENANCE_SCAN_LIMIT', 'The maintenance scan exceeded its bound.');
  return names;
}
async function treeBytes(path: string): Promise<number> {
  let bytes = 0; let count = 0; const pending = [path];
  while (pending.length) {
    const current = pending.pop()!; const info = await lstat(current);
    assert(++count < 300000, 'MAINTENANCE_SCAN_LIMIT', 'The maintenance tree is too large.');
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) pending.push(...(await readdir(current)).map(name => join(current, name)));
    else if (info.isFile()) bytes += info.blocks * 512;
  }
  return bytes;
}
export async function runRuntimeMaintenance(root: string, dshHome: string, apply = false) {
  root = await realpath(root);
  const runtime = join(root, 'runtime');
  const now = Date.now();
  const active = await processPaths();
  const live = join(runtime, 'live');
  for (const name of await entries(live)) if (name.endsWith('.json')) {
    const path = join(live, name); const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024) active.push(await readFile(path, 'utf8'));
  }
  const used = (path: string) => active.some(text => text.includes(path + sep) || text.split(/[\s"\0]/).includes(path));
  const result = { schema: 1, at: now, applied: apply, removedTrees: 0, removedFiles: 0, reclaimedBytes: 0, protectedTrees: 0 };
  async function removeTree(path: string) {
    if (used(path)) { result.protectedTrees++; return; }
    const info = await lstat(path);
    const bytes = await treeBytes(path);
    if (apply) {
      const current = await lstat(path);
      assert(info.dev === current.dev && info.ino === current.ino && !current.isSymbolicLink(), 'MAINTENANCE_PATH_CHANGED', 'The cleanup target changed.');
      await rm(path, { recursive: true });
    }
    result.removedTrees++; result.reclaimedBytes += bytes;
  }
  // Only directories containing recognizable framework code are deployment snapshots.
  const deployments = join(runtime, 'deployments');
  const selection: unknown = JSON.parse(await readFile(join(live, 'admin-deployment.json'), 'utf8'));
  assert(isRecord(selection) && typeof selection.entry === 'string' && selection.entry.startsWith(deployments + sep),
    'MAINTENANCE_DEPLOYMENT_UNKNOWN', 'The current deployment must be known before recycling snapshots.');
  const selectedName = selection.entry.slice(deployments.length + 1).split(sep)[0]!;
  assert(await regularDirectory(join(deployments, selectedName)), 'MAINTENANCE_DEPLOYMENT_UNKNOWN', 'The current deployment is missing.');
  for (const name of await entries(deployments)) {
    const path = join(deployments, name);
    if (name === selectedName || !await regularDirectory(path)) continue;
    try {
      const manifest: unknown = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (!isRecord(manifest) || !['qq-bridge-framework', 'qq-agent-framework'].includes(String(manifest.name))) continue;
      if (!(await lstat(join(path, 'scripts/gateway-admin.ts'))).isFile()) continue;
      // Deployments may include old test evidence, but never collect live user data here.
      const embedded = join(path, 'runtime');
      if (await regularDirectory(embedded) && (await readdir(embedded)).some(item => ['live', 'workspace', 'sessions', 'work-assets'].includes(item))) continue;
      await removeTree(path);
    } catch (error) { if (!missing(error)) throw error; }
  }
  // Simulations are independent retained evidence: 30 days, with four newest runs protected.
  const simulations = join(runtime, 'simulations');
  const runs: { path: string; at: number }[] = [];
  for (const name of await entries(simulations)) {
    const path = join(simulations, name);
    if (!await regularDirectory(path)) continue;
    try {
      const raw = await readFile(join(path, 'activity.json'), 'utf8');
      if (raw.length > 4 * 1024 * 1024) continue;
      const activity: unknown = JSON.parse(raw);
      if (!isRecord(activity) || activity.schema !== 1 || activity.simulation !== true || activity.runId !== name) continue;
      runs.push({ path, at: (await lstat(join(path, 'activity.json'))).mtimeMs });
    } catch (error) { if (!missing(error)) throw error; }
  }
  runs.sort((a, b) => b.at - a.at);
  for (const run of runs.slice(4)) if (run.at < now - 30 * day) await removeTree(run.path);
  // Request-size image variants are reproducible from immutable attachment objects.
  const cache = join(dshHome, 'cache/attachments/request-images');
  const candidates: { path: string; at: number; size: number; dev: number; ino: number }[] = [];
  for (const shard of await entries(cache)) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    for (const name of await entries(join(cache, shard))) {
      if (!/^[a-f0-9]{64}$/.test(name) || !name.startsWith(shard)) continue;
      const path = join(cache, shard, name); const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.())
        candidates.push({ path, at: info.mtimeMs, size: info.size, dev: info.dev, ino: info.ino });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  let total = candidates.reduce((sum, file) => sum + file.size, 0);
  for (const file of candidates) {
    if (file.at > now - day || file.at > now - 7 * day && total <= 256 * 1024 * 1024) continue;
    if (apply) {
      const info = await lstat(file.path).catch(error => { if (missing(error)) return null; throw error; });
      if (!info || info.dev !== file.dev || info.ino !== file.ino || info.mtimeMs !== file.at) continue;
      await unlink(file.path);
    }
    total -= file.size; result.removedFiles++; result.reclaimedBytes += file.size;
  }
  if (apply) {
    const temporary = join(runtime, 'storage-maintenance.next.json');
    await writeFile(temporary, JSON.stringify(result) + '\n', { mode: 0o600 });
    await rename(temporary, join(runtime, 'storage-maintenance.json'));
  }
  return result;
}
