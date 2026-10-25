import { isRecord } from './api.ts';
import type { NativePackageSnapshot } from '../../src/contracts/native-packages.ts';

export interface FrameworkToolsStatus {
  readonly available: boolean; readonly reason: string | null;
  readonly channel: { readonly state: 'idle' | 'running' | 'unknown' | 'closed'; readonly pending: number; readonly lastError: string | null };
  readonly tools: readonly { readonly name: string; readonly capability: string }[];
  readonly projections: number;
}
export interface NativeToolRuntimeStatus {
  readonly packages: readonly NativePackageSnapshot[];
  readonly frameworkTools: FrameworkToolsStatus | null;
}
const code = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

export function parseNativeToolRuntimeStatus(value: unknown): NativeToolRuntimeStatus | null {
  if (!isRecord(value) || !Array.isArray(value.packages) || value.packages.length > 128) return null;
  const packages: NativePackageSnapshot[] = [];
  for (const item of value.packages) {
    if (!isRecord(item) || item.schema !== 1 || !text(item.id) || !text(item.version)
      || !['registered', 'starting', 'running', 'blocked', 'failed', 'stopping', 'stopped', 'unknown'].includes(String(item.state))
      || item.phase !== null && !['prepare', 'migrate', 'install', 'recover', 'start', 'drain', 'dispose'].includes(String(item.phase))
      || !code(item.reason) || !Array.isArray(item.resources) || item.resources.length > 1_024) return null;
    const resources: NativePackageSnapshot['resources'][number][] = [];
    for (const resource of item.resources) {
      if (!isRecord(resource) || !text(resource.id) || !['task', 'timer', 'subscription', 'service', 'contribution', 'other'].includes(String(resource.kind))
        || !['active', 'disposed', 'unknown'].includes(String(resource.state))) return null;
      resources.push({ id: resource.id, kind: resource.kind as NativePackageSnapshot['resources'][number]['kind'], state: resource.state as NativePackageSnapshot['resources'][number]['state'] });
    }
    packages.push({ schema: 1, id: item.id, version: item.version, state: item.state as NativePackageSnapshot['state'],
      phase: item.phase as NativePackageSnapshot['phase'], reason: item.reason, resources });
  }
  if (new Set(packages.map(item => item.id)).size !== packages.length) return null;
  if (value.frameworkTools === null) return { packages, frameworkTools: null };
  const tools = value.frameworkTools;
  if (!isRecord(tools) || tools.schema !== 1 || typeof tools.available !== 'boolean' || !code(tools.reason) || !count(tools.projections)
    || !isRecord(tools.channel) || !['idle', 'running', 'unknown', 'closed'].includes(String(tools.channel.state))
    || !count(tools.channel.pending) || !code(tools.channel.lastError) || !Array.isArray(tools.tools) || tools.tools.length > 256) return null;
  const definitions: { name: string; capability: string }[] = [];
  for (const definition of tools.tools) {
    if (!isRecord(definition) || !text(definition.name) || !text(definition.capability)) return null;
    definitions.push({ name: definition.name, capability: definition.capability });
  }
  if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) return null;
  return { packages, frameworkTools: { available: tools.available, reason: tools.reason, projections: tools.projections,
    channel: { state: tools.channel.state as FrameworkToolsStatus['channel']['state'], pending: tools.channel.pending, lastError: tools.channel.lastError }, tools: definitions } };
}

export const nativePackageStateLabels: Readonly<Record<NativePackageSnapshot['state'], string>> = {
  registered: '已登记', starting: '启动中', running: '运行中', blocked: '前置条件未满足', failed: '启动失败', stopping: '停止中', stopped: '已停止', unknown: '结果待核对',
};
