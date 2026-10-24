import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type Stats
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { assert, FrameworkError, isRecord } from '../core/values.ts';

const MAX_TOKEN_BYTES = 4_096;
const MAX_MARKER_BYTES = 1_024;
const MARKER_CONTENT = Buffer.from(`${JSON.stringify({ schema: 1 })}\n`);
const INITIALIZE_RETRIES = 20;
const RETRY_DELAY_MS = 5;
const retrySignal = new Int32Array(new SharedArrayBuffer(4));
const competingWriteCodes = new Set([
  'ADMIN_BOOTSTRAP_INVALID_MARKER',
  'ADMIN_BOOTSTRAP_INVALID_TOKEN'
]);

export interface AdminBootstrapOptions {
  tokenFile: string;
}

export interface AdminBootstrapStatus {
  readonly initialized: boolean;
  readonly canInitialize: boolean;
  readonly tokenFile: string;
  readonly error?: string;
}

export interface AdminBootstrap {
  status(): AdminBootstrapStatus;
  initialize(): AdminBootstrapStatus;
  token(): string | null;
}

function fail(code: string, message: string): never {
  throw new FrameworkError(code, message);
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathStatus(filename: string, code: string, message: string): Stats | undefined {
  try {
    return lstatSync(filename, { throwIfNoEntry: false });
  } catch {
    fail(code, message);
  }
}

function privateDirectory(directory: string, create: boolean): void {
  try {
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const information = lstatSync(directory, { throwIfNoEntry: false });
    if (information === undefined && !create) return;
    assert(information?.isDirectory() && !information.isSymbolicLink()
      && (information.mode & 0o777) === 0o700 && realpathSync(directory) === directory,
    'ADMIN_BOOTSTRAP_DIRECTORY_SECURITY', 'A private canonical token directory is required.');
  } catch (error: unknown) {
    if (error instanceof FrameworkError) throw error;
    fail('ADMIN_BOOTSTRAP_DIRECTORY_SECURITY', 'A private canonical token directory is required.');
  }
}

function privateFile(filename: string, maxBytes: number, code: string, message: string): Buffer | null {
  const pathInformation = pathStatus(filename, code, message);
  if (pathInformation === undefined) return null;
  assert(pathInformation.isFile() && !pathInformation.isSymbolicLink() && pathInformation.nlink === 1
    && (pathInformation.mode & 0o777) === 0o600 && pathInformation.size <= maxBytes,
  code, message);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    assert(opened.isFile() && opened.nlink === 1 && (opened.mode & 0o777) === 0o600
      && opened.size <= maxBytes && sameFile(opened, pathInformation), code, message);
    const content = readFileSync(descriptor);
    const completed = fstatSync(descriptor);
    const current = lstatSync(filename);
    assert(content.byteLength <= maxBytes && completed.size === content.byteLength
      && sameFile(opened, completed) && sameFile(opened, current), code, message);
    return content;
  } catch (error: unknown) {
    if (error instanceof FrameworkError) throw error;
    return fail(code, message);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decode(content: Buffer, code: string, message: string): string {
  const value = content.toString('utf8');
  assert(Buffer.from(value, 'utf8').equals(content), code, message);
  return value;
}

function readToken(filename: string): string | null {
  const content = privateFile(filename, MAX_TOKEN_BYTES,
    'ADMIN_BOOTSTRAP_TOKEN_SECURITY', 'A bounded private administrator token is required.');
  if (content === null) return null;
  const token = decode(content, 'ADMIN_BOOTSTRAP_INVALID_TOKEN', 'The administrator token is invalid.').trim();
  assert(token.length >= 24 && !/[\r\n]/.test(token),
    'ADMIN_BOOTSTRAP_INVALID_TOKEN', 'The administrator token is invalid.');
  return token;
}

function readMarker(filename: string): boolean {
  const content = privateFile(filename, MAX_MARKER_BYTES,
    'ADMIN_BOOTSTRAP_MARKER_SECURITY', 'A private initialization marker is required.');
  if (content === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(decode(content, 'ADMIN_BOOTSTRAP_INVALID_MARKER', 'The initialization marker is invalid.')) as unknown;
  } catch (error: unknown) {
    if (error instanceof FrameworkError) throw error;
    fail('ADMIN_BOOTSTRAP_INVALID_MARKER', 'The initialization marker is invalid.');
  }
  assert(isRecord(value) && Object.keys(value).length === 1 && value.schema === 1,
    'ADMIN_BOOTSTRAP_INVALID_MARKER', 'The initialization marker is invalid.');
  return true;
}

function writeExclusive(filename: string, content: Buffer, code: string, message: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') return false;
    return fail(code, message);
  }
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    const opened = fstatSync(descriptor);
    const current = lstatSync(filename);
    assert(opened.isFile() && opened.nlink === 1 && (opened.mode & 0o777) === 0o600
      && opened.size === content.byteLength && sameFile(opened, current), code, message);
    return true;
  } catch (error: unknown) {
    if (error instanceof FrameworkError) throw error;
    return fail(code, message);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function waitForCompetingInitializer(): void {
  Atomics.wait(retrySignal, 0, 0, RETRY_DELAY_MS);
}

export function createAdminBootstrap(options: AdminBootstrapOptions): AdminBootstrap {
  assert(isRecord(options) && Object.keys(options).length === 1
    && typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0
    && !options.tokenFile.includes('\0'),
  'ADMIN_BOOTSTRAP_INVALID_OPTIONS', 'An administrator token filename is required.');
  const tokenFile = resolve(options.tokenFile);
  const markerFile = `${tokenFile}.initialized`;
  const directory = dirname(tokenFile);

  function ensureMarker(): void {
    privateDirectory(directory, true);
    if (readMarker(markerFile)) return;
    writeExclusive(markerFile, MARKER_CONTENT,
      'ADMIN_BOOTSTRAP_MARKER_WRITE_FAILED', 'The initialization marker could not be persisted.');
    assert(readMarker(markerFile),
      'ADMIN_BOOTSTRAP_MARKER_WRITE_FAILED', 'The initialization marker could not be persisted.');
  }

  function inspect(): { status: AdminBootstrapStatus; token: string | null } {
    privateDirectory(directory, false);
    const marker = readMarker(markerFile);
    const token = readToken(tokenFile);
    if (token !== null) {
      if (!marker) ensureMarker();
      return {
        status: Object.freeze({ initialized: true, canInitialize: false, tokenFile }),
        token
      };
    }
    if (marker) {
      return {
        status: Object.freeze({ initialized: true, canInitialize: false, tokenFile, error: 'token_missing' }),
        token: null
      };
    }
    return {
      status: Object.freeze({ initialized: false, canInitialize: true, tokenFile }),
      token: null
    };
  }

  function initialize(): AdminBootstrapStatus {
    for (let attempt = 0; attempt <= INITIALIZE_RETRIES; attempt += 1) {
      try {
        const current = inspect();
        if (!current.status.canInitialize) return current.status;
        privateDirectory(directory, true);
        const token = Buffer.from(`${randomBytes(32).toString('hex')}\n`);
        writeExclusive(tokenFile, token,
          'ADMIN_BOOTSTRAP_TOKEN_WRITE_FAILED', 'The administrator token could not be created.');
        return inspect().status;
      } catch (error: unknown) {
        if (error instanceof FrameworkError && competingWriteCodes.has(error.code)
          && attempt < INITIALIZE_RETRIES) {
          waitForCompetingInitializer();
          continue;
        }
        throw error;
      }
    }
    fail('ADMIN_BOOTSTRAP_TOKEN_WRITE_FAILED', 'The administrator token could not be created.');
  }

  return Object.freeze({
    status(): AdminBootstrapStatus {
      return inspect().status;
    },
    initialize,
    token(): string | null {
      return inspect().token;
    }
  });
}
