import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { AdminRequestError, type AdminRoute } from '../admin/server.ts';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 1024;
const MAX_UPSTREAM_BODY_BYTES = 256 * 1024;
const MAX_WRITE_BODY_BYTES = 32 * 1024;
const MAX_ROLE_CONTENT_BYTES = 30 * 1024;
const MAX_COLLECTION_ITEMS = 256;
const MAX_ACCESS_IDENTIFIERS = 1_000;
const MAX_USAGE_LIMIT = 200;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const ROLE_NAME_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fff-]+$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const LEGACY_MODES = ['chat', 'reserved', 'reserved2', 'closed-agent'] as const;

type LegacyMode = typeof LEGACY_MODES[number];

interface LegacyModeSupport {
  readonly reserved: boolean;
  readonly reserved2: boolean;
}

interface AccessList {
  readonly groups: number[];
  readonly private: number[];
}

export interface LegacyAccess {
  readonly allow: AccessList;
  readonly deny: AccessList;
  readonly ownerQQ: number | null;
}

export interface LegacyAdminOptions {
  readonly legacyRoot: string;
  readonly beforeAccessSave?: (access: LegacyAccess, signal: AbortSignal) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

interface LegacyConnection {
  readonly endpoint: string;
  readonly token: string;
  readonly supported: LegacyModeSupport;
}

interface LegacySession {
  readonly key: string;
  readonly sessionId: string;
  readonly owner: boolean;
}

interface UsageBuckets {
  readonly cacheMiss: number;
  readonly cacheHit: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(statusCode: number, code: string): never {
  throw new AdminRequestError(statusCode, code);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(400, 'invalid_request');
  }
}

function noQuery(query: URLSearchParams): void {
  if ([...query.keys()].length !== 0) fail(400, 'invalid_query');
}

function requiredBody(body: Record<string, unknown> | null): Record<string, unknown> {
  if (body === null) fail(400, 'invalid_request');
  return body;
}

function revision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) fail(400, 'invalid_request');
  return value;
}

function legacyMode(value: unknown, response = false): LegacyMode {
  if (typeof value === 'string' && (LEGACY_MODES as readonly string[]).includes(value)) {
    return value as LegacyMode;
  }
  fail(response ? 502 : 400, response ? 'legacy_invalid_response' : 'invalid_mode');
}

function modeSupport(configuration: Record<string, unknown>): LegacyModeSupport {
  const social = record(configuration.social) ? configuration.social : {};
  const socialV2 = record(configuration.socialV2) ? configuration.socialV2 : {};
  return {
    reserved: social.enabled !== false,
    reserved2: socialV2.enabled !== false
  };
}

function modeResponse(mode: LegacyMode, supported: LegacyModeSupport) {
  const state = { mode, supported };
  return { mode, revision: revision(state), supported };
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    fail(502, 'legacy_invalid_response');
  }
  return value;
}

function boundedRequestString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    fail(400, 'invalid_request');
  }
  return value;
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(502, 'legacy_invalid_response');
  }
  return value;
}

function nonnegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(502, 'legacy_invalid_response');
  }
  return value;
}

function usageBuckets(value: unknown): UsageBuckets {
  if (!record(value)) fail(502, 'legacy_invalid_response');
  return {
    cacheMiss: nonnegativeInteger(value.cacheMiss),
    cacheHit: nonnegativeInteger(value.cacheHit),
    cacheWrite: nonnegativeInteger(value.cacheWrite),
    output: nonnegativeInteger(value.output),
    reasoning: nonnegativeInteger(value.reasoning)
  };
}

