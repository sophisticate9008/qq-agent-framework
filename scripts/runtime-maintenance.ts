import { lstat, readdir, readFile, readlink, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isRecord, assert } from '../src/core/values.ts';

const day = 86400000;
const missing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
/** Never follow directory links or collect a tree referenced by a process. */
export async function processPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`)).toString();
      if (!command) continue; // Kernel threads cannot use deployment code or simulation directories.
      paths.push(command.replaceAll('\0', '\n'));
      if (paths.length % 32 === 0) await new Promise(resolve => setTimeout(resolve, 10));
      paths.push(await readlink(`/proc/${pid}/cwd`).catch(error => { if (missing(error)) return ''; throw error; }));
      for (const name of ['environ']) paths.push((await readFile(`/proc/${pid}/${name}`)).toString().replaceAll('\0', '\n'));
      for (const [index, fd] of (await readdir(`/proc/${pid}/fd`)).entries()) {
        if (index > 0 && index % 64 === 0) await new Promise(resolve => setTimeout(resolve, 20));
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
  let bytes = 0; let count = 0; const pending = [path]; const started = Date.now();
  while (pending.length) {
    const current = pending.pop()!; const info = await lstat(current);
    assert(++count < 50000 && Date.now() - started < 5000, 'MAINTENANCE_SCAN_LIMIT', 'The maintenance tree is too large.');
    if (count % 128 === 0) await new Promise(resolve => setTimeout(resolve, 10));
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) pending.push(...(await readdir(current)).map(name => join(current, name)));
    else if (info.isFile()) bytes += info.blocks * 512;
  }
  return bytes;
}
export async function runRuntimeMaintenance(root: string, apply = false) {
  root = await realpath(root);
  const runtime = join(root, 'runtime');
  const now = Date.now();
  const cpu = process.cpuUsage();
  let active: string[] | undefined;
  const configuredPaths: string[] = [];
  const live = join(runtime, 'live');
  for (const name of await entries(live)) if (name.endsWith('.json')) {
    const path = join(live, name); const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024) configuredPaths.push(await readFile(path, 'utf8'));
  }
  const used = async (path: string) => {
    active ??= [...await processPaths(), ...configuredPaths];
    return active.some(text => text.includes(path + sep) || text.endsWith(path) || text.includes(path + '\n') || text.includes(path + '"'));
  };
  const result = { schema: 1, at: now, applied: apply, removedTrees: 0, removedFiles: 0, reclaimedBytes: 0, protectedTrees: 0, deferred: false, durationMs: 0, cpuMs: 0, peakRssBytes: 0 };
  async function removeTree(path: string) {
    if (result.removedTrees >= 3 || Date.now() - now > 15000) { result.deferred = true; return; }
    if (await used(path)) { result.protectedTrees++; return; }
    const info = await lstat(path);
    let bytes: number;
    try { bytes = await treeBytes(path); } catch (error) {
      if (isRecord(error) && error.code === 'MAINTENANCE_SCAN_LIMIT') { result.deferred = true; return; }
      throw error;
    }
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
  const selectedAt = (await lstat(join(deployments, selectedName))).mtimeMs;
  for (const name of await entries(deployments)) {
    if (Date.now() - now > 15000) { result.deferred = true; break; }
    const path = join(deployments, name);
    if (name === selectedName || !await regularDirectory(path)) continue;
    const info = await lstat(path);
    // A newer directory may still be staging before the atomic deployment selector is switched.
    if (info.mtimeMs > selectedAt && info.mtimeMs > now - 3600000) { result.protectedTrees++; continue; }
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
  result.durationMs = Date.now() - now;
  const usedCpu = process.cpuUsage(cpu);
  result.cpuMs = Math.round((usedCpu.user + usedCpu.system) / 1000);
  result.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  if (apply) {
    const temporary = join(runtime, 'storage-maintenance.next.json');
    await writeFile(temporary, JSON.stringify(result) + '\n', { mode: 0o600 });
    await rename(temporary, join(runtime, 'storage-maintenance.json'));
  }
  return result;
}
