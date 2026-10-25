import type { NativeBootstrapMetadata, NativeBootstrapMount, NativeBootstrapState } from '../../src/host/native-bootstrap.ts';
import { asRecord } from './api.ts';

type MountMetadata = ReturnType<NativeBootstrapMount['metadata']>;
export type BootstrapFeatureSummary = MountMetadata['features'][number];
export type BootstrapMountDetails = Pick<MountMetadata,
  'features' | 'effectCapabilities' | 'eventTypes' | 'installedFeatureIds'
  | 'pendingStart' | 'pendingStop' | 'grantsCreatedByInstaller' | 'mediaResolver' | 'forwardConfigured'>;
export type NativeBootstrapSummary = NativeBootstrapMetadata & { readonly unsettledLifecycle: boolean } & (
  { readonly state: 'not-started' | 'unknown'; readonly details: null }
  | { readonly state: NativeBootstrapState; readonly details: BootstrapMountDetails }
);
export interface BootstrapRuntimeSummary {
  readonly runtimeState: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  readonly availability: 'not-provided' | 'not-configured' | 'configured';
  readonly bootstrap: NativeBootstrapSummary | null;
}

const states = ['prepared', 'installed', 'starting', 'running', 'stopping', 'stopped', 'failed', 'unknown'] as const;
const detailKeys = ['features', 'effectCapabilities', 'eventTypes', 'installedFeatureIds', 'pendingStart', 'pendingStop', 'grantsCreatedByInstaller', 'mediaResolver', 'forwardConfigured'] as const;

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
}

function version(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
}

function names(input: unknown, maximum: number): string[] | null {
  if (!Array.isArray(input) || input.length > maximum || !input.every(identifier) || new Set(input).size !== input.length) return null;
  return [...input];
}

export function parseNativeBootstrapSummary(input: unknown): BootstrapRuntimeSummary | null {
  const runtime = asRecord(input);
  if (runtime.state !== 'stopped' && runtime.state !== 'starting' && runtime.state !== 'running' && runtime.state !== 'stopping' && runtime.state !== 'error') return null;
  const runtimeState = runtime.state;
  if (!Object.hasOwn(runtime, 'bootstrap')) return { runtimeState, availability: 'not-provided', bootstrap: null };
  if (runtime.bootstrap === null) return { runtimeState, availability: 'not-configured', bootstrap: null };
  const metadata = asRecord(runtime.bootstrap);
  const manifest = asRecord(metadata.manifest);
  if (!identifier(manifest.id) || !version(manifest.version) || manifest.apiVersion !== 1
    || typeof metadata.codeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.codeFingerprint)
    || metadata.trust !== 'trusted-operator-code' || metadata.sandboxed !== false || metadata.requiresSeparateAuthorization !== true
    || metadata.unsettledLifecycle !== undefined && typeof metadata.unsettledLifecycle !== 'boolean') return null;
  const base: NativeBootstrapMetadata = { manifest: { id: manifest.id, version: manifest.version, apiVersion: 1 },
    codeFingerprint: metadata.codeFingerprint, trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true };
  if (metadata.state === 'not-started') {
    if (metadata.unsettledLifecycle === true || detailKeys.some(key => Object.hasOwn(metadata, key))) return null;
    return { runtimeState, availability: 'configured', bootstrap: { ...base, state: 'not-started', details: null, unsettledLifecycle: false } };
  }
  if (metadata.state === 'unknown' && metadata.unsettledLifecycle === true && !detailKeys.some(key => Object.hasOwn(metadata, key))) {
    return { runtimeState, availability: 'configured', bootstrap: { ...base, state: 'unknown', details: null, unsettledLifecycle: true } };
  }
  const state = states.find(state => state === metadata.state);
  if (!state || typeof metadata.pendingStart !== 'boolean' || typeof metadata.pendingStop !== 'boolean'
    || metadata.grantsCreatedByInstaller !== false || typeof metadata.mediaResolver !== 'boolean' || typeof metadata.forwardConfigured !== 'boolean'
    || !Array.isArray(metadata.features) || metadata.features.length > 64) return null;
  const effectCapabilities = names(metadata.effectCapabilities, 128);
  const eventTypes = names(metadata.eventTypes, 128);
  const installedFeatureIds = names(metadata.installedFeatureIds, 64);
  if (!effectCapabilities || !eventTypes || !installedFeatureIds) return null;
  const features: BootstrapFeatureSummary[] = [];
  const seen = new Set<string>();
  for (const input of metadata.features) {
    const feature = asRecord(input);
    const capabilities = names(feature.capabilities, 128);
    const subscriptions = names(feature.subscriptions, 128);
    if (!identifier(feature.id) || feature.id === 'agent-relay' || seen.has(feature.id) || !version(feature.version) || !capabilities || !subscriptions) return null;
    seen.add(feature.id);
    features.push({ id: feature.id, version: feature.version, capabilities, subscriptions });
  }
  if (installedFeatureIds.some(id => !seen.has(id))) return null;
  return { runtimeState, availability: 'configured', bootstrap: { ...base, state, unsettledLifecycle: metadata.unsettledLifecycle === true, details: {
    pendingStart: metadata.pendingStart, pendingStop: metadata.pendingStop, grantsCreatedByInstaller: false,
    features, effectCapabilities, eventTypes, installedFeatureIds, mediaResolver: metadata.mediaResolver, forwardConfigured: metadata.forwardConfigured,
  } } };
}

export function bootstrapLifecycleLabel(summary: NativeBootstrapSummary): string {
  if (summary.unsettledLifecycle) return '扩展生命周期仍未结束，结果未知';
  if (summary.details?.pendingStart && summary.details.pendingStop) return '启动与停止仍待确认';
  if (summary.details?.pendingStop) return '停止仍待确认';
  if (summary.details?.pendingStart) return '启动仍待确认';
  return {
    'not-started': '已选定，尚无挂载详情', prepared: '已准备，尚未安装', installed: '已有安装记录，尚未启动',
    starting: '扩展正在启动', running: '扩展生命周期已启动', stopping: '扩展正在停止',
    stopped: '扩展生命周期已停止', failed: '扩展装配或生命周期失败', unknown: '扩展生命周期结果未知',
  }[summary.state];
}

const capabilityLabels: Readonly<Record<string, string>> = {
  'messaging.send': '发送消息',
  'messaging.forward': '发送合并转发',
  'model.respond': '调用模型',
  'agent.submit': '向代理提交任务',
  'agent.cancel': '请求协作停止',
  'presentation.prepare': '准备可发送内容',
};
const eventLabels: Readonly<Record<string, string>> = {
  'message.received': '收到消息',
  'trigger.fired': '触发条件满足',
};

export function bootstrapDeclarationLabels(values: readonly string[], kind: 'capabilities' | 'subscriptions'): readonly string[] {
  const labels = kind === 'capabilities' ? capabilityLabels : eventLabels;
  const known = values.filter(value => Object.hasOwn(labels, value)).map(value => labels[value]);
  const custom = values.length - known.length;
  return [...known, ...(custom ? [`${custom} 项自定义${kind === 'capabilities' ? '动作' : '事件'}声明（标识见详情）`] : [])];
}