function usageCounts(value: Record<string, unknown>, declared = false) {
  const buckets = usageBuckets(value.buckets);
  const inputTokens = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  const totalTokens = inputTokens + buckets.output;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(totalTokens)) {
    fail(502, 'legacy_invalid_response');
  }
  if (declared && (nonnegativeInteger(value.inputTokens) !== inputTokens
    || nonnegativeInteger(value.totalTokens) !== totalTokens)) fail(502, 'legacy_invalid_response');
  return {
    totalTokens,
    inputTokens,
    outputTokens: buckets.output,
    cacheHitTokens: buckets.cacheHit,
    cacheMissTokens: buckets.cacheMiss,
    cacheWriteTokens: buckets.cacheWrite,
    reasoningTokens: buckets.reasoning
  };
}

function limitedQuery(query: URLSearchParams, defaultValue: number, maximum: number): number {
  if ([...query.keys()].some(key => key !== 'limit') || query.getAll('limit').length > 1) {
    fail(400, 'invalid_query');
  }
  const raw = query.get('limit');
  if (raw === null) return defaultValue;
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) fail(400, 'invalid_query');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) fail(400, 'invalid_query');
  return parsed;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sessionsFromLegacy(value: unknown): LegacySession[] {
  if (!record(value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_COLLECTION_ITEMS) {
    fail(502, 'legacy_invalid_response');
  }
  const sessions = value.sessions.map(entry => {
    if (!record(entry) || typeof entry.owner !== 'boolean') fail(502, 'legacy_invalid_response');
    return {
      key: boundedString(entry.key, 128),
      sessionId: boundedString(entry.sessionId, 256),
      owner: entry.owner
    };
  });
  sessions.sort((left, right) => compareText(left.key, right.key)
    || compareText(left.sessionId, right.sessionId)
    || Number(left.owner) - Number(right.owner));
  if (new Set(sessions.map(entry => entry.key)).size !== sessions.length) {
    fail(502, 'legacy_invalid_response');
  }
  return sessions;
}

function sessionsResponse(sessions: LegacySession[]) {
  return { sessions, revision: revision(sessions) };
}

function usageFromLegacy(value: unknown, limit: number) {
  if (!record(value) || value.ok !== true || !record(value.totals) || !Array.isArray(value.conversations)
    || value.conversations.length > limit) fail(502, 'legacy_invalid_response');
  const totalsValue = value.totals;
  const totalsCounts = usageCounts(totalsValue, true);
  if (typeof totalsValue.estimated !== 'boolean') fail(502, 'legacy_invalid_response');
  const totalConversations = nonnegativeInteger(totalsValue.conversations);
  const totals = {
    ...totalsCounts,
    cost: nonnegativeNumber(totalsValue.cost),
    estimated: totalsValue.estimated,
    conversations: totalConversations,
    turns: nonnegativeInteger(totalsValue.turns),
    steps: nonnegativeInteger(totalsValue.steps),
    unattributedCost: nonnegativeNumber(totalsValue.unattributedCost)
  };
  if (totals.unattributedCost > totals.cost) fail(502, 'legacy_invalid_response');

  const conversations = value.conversations.map(entry => {
    if (!record(entry) || typeof entry.estimated !== 'boolean' || !Array.isArray(entry.models)
      || entry.models.length > 64) fail(502, 'legacy_invalid_response');
    const models = entry.models.map(model => boundedString(model, 256)).sort(compareText);
    if (new Set(models).size !== models.length) fail(502, 'legacy_invalid_response');
    const counts = usageCounts(entry);
    return {
      key: boundedString(entry.key, 128),
      sessionCount: nonnegativeInteger(entry.sessions),
      totalTokens: counts.totalTokens,
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      cacheHitTokens: counts.cacheHitTokens,
      cost: nonnegativeNumber(entry.cost),
      estimated: entry.estimated,
      turns: nonnegativeInteger(entry.turns),
      steps: nonnegativeInteger(entry.steps),
      lastAt: nonnegativeInteger(entry.lastAt),
      models
    };
  });
  if (conversations.length > totalConversations
    || new Set(conversations.map(entry => entry.key)).size !== conversations.length) {
    fail(502, 'legacy_invalid_response');
  }
  conversations.sort((left, right) => right.cost - left.cost
    || right.totalTokens - left.totalTokens
    || compareText(left.key, right.key));
  return {
    source: 'chat-ledger' as const,
    generatedAt: nonnegativeInteger(value.generatedAt),
    currency: boundedString(value.currency, 16),
    symbol: boundedString(value.symbol, 16),
    totals,
    conversations,
    limit,
    limited: conversations.length < totalConversations
  };
}

function qqIdentifier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(400, 'invalid_request');
  }
  return value;
}

