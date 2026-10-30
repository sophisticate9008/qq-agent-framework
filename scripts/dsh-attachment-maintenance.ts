import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { assert, isRecord } from '../src/core/values.ts';

interface Handle { header: unknown; read(offset: number, length: number): Promise<{ events: readonly unknown[] }>; close(): Promise<void> }
interface Persistence { list(): Promise<readonly { header: { id: string }; formatStatus?: string }[]>; open(id: string, access: 'read'): Promise<Handle> }
interface Context { get(name: string): unknown; fiber: { dispose(): Promise<void> } }
/** Called by the service manager under its exclusive lock while the managed DSH is stopped. */
export async function collectDshAttachments(home: string) {
  assert(await realpath(home) === home, 'DSH_GC_UNSAFE_ROOT', 'A canonical DSH home is required.');
  const require = createRequire(join(dirname(home), 'runtime/package.json'));
  const cordis: unknown = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const backend: unknown = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
  assert(isRecord(cordis) && typeof cordis.Context === 'function' && isRecord(backend) && typeof backend.apply === 'function',
    'DSH_GC_UNSUPPORTED', 'The official local persistence reader is unavailable.');
  const ContextClass = cordis.Context as new () => Context;
  const ctx = new ContextClass();
  const hashes = new Set<string>();
  const mark = (value: unknown) => {
    const serialized = JSON.stringify(value);
    assert(serialized.length < 32 * 1024 * 1024, 'DSH_GC_LIMIT', 'A reference batch exceeds the scan limit.');
    for (const match of serialized.matchAll(/\b[a-f0-9]{64}\b/g)) hashes.add(match[0]);
  };
  let removed = 0; let bytes = 0;
  const before = Date.now() - 7 * 86400000;
  try {
    await backend.apply(ctx, { root: join(home, 'sessions'), listConcurrency: 1 });
    const candidate = ctx.get('sessionPersistence');
    assert(candidate && typeof candidate === 'object' && 'list' in candidate && typeof candidate.list === 'function'
      && 'open' in candidate && typeof candidate.open === 'function', 'DSH_GC_UNSUPPORTED', 'Session persistence is unavailable.');
    const persistence = candidate as Persistence;
    const sessions = await persistence.list();
    assert(sessions.length < 20000, 'DSH_GC_LIMIT', 'The session scan exceeded its bound.');
    let events = 0;
    for (const session of sessions) {
      assert(session.formatStatus === 'current', 'DSH_GC_HISTORY_UNVERIFIED', 'Every historical session must be readable in its current format.');
      const handle = await persistence.open(session.header.id, 'read');
      try {
        mark(handle.header);
        for (let offset = 0; ; offset += 128) {
          const batch = await handle.read(offset, 128);
          events += batch.events.length;
          assert(events <= 2000000, 'DSH_GC_LIMIT', 'The historical event scan exceeded its bound.');
          mark(batch.events);
          if (batch.events.length < 128) break;
        }
      } finally { await handle.close(); }
    }
    // Durable work/migration records can own references outside session messages.
    const pending = [join(home, 'storages')]; let files = 0;
    while (pending.length) {
      const path = pending.pop()!;
      const info = await lstat(path).catch(error => { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      assert(!info.isSymbolicLink() && info.uid === process.getuid?.() && ++files <= 30000,
        'DSH_GC_UNVERIFIED_REFERENCE', 'The auxiliary reference tree is unsafe.');
      if (info.isDirectory()) pending.push(...(await readdir(path)).map(name => join(path, name)));
      else {
        assert(info.isFile() && info.size <= 8 * 1024 * 1024 && path.endsWith('.json'),
          'DSH_GC_UNVERIFIED_REFERENCE', 'An auxiliary reference file needs a supported reader.');
        mark(JSON.parse(await readFile(path, 'utf8')));
      }
    }
    // Finish the entire mark phase before deleting even one object. Shared/forked refs are protected.
    for (const kind of ['objects', 'file-objects']) {
      const root = join(home, 'attachments/v1', kind);
      const shards = await readdir(root).catch(error => { if (isRecord(error) && error.code === 'ENOENT') return []; throw error; });
      assert(shards.every(shard => /^[a-f0-9]{2}$/.test(shard)), 'DSH_GC_UNSAFE_ROOT', 'Unknown attachment shard layout.');
      for (const shard of shards) {
        const directory = join(root, shard);
        assert(await realpath(directory) === directory, 'DSH_GC_UNSAFE_ROOT', 'Attachment shards must not be symlinks.');
        for (const name of await readdir(directory)) {
          if (!/^[a-f0-9]{64}$/.test(name) || !name.startsWith(shard) || hashes.has(name)) continue;
          const path = join(directory, name); const info = await lstat(path);
          assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.(),
            'DSH_GC_UNSAFE_OBJECT', 'Attachment objects must be regular owned files.');
          if (info.mtimeMs >= before) continue;
          await unlink(path); removed++; bytes += info.size;
        }
      }
    }
    return { sessions: sessions.length, references: hashes.size, removed, reclaimedBytes: bytes };
  } finally { await ctx.fiber.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(process.env.QQ_BRIDGE_FRAMEWORK_OPS_LOCKED === '1' && process.argv.length === 3,
    'DSH_GC_REQUIRES_MANAGED_STOP', 'Use the framework service manager for offline attachment collection.');
  try { console.log(JSON.stringify(await collectDshAttachments(process.argv[2]!))); }
  catch (error) { console.log(JSON.stringify({ state: 'preserved', code: isRecord(error) && typeof error.code === 'string' ? error.code : 'DSH_GC_UNVERIFIED' })); process.exitCode = 1; }
}
