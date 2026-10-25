import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { validateNativeApplicationJournal, type NativeApplicationStorage, type NativeApplicationJournal } from '../host/native-application.ts';
import { ensurePrivateDirectory, readPrivateJson, replacePrivateJson, withDirectoryWriteLock, PrivateJsonStorageError } from './private-json.ts';

export function createNativeApplicationStorage(directory: string): NativeApplicationStorage {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute application directory is required.');
  const root = resolve(directory);
  const filename = join(root, 'native-application.json');
  const maxBytes = 4 * 1024 * 1024;
  const readOnce = () => readPrivateJson(filename, { maxBytes, validate: validateNativeApplicationJournal,
    fallback: { value: { schema: 1, records: [] } }, exactMode: 0o600, requireSingleLink: true,
    invalidCode: 'application_storage_invalid', conflictCode: 'application_revision_conflict' });
  const read = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await readOnce(); }
      catch (error) {
        if (attempt >= 2 || !(error instanceof PrivateJsonStorageError) || error.code !== 'application_revision_conflict') throw error;
      }
    }
  };
  return Object.freeze({ read, async write(expectedRevision: string, input: NativeApplicationJournal) {
    const value = validateNativeApplicationJournal(input);
    const content = Buffer.from(`${JSON.stringify(value)}\n`);
    if (content.byteLength > maxBytes) throw new PrivateJsonStorageError(413, 'application_history_full');
    await ensurePrivateDirectory(root);
    return withDirectoryWriteLock(root, () => replacePrivateJson({ directory: root, filename,
      temporary: join(root, `.application-${randomUUID()}.tmp`), expectedRevision, content, read,
      verifyTemporaryMetadata: true, directoryOpenFlags: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      conflictCode: 'application_revision_conflict', writeFailedCode: 'application_write_failed', writeUnknownCode: 'application_write_unknown' }));
  } });
}