function qqList(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_ACCESS_IDENTIFIERS) fail(400, 'invalid_request');
  const identifiers = value.map(qqIdentifier);
  if (new Set(identifiers).size !== identifiers.length) fail(400, 'invalid_request');
  return identifiers;
}

function accessList(value: unknown): AccessList {
  if (!record(value)) fail(400, 'invalid_request');
  exactKeys(value, ['groups', 'private']);
  return { groups: qqList(value.groups), private: qqList(value.private) };
}

function ownerQQ(value: unknown): number | null {
  return value === null ? null : qqIdentifier(value);
}

function accessFromRequest(value: Record<string, unknown>): LegacyAccess {
  return {
    allow: accessList(value.allow),
    deny: accessList(value.deny),
    ownerQQ: ownerQQ(value.ownerQQ)
  };
}

function accessFromLegacy(value: unknown): LegacyAccess {
  if (!record(value) || !record(value.allow) || !record(value.deny)) fail(502, 'legacy_invalid_response');
  try {
    return {
      allow: accessList(value.allow),
      deny: accessList(value.deny),
      ownerQQ: ownerQQ(value.ownerQQ ?? null)
    };
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) fail(502, 'legacy_invalid_response');
    throw error;
  }
}

function frozenAccess(value: LegacyAccess): LegacyAccess {
  return Object.freeze({
    allow: Object.freeze({ groups: Object.freeze([...value.allow.groups]), private: Object.freeze([...value.allow.private]) }),
    deny: Object.freeze({ groups: Object.freeze([...value.deny.groups]), private: Object.freeze([...value.deny.private]) }),
    ownerQQ: value.ownerQQ
  }) as LegacyAccess;
}

function accessResponse(value: LegacyAccess) {
  return { revision: revision(value), allow: value.allow, deny: value.deny, ownerQQ: value.ownerQQ };
}

function roleName(value: unknown, response = false): string {
  const invalidCode = response ? 'legacy_invalid_response' : 'invalid_request';
  const invalidStatus = response ? 502 : 400;
  if (typeof value !== 'string' || value.length === 0 || value.length > 40 || !ROLE_NAME_PATTERN.test(value)
    || value === '.' || value === '..') {
    fail(invalidStatus, invalidCode);
  }
  return value;
}

function roleContent(value: unknown, response = false): string {
  const invalidCode = response ? 'legacy_invalid_response' : 'invalid_request';
  const invalidStatus = response ? 502 : 400;
  if (typeof value !== 'string') fail(invalidStatus, invalidCode);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > MAX_ROLE_CONTENT_BYTES) {
    fail(invalidStatus, invalidCode);
  }
  return normalized;
}

async function boundedFile(filename: string, maximum: number): Promise<string> {
  const handle = await open(filename, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new Error('invalid file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_UPSTREAM_BODY_BYTES) {
      fail(502, 'legacy_invalid_response');
    }
  }
  if (response.body === null) fail(502, 'legacy_invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_UPSTREAM_BODY_BYTES) {
      await reader.cancel();
      fail(502, 'legacy_invalid_response');
    }
    chunks.push(chunk.value);
  }
  const payload = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8');
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    fail(502, 'legacy_invalid_response');
  }
}

