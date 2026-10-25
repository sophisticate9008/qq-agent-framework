import * as storage from '../storage/private-json.ts'
import { AdminRequestError } from './errors.ts'

export { revision } from '../storage/private-json.ts'
export type { Document, PrivateJsonReadOptions, PrivateJsonReplaceOptions } from '../storage/private-json.ts'

async function boundary<Result>(operation: () => Promise<Result>): Promise<Result> {
  try { return await operation() }
  catch (error) {
    if (error instanceof storage.PrivateJsonStorageError && !(error instanceof AdminRequestError)) {
      throw new AdminRequestError(error.statusCode, error.code)
    }
    throw error
  }
}

export function ensurePrivateDirectory(directory: string): Promise<void> {
  return boundary(() => storage.ensurePrivateDirectory(directory))
}

export function acquireDirectoryLock(directory: string, lockFilename?: string): Promise<() => Promise<void>> {
  return boundary(() => storage.acquireDirectoryLock(directory, lockFilename))
}

export function withDirectoryWriteLock<Result>(directory: string, operation: () => Promise<Result>): Promise<Result> {
  return boundary(() => storage.withDirectoryWriteLock(directory, operation))
}

export function readPrivateJson<Value>(filename: string, options: storage.PrivateJsonReadOptions<Value>): Promise<storage.Document<Value>> {
  return boundary(() => storage.readPrivateJson(filename, options))
}

export function replacePrivateJson<Saved extends { readonly revision: string }>(
  options: storage.PrivateJsonReplaceOptions<Saved>
): Promise<Saved> {
  return boundary(() => storage.replacePrivateJson(options))
}

export function readDocument<Value>(filename: string, fallback: Value,
  validate: (value: unknown) => Value): Promise<storage.Document<Value>> {
  return boundary(() => storage.readDocument(filename, fallback, validate))
}

export function writeDocumentLocked<Value>(directory: string, filename: string, expectedRevision: string,
  fallback: Value, validate: (value: unknown) => Value, value: Value, encoded?: Buffer): Promise<storage.Document<Value>> {
  return boundary(() => storage.writeDocumentLocked(directory, filename, expectedRevision, fallback, validate, value, encoded))
}

export function updateDocument<Value>(directory: string, filename: string, expectedRevision: string,
  fallback: Value, validate: (value: unknown) => Value, update: (current: Value) => Value | Promise<Value>,
  precommit: (next: Value, current: Value) => void | Promise<void> = () => undefined): Promise<storage.Document<Value>> {
  return boundary(() => storage.updateDocument(directory, filename, expectedRevision, fallback, validate, update, precommit))
}
