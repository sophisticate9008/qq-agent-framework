import { NATIVE_APPLICATION_PATH, parseNativeApplicationEnvelope, type NativeApplicationPhase, type NativeApplicationSnapshot } from '../../src/contracts/native-application.ts';
import { isNativeConfigurationRevisions } from '../../src/contracts/native-revisions.ts';
import { ApiError, type ApiClient } from './api.ts';
import { parseChatRuntimeStatus, type ChatRuntimeStatus } from './chat-runtime.ts';
import { readResource, writeResource } from './resource-reader.ts';
import { verifiedManualDeploymentReview } from './deployment-review.ts';

export type ChatApplicationPhase = NativeApplicationPhase;
const phaseOrder: Readonly<Record<ChatApplicationPhase, number>> = { stop: 0, prepare: 1, apply: 2, migrate: 3, start: 4 };
export interface ChatApplicationState {
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly reconciling: boolean;
  readonly phase: ChatApplicationPhase | null;
  readonly kind: 'application' | 'manual' | null;
  readonly operationId: string | null;
  readonly operation: NativeApplicationSnapshot | null;
  readonly manualSource: 'deployment' | 'runtime' | null;
}
function createStore() {
  let state: ChatApplicationState = { busy: false, blocked: false, reconciling: false, phase: null, kind: null, operationId: null, operation: null, manualSource: null };
  let owner: symbol | null = null;
  let manualReview: symbol | null = null;
  const listeners = new Set<() => void>();
  const update = (next: ChatApplicationState) => { state = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    claim(kind: ChatApplicationState['kind'] = 'manual', manualSource: 'deployment' | 'runtime' = 'runtime') {
      if (owner || state.busy || state.blocked) throw new Error('另一项聊天操作正在进行或结果尚未确认，请先核对状态。');
      manualReview = null;
      owner = Symbol('chat-application'); update({ ...state, busy: true, phase: null, kind, manualSource: kind === 'manual' ? manualSource : null,
        ...(kind === 'application' ? { operationId: null, operation: null } : {}) }); return owner;
    },
    claimReconciliation(operationId: string) {
      if (owner || state.busy || state.reconciling || state.kind !== 'application' || state.operationId !== operationId) {
        throw new Error('另一项操作仍在进行，或核对目标已经变化，请先重新读取。');
      }
      owner = Symbol('chat-application-reconciliation'); update({ ...state, reconciling: true }); return owner;
    },
    owns: (token: symbol) => owner === token,
    phase(token: symbol, phase: ChatApplicationPhase) { if (owner === token) update({ ...state, phase }); },
    identify(token: symbol, operationId: string) {
      if (owner === token) update({ ...state, operationId, operation: null, kind: 'application' });
    },
    observe(operation: NativeApplicationSnapshot): boolean {
      if (state.kind === 'manual' && (state.busy || state.blocked) || owner && state.operationId === null) return false;
      if (state.operationId && state.operationId !== operation.id && (owner || state.busy || state.blocked)) return false;
      const previous = state.operation;
      if (previous) {
        if (previous.id !== operation.id && operation.createdAt < previous.createdAt) return false;
        if (previous.id === operation.id && (operation.updatedAt < previous.updatedAt
          || previous.createdAt !== operation.createdAt
          || previous.phase !== null && operation.phase !== null
            && phaseOrder[operation.phase] < phaseOrder[previous.phase]
          || previous.state !== 'running' && operation.state === 'running'
          || operation.updatedAt === previous.updatedAt && previous.phase === operation.phase
            && previous.phaseState === 'confirmed' && operation.phaseState !== 'confirmed')) return false;
      }
      update({ ...state, operation, operationId: operation.id, phase: operation.phase, kind: 'application', manualSource: null,
        busy: operation.state === 'running', blocked: operation.state === 'unknown' });
      return true;
    },
    release(token: symbol) {
      if (owner !== token) return;
      owner = null;
      update({ ...state, reconciling: false, busy: state.kind === 'application' && state.operation?.state === 'running',
        phase: state.kind === 'application' ? state.phase : null, kind: state.kind === 'manual' && !state.blocked ? null : state.kind });
    },
    freeze(source?: 'deployment' | 'runtime') {
      owner = null; manualReview = null;
      update({ ...state, busy: false, blocked: true, reconciling: false,
        ...(state.kind === 'application' ? {} : { kind: 'manual' as const, manualSource: source ?? state.manualSource ?? 'runtime' }) });
    },
    reviewManual(source: 'deployment' | 'runtime', evidence?: unknown): symbol | null {
      manualReview = null;
      if (owner || state.busy || !state.blocked || state.kind !== 'manual' || state.manualSource !== source) return null;
      if (source === 'deployment' && !verifiedManualDeploymentReview(evidence)) return null;
      manualReview = Symbol('manual-review'); return manualReview;
    },
    canAcknowledgeManual(token: symbol | null, source: 'deployment' | 'runtime'): boolean {
      return token !== null && token === manualReview && !owner && !state.busy && state.blocked
        && state.kind === 'manual' && state.manualSource === source;
    },
    acknowledgeManual(token: symbol | null, source: 'deployment' | 'runtime'): boolean {
      if (token === null || token !== manualReview || owner || state.busy || !state.blocked || state.kind !== 'manual' || state.manualSource !== source) return false;
      manualReview = null;
      update({ ...state, blocked: false, kind: null, phase: null, manualSource: null, operationId: null, operation: null }); return true;
    },
  };
}
const stores = new WeakMap<ApiClient, ReturnType<typeof createStore>>();
export function chatApplicationStore(api: ApiClient): ReturnType<typeof createStore> {
  let store = stores.get(api);
  if (!store) { store = createStore(); stores.set(api, store); }
  return store;
}
export function sameChatRevisions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
}
function requireState(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export const chatApplicationPhaseLabels: Readonly<Record<ChatApplicationPhase, string>> = {
  stop: '正在停止聊天，保留会话记录…', prepare: '正在识别已保存的聊天设置…', apply: '正在应用并核对 DSH 加载结果…',
  migrate: '正在按核验方案保留上下文、衔接人设与聊天设置…', start: '正在按最新版本启动聊天…',
};
export function newChatApplicationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function chatApplicationPath(operationId?: string | null): string {
  return operationId ? `${NATIVE_APPLICATION_PATH}?id=${encodeURIComponent(operationId)}` : NATIVE_APPLICATION_PATH;
}
export async function readChatApplication(api: ApiClient, signal?: AbortSignal, operationId?: string | null): Promise<NativeApplicationSnapshot | null> {
  const value = parseNativeApplicationEnvelope(await readResource(api, chatApplicationPath(operationId), signal));
  requireState(value, '无法核对持久应用操作，请稍后重新读取。');
  requireState(!operationId || value.operation === null || value.operation.id === operationId, '应用操作标识不匹配，不会继续。');
  if (value.operation) {
    const store = chatApplicationStore(api);
    const accepted = store.observe(value.operation);
    const current = store.getSnapshot().operation;
    if (!accepted && current?.id === value.operation.id) return current;
  }
  return value.operation;
}
function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, 500);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** The server owns every application phase. This client only creates one operation and observes it. */
export async function applyAndStartChat(options: {
  readonly api: ApiClient;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly deploy?: boolean;
  readonly expectedDeploymentRevision?: string;
  readonly expectedRevisions?: Readonly<Record<string, string>>;
  readonly configurationDocument?: 'plans' | 'personas';
  readonly configurationRevision?: string;
  readonly onPhase?: (phase: ChatApplicationPhase) => void;
}): Promise<{ readonly state: 'running' | 'blocked'; readonly runtime: ChatRuntimeStatus; readonly reasons: readonly string[] }> {
  const { api, signal } = options;
  const store = chatApplicationStore(api);
  const token = store.claim('application');
  let wrote = false;
  let lastPhase: ChatApplicationPhase | null = null;
  const guard = () => {
    signal.throwIfAborted();
    requireState(store.owns(token) && options.isCurrent(), '页面或草稿已经变化，已停止页面观察；请重新读取持久应用状态。');
  };
  const runtime = async () => { guard(); const status = parseChatRuntimeStatus(await readResource(api, '/api/chat/runtime', signal)); guard();
    requireState(status, '无法核对聊天运行状态。'); return status; };
  const observe = (operation: NativeApplicationSnapshot) => {
    store.observe(operation);
    if (operation.phase && operation.phase !== lastPhase) { lastPhase = operation.phase; options.onPhase?.(operation.phase); }
  };
  try {
    let status = await runtime();
    const revisions = status.revisions;
    requireState(isNativeConfigurationRevisions(revisions), '服务缺少完整的配置版本，不能创建应用操作。');
    requireState(!options.expectedRevisions || sameChatRevisions(revisions, options.expectedRevisions), '设置版本已变化，请重新读取后再明确应用。');
    requireState(!options.configurationRevision || revisions[options.configurationDocument ?? 'plans'] === options.configurationRevision,
      '伙伴配置版本已变化，请先保存或重新读取核对。');
    requireState(options.expectedDeploymentRevision === undefined || revisions.deployment === options.expectedDeploymentRevision,
      '应用设置版本已变化，请重新读取核对。');
    const existing = await readChatApplication(api, signal);
    guard();
    if (existing?.state === 'running' || existing?.state === 'unknown') {
      store.release(token); store.observe(existing);
      throw new Error(existing.state === 'unknown' ? '先前应用结果尚未确认，请按原操作标识核对；不会重新提交。' : '已有应用操作正在进行，请只读核对当前阶段。');
    }
    const operationId = newChatApplicationId();
    store.identify(token, operationId);
    guard(); wrote = true;
    let operation: NativeApplicationSnapshot;
    try {
      const result = parseNativeApplicationEnvelope(await writeResource(api, NATIVE_APPLICATION_PATH,
        { operationId, revisions, deploy: options.deploy !== false }, signal));
      guard();
      requireState(result?.operation?.id === operationId, '应用请求结果尚未确认，将按操作标识只读核对。');
      operation = result.operation;
    } catch (failure) {
      guard();
      // A missing POST acknowledgement never authorizes another POST, even with the same id.
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && !/unknown/.test(failure.code)) {
        wrote = false; throw failure;
      }
      const recovered = await readChatApplication(api, signal, operationId);
      guard(); requireState(recovered, '应用请求结果尚未确认，请按操作标识重新读取；不会重复提交。'); operation = recovered;
    }
    observe(operation);
    const deadline = Date.now() + 10 * 60_000;
    while (operation.state === 'running') {
      guard(); requireState(Date.now() < deadline, '应用仍在后台处理，请稍后读取同一操作；不会重新提交。');
      const next = await readChatApplication(api, signal, operationId);
      guard(); requireState(next, '暂时无法找到当前应用操作，请继续按原标识核对。'); operation = next; observe(operation);
      if (operation.state === 'running') await pollDelay(signal);
    }
    if (operation.state === 'unknown') { store.freeze(); throw new Error('应用操作结果尚未确认，请核对已记录阶段；不会重试写入或重放工作。'); }
    status = await runtime();
    if (operation.state === 'blocked') return { state: 'blocked', runtime: status, reasons: operation.reasons };
    requireState(status.state === 'running' && status.chatReady && !status.configurationChanged, '应用已结束，但当前聊天运行状态尚未确认，请重新读取。');
    return { state: 'running', runtime: status, reasons: [] };
  } catch (failure) {
    if (wrote && store.getSnapshot().operation?.state !== 'running') store.freeze();
    throw failure;
  } finally { store.release(token); }
}


export async function reconcileChatApplication(api: ApiClient, operationId: string, signal?: AbortSignal): Promise<NativeApplicationSnapshot> {
  signal?.throwIfAborted();
  const store = chatApplicationStore(api);
  const token = store.claimReconciliation(operationId);
  try {
    const envelope = parseNativeApplicationEnvelope(await writeResource(api, `${NATIVE_APPLICATION_PATH}/reconcile`, { operationId }, signal));
    signal?.throwIfAborted();
    requireState(envelope?.operation?.id === operationId, '无法确认核对结果，请重新读取同一操作；不会再次提交。');
    store.observe(envelope.operation);
    return envelope.operation;
  } catch (error) { store.freeze(); throw error; }
  finally { store.release(token); }
}