export function createLegacyAdminRoutes(options: LegacyAdminOptions): readonly AdminRoute[] {
  if (!record(options) || typeof options.legacyRoot !== 'string' || options.legacyRoot.length === 0
    || options.beforeAccessSave !== undefined && typeof options.beforeAccessSave !== 'function'
    || options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('Invalid legacy administrator options.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('timeoutMs must be an integer between 10 and 300000.');
  }
  const root = resolve(options.legacyRoot);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  async function connection(): Promise<LegacyConnection> {
    let configuration: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await boundedFile(join(root, 'config.json'), MAX_CONFIG_BYTES));
      if (!record(parsed)) throw new Error('invalid config');
      configuration = parsed;
    } catch {
      fail(503, 'legacy_configuration_unavailable');
    }
    const port = configuration.consolePort ?? 3100;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      fail(503, 'legacy_configuration_unavailable');
    }
    const configured = typeof configuration.consoleToken === 'string' ? configuration.consoleToken.trim() : '';
    if (configured.length >= 10 && configured.length <= 128 && TOKEN_PATTERN.test(configured)) {
      return { endpoint: `http://127.0.0.1:${port}`, token: configured, supported: modeSupport(configuration) };
    }
    let token: string;
    try {
      token = (await boundedFile(join(root, 'state', 'console-token'), MAX_TOKEN_BYTES)).trim();
    } catch {
      fail(503, 'legacy_credentials_unavailable');
    }
    if (token.length === 0 || token.length > 128 || /[\r\n]/.test(token)) {
      fail(503, 'legacy_credentials_unavailable');
    }
    return { endpoint: `http://127.0.0.1:${port}`, token, supported: modeSupport(configuration) };
  }

  async function requestLegacy(
    pathname: string,
    method: 'GET' | 'POST',
    body: unknown,
    signal: AbortSignal,
    existingConnection?: LegacyConnection
  ): Promise<unknown> {
    const target = existingConnection ?? await connection();
    const serialized = method === 'POST' ? JSON.stringify(body) : undefined;
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_WRITE_BODY_BYTES) {
      fail(400, 'request_too_large');
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await fetchImplementation(`${target.endpoint}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          'x-console-token': target.token,
          ...(serialized === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: serialized,
        redirect: 'error',
        signal: combinedSignal
      });
      const value = await readJsonResponse(response);
      if (!response.ok) fail(502, method === 'POST' ? 'legacy_write_rejected' : 'legacy_read_failed');
      return value;
    } catch (error: unknown) {
      if (error instanceof AdminRequestError) throw error;
      if (method === 'POST') fail(504, 'operation_unknown');
      fail(timeoutSignal.aborted ? 504 : 502, timeoutSignal.aborted ? 'legacy_timeout' : 'legacy_unavailable');
    }
  }

  async function readAccess(signal: AbortSignal) {
    return accessResponse(accessFromLegacy(await requestLegacy('/api/whitelist', 'GET', undefined, signal)));
  }

  async function readMode(signal: AbortSignal) {
    const target = await connection();
    const value = await requestLegacy('/api/status', 'GET', undefined, signal, target);
    if (!record(value)) fail(502, 'legacy_invalid_response');
    return modeResponse(legacyMode(value.mode, true), target.supported);
  }

  async function readSessions(signal: AbortSignal) {
    return sessionsResponse(sessionsFromLegacy(await requestLegacy('/api/sessions', 'GET', undefined, signal)));
  }

  function modelFromLegacy(value: unknown) {
    if (!record(value) || !Array.isArray(value.options) || value.options.length === 0 || value.options.length > 32
      || !record(value.labels)) fail(502, 'legacy_invalid_response');
    const provider = boundedString(value.provider, 256);
    const model = boundedString(value.model, 256);
    const reasoningEffort = boundedString(value.reasoningEffort, 64);
    const modelOptions: string[] = [];
    for (const entry of value.options) {
      const option = boundedString(entry, 64);
      if (modelOptions.includes(option)) fail(502, 'legacy_invalid_response');
      modelOptions.push(option);
    }
    if (!modelOptions.includes(reasoningEffort)) fail(502, 'legacy_invalid_response');
    const labels: Record<string, { name: string; description: string }> = Object.create(null) as Record<
      string,
      { name: string; description: string }
    >;
    for (const option of modelOptions) {
      const label = value.labels[option];
      if (label === undefined) continue;
      if (!record(label) || typeof label.name !== 'string' || typeof label.description !== 'string'
        || label.name.length > 256 || label.description.length > 2_000) fail(502, 'legacy_invalid_response');
      labels[option] = { name: label.name, description: label.description };
    }
    const state = { provider, model, reasoningEffort, options: modelOptions, labels };
    return { revision: revision(state), ...state };
  }

  async function readModel(signal: AbortSignal) {
    return modelFromLegacy(await requestLegacy('/api/dsh/model', 'GET', undefined, signal));
  }

  async function readRole(name: string, signal: AbortSignal) {
    const value = await requestLegacy(`/api/roles/content?name=${encodeURIComponent(name)}`, 'GET', undefined, signal);
    if (!record(value) || value.ok !== true || roleName(value.name, true) !== name) fail(502, 'legacy_invalid_response');
    const content = roleContent(value.content, true);
    const state = { name, content };
    return { ...state, revision: revision(state) };
  }

  let writeQueue: Promise<void> = Promise.resolve();
  function serializeWrite<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  const routes: AdminRoute[] = [
    {
      method: 'GET', pathname: '/api/legacy/status', async handle({ query, signal }) {
        noQuery(query);
        const value = await requestLegacy('/api/status', 'GET', undefined, signal);
        if (!record(value) || typeof value.mode !== 'string' || value.mode.length > 64
          || value.role !== null && (typeof value.role !== 'string' || value.role.length > 128)
          || typeof value.dshReady !== 'boolean' || typeof value.socialV2Paused !== 'boolean'
          || !record(value.snowluma)) fail(502, 'legacy_invalid_response');
        const health = value.snowluma;
        const nullableBoolean = (entry: unknown): boolean | null => {
          if (entry === null || typeof entry === 'boolean') return entry;
          fail(502, 'legacy_invalid_response');
        };
        const lastPacketAgoMs = health.lastPacketAgoMs;
        if (lastPacketAgoMs !== null && (typeof lastPacketAgoMs !== 'number'
          || !Number.isFinite(lastPacketAgoMs) || lastPacketAgoMs < 0)) fail(502, 'legacy_invalid_response');
        if (typeof health.silent !== 'boolean' || typeof health.degraded !== 'boolean') {
          fail(502, 'legacy_invalid_response');
        }
        return {
          mode: value.mode,
          role: value.role,
          dshReady: value.dshReady,
          socialV2Paused: value.socialV2Paused,
          snowluma: {
            connected: nullableBoolean(health.connected),
            accountOnline: nullableBoolean(health.accountOnline),
            good: nullableBoolean(health.good),
            lastPacketAgoMs,
            silent: health.silent,
            degraded: health.degraded
          }
        };
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/mode', async handle({ query, signal }) {
        noQuery(query);
        return readMode(signal);
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/mode', handle({ query, body, signal }) {
        noQuery(query);
        return serializeWrite(async () => {
          const request = requiredBody(body);
          exactKeys(request, ['mode', 'revision']);
          const expectedRevision = parseRevision(request.revision);
          const requestedMode = legacyMode(request.mode);
          const current = await readMode(signal);
          if (current.revision !== expectedRevision) fail(409, 'revision_conflict');
          if (requestedMode === 'reserved' && !current.supported.reserved
            || requestedMode === 'reserved2' && !current.supported.reserved2) {
            fail(409, 'legacy_mode_disabled');
          }
          try {
            const result = await requestLegacy('/api/mode', 'POST', { mode: requestedMode }, signal);
            if (signal.aborted || !record(result) || result.ok !== true || result.mode !== requestedMode
              || result.dshSynced !== true) fail(504, 'mode_change_unknown');
            return modeResponse(requestedMode, current.supported);
          } catch {
            fail(504, 'mode_change_unknown');
          }
        });
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/sessions', async handle({ query, signal }) {
        noQuery(query);
        return readSessions(signal);
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/session/reset', handle({ query, body, signal }) {
        noQuery(query);
        const request = requiredBody(body);
        exactKeys(request, ['confirm', 'key', 'revision', 'sessionId']);
        const key = boundedRequestString(request.key, 128);
        const sessionId = boundedRequestString(request.sessionId, 256);
        const expectedRevision = parseRevision(request.revision);
        if (request.confirm !== true) fail(400, 'invalid_request');
        return serializeWrite(async () => {
          if (signal.aborted) fail(504, 'session_reset_unknown');
          let current: Awaited<ReturnType<typeof readSessions>>;
          try {
            current = await readSessions(signal);
          } catch (error: unknown) {
            if (signal.aborted) fail(504, 'session_reset_unknown');
            throw error;
          }
          if (signal.aborted) fail(504, 'session_reset_unknown');
          if (current.revision !== expectedRevision) fail(409, 'revision_conflict');
          if (!current.sessions.some(entry => entry.key === key && entry.sessionId === sessionId)) {
            fail(409, 'session_binding_conflict');
          }
          try {
            const result = await requestLegacy('/api/session/reset', 'POST', { key }, signal);
            if (signal.aborted || !record(result) || result.ok !== true || result.key !== key
              || result.archived !== sessionId) fail(504, 'session_reset_unknown');
            const next = await readSessions(signal);
            if (signal.aborted || next.sessions.some(entry => entry.key === key && entry.sessionId === sessionId)) {
              fail(504, 'session_reset_unknown');
            }
            return {
              ok: true,
              key,
              previousSessionId: sessionId,
              bridgeBindingRemoved: true,
              externalWorkStopped: 'unverified'
            };
          } catch {
            fail(504, 'session_reset_unknown');
          }
        });
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/usage', async handle({ query, signal }) {
        const limit = limitedQuery(query, 100, MAX_USAGE_LIMIT);
        const value = await requestLegacy(`/api/tokens/summary?limit=${limit}`, 'GET', undefined, signal);
        return usageFromLegacy(value, limit);
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/access', async handle({ query, signal }) {
        noQuery(query);
        return readAccess(signal);
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/access', handle({ query, body, signal }) {
        noQuery(query);
        return serializeWrite(async () => {
          if (options.beforeAccessSave === undefined) fail(503, 'access_sync_required');
          const request = requiredBody(body);
          exactKeys(request, ['allow', 'deny', 'ownerQQ', 'revision']);
          const expectedRevision = parseRevision(request.revision);
          const access = accessFromRequest(request);
          const current = await readAccess(signal);
          if (current.revision !== expectedRevision) fail(409, 'revision_conflict');
          if (signal.aborted) fail(504, 'access_save_unknown');
          try {
            await options.beforeAccessSave(frozenAccess(access), signal);
            if (signal.aborted) fail(504, 'access_save_unknown');
            const synchronizedCurrent = await readAccess(signal);
            if (signal.aborted || synchronizedCurrent.revision !== expectedRevision) {
              fail(504, 'access_save_unknown');
            }
            const result = await requestLegacy('/api/whitelist', 'POST', access, signal);
            if (signal.aborted || !record(result) || result.ok !== true) fail(504, 'access_save_unknown');
            return accessResponse(access);
          } catch {
            fail(504, 'access_save_unknown');
          }
        });
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/model', async handle({ query, signal }) {
        noQuery(query);
        return readModel(signal);
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/model', handle({ query, body, signal }) {
        noQuery(query);
        return serializeWrite(async () => {
          const request = requiredBody(body);
          exactKeys(request, ['reasoningEffort', 'revision']);
          const expectedRevision = parseRevision(request.revision);
          if (typeof request.reasoningEffort !== 'string' || request.reasoningEffort.length === 0
            || request.reasoningEffort.length > 64) fail(400, 'invalid_request');
          const current = await readModel(signal);
          if (current.revision !== expectedRevision) fail(409, 'revision_conflict');
          if (!current.options.includes(request.reasoningEffort)) fail(400, 'invalid_reasoning_effort');
          const result = await requestLegacy('/api/dsh/effort', 'POST', {
            reasoningEffort: request.reasoningEffort
          }, signal);
          if (!record(result) || result.ok !== true || result.reasoningEffort !== request.reasoningEffort) {
            fail(502, 'legacy_invalid_response');
          }
          const next = { ...current, reasoningEffort: request.reasoningEffort };
          const state = { provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort,
            options: next.options, labels: next.labels };
          return { revision: revision(state), ...state };
        });
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/silent', handle({ query, body, signal }) {
        noQuery(query);
        return serializeWrite(async () => {
          const request = requiredBody(body);
          exactKeys(request, ['paused']);
          if (typeof request.paused !== 'boolean') fail(400, 'invalid_request');
          const result = await requestLegacy('/api/socialV2/activity', 'POST', { paused: request.paused }, signal);
          if (!record(result) || result.ok !== true || result.paused !== request.paused) {
            fail(502, 'legacy_invalid_response');
          }
          return { paused: request.paused };
        });
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/roles', async handle({ query, signal }) {
        noQuery(query);
        const value = await requestLegacy('/api/roles', 'GET', undefined, signal);
        if (!record(value) || !Array.isArray(value.roles) || value.roles.length > MAX_COLLECTION_ITEMS) {
          fail(502, 'legacy_invalid_response');
        }
        const roles = value.roles.map(entry => roleName(entry, true));
        if (new Set(roles).size !== roles.length) fail(502, 'legacy_invalid_response');
        const current = value.current === null ? null : roleName(value.current, true);
        return { roles, current };
      }
    },
    {
      method: 'GET', pathname: '/api/legacy/role', async handle({ query, signal }) {
        if ([...query.keys()].some(key => key !== 'name') || query.getAll('name').length !== 1) {
          fail(400, 'invalid_query');
        }
        return readRole(roleName(query.get('name')), signal);
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/role', handle({ query, body, signal }) {
        noQuery(query);
        return serializeWrite(async () => {
          const request = requiredBody(body);
          const create = request.create === true;
          exactKeys(request, create ? ['content', 'create', 'name'] : ['content', 'name', 'revision']);
          const name = roleName(request.name);
          const content = roleContent(request.content);
          if (create) {
            const result = await requestLegacy('/api/roles/create', 'POST', { name, content }, signal);
            if (!record(result) || result.ok !== true || result.role !== name) fail(502, 'legacy_invalid_response');
          } else {
            const expectedRevision = parseRevision(request.revision);
            const current = await readRole(name, signal);
            if (current.revision !== expectedRevision) fail(409, 'revision_conflict');
            const result = await requestLegacy('/api/roles/update', 'POST', { name, content }, signal);
            if (!record(result) || result.ok !== true || result.role !== name) fail(502, 'legacy_invalid_response');
          }
          const state = { name, content };
          return { ...state, revision: revision(state) };
        });
      }
    },
    {
      method: 'POST', pathname: '/api/legacy/role/activate', handle({ query, body, signal }) {
        noQuery(query);
        return serializeWrite(async () => {
          const request = requiredBody(body);
          exactKeys(request, ['name']);
          const name = request.name === null ? null : roleName(request.name);
          const result = await requestLegacy('/api/role', 'POST', { role: name }, signal);
          if (!record(result) || result.ok !== true || result.role !== name) fail(502, 'legacy_invalid_response');
          return { current: name };
        });
      }
    }
  ];

  return Object.freeze(routes.map(route => Object.freeze(route)));
}
