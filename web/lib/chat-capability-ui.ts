import { asRecord } from './api.ts';

import { isChatPlanCapabilitySelection, isChatPlanReference, type ChatPlanCapabilitySelection } from '../../src/contracts/chat-plans.ts';
import { isNativeConfigurationRevisions, NATIVE_REVISION_PATTERN, type NativeConfigurationRevisions } from '../../src/contracts/native-revisions.ts';
export type CapabilitySelection = ChatPlanCapabilitySelection;

export interface CapabilityPreset {
  readonly presetId: string;
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  readonly composable: boolean;
  readonly packages: readonly string[];
  readonly missingReasons: readonly string[];
}

export interface CapabilityApprovalRequest {
  readonly schema: 1;
  readonly source: CapabilitySelection;
  readonly compositionRevision: string;
  readonly target: {
    readonly profilePath: string;
    readonly credentialsPath: string;
    readonly layerPaths: readonly string[];
    readonly schemaVersion: '0.2.1-rc.2';
  };
}

export interface CapabilityApproval extends CapabilityApprovalRequest {
  readonly approvalId: string;
  readonly authority: 'owner';
  readonly externalTools: 'separate-runtime-authorization-required';
}

export interface CapabilitySnapshot {
  readonly revisions: NativeConfigurationRevisions;
  readonly activePlanId: string | null;
  readonly selection: CapabilitySelection | null;
  readonly approval: CapabilityApproval | null;
  readonly compositionApprovalRequired: boolean;
  readonly available: boolean;
  readonly presets: readonly CapabilityPreset[];
}

export interface CapabilityPreview {
  readonly revisions: NativeConfigurationRevisions;
  readonly selection: CapabilitySelection | null;
  readonly request: CapabilityApprovalRequest | null;
  readonly targetRevision: string | null;
  readonly ready: boolean;
  readonly approvalMatchesPreview: boolean;
  readonly routes: readonly { readonly conversationKind: 'group' | 'private'; readonly contextWindow: number }[];
}

export function capabilityHash(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_REVISION_PATTERN.test(value);
}

export const isCapabilitySelection = isChatPlanCapabilitySelection;

export function sameCapabilitySelection(left: CapabilitySelection | null | undefined, right: CapabilitySelection | null | undefined): boolean {
  return left === right || left != null && right != null && left.schema === right.schema
    && left.presetId === right.presetId && left.revision === right.revision;
}

export function capabilityRevisions(value: unknown): NativeConfigurationRevisions | null {
  return isNativeConfigurationRevisions(value) ? { ...value } : null;
}

function strings(value: unknown, limit: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(entry => typeof entry === 'string' && entry.length <= length);
}

function parseRequest(value: unknown): CapabilityApprovalRequest | null {
  const record = asRecord(value);
  const target = asRecord(record.target);
  if (record.schema !== 1 || !isCapabilitySelection(record.source) || !capabilityHash(record.compositionRevision)
    || target.schemaVersion !== '0.2.1-rc.2' || typeof target.profilePath !== 'string' || !target.profilePath.startsWith('/')
    || typeof target.credentialsPath !== 'string' || !target.credentialsPath.startsWith('/')
    || !strings(target.layerPaths, 32, 4096) || target.layerPaths.some(path => !path.startsWith('/'))
    || target.profilePath.length > 4096 || target.credentialsPath.length > 4096) return null;
  return { schema: 1, source: { ...record.source }, compositionRevision: record.compositionRevision,
    target: { profilePath: target.profilePath, credentialsPath: target.credentialsPath,
      layerPaths: target.layerPaths.slice(), schemaVersion: '0.2.1-rc.2' } };
}

export function parseCapabilityApproval(value: unknown): CapabilityApproval | null {
  const request = parseRequest(value);
  const approval = asRecord(value);
  if (!request || !isChatPlanReference(approval.approvalId)
    || approval.authority !== 'owner' || approval.externalTools !== 'separate-runtime-authorization-required') return null;
  return { ...request, approvalId: approval.approvalId, authority: 'owner', externalTools: 'separate-runtime-authorization-required' };
}

export function parseCapabilitySnapshot(value: unknown): CapabilitySnapshot | null {
  const root = asRecord(value);
  const catalog = asRecord(root.catalog);
  const revisions = capabilityRevisions(root.revisions);
  const approval = root.approval === null ? null : parseCapabilityApproval(root.approval);
  if (!revisions || root.activePlanId !== null && typeof root.activePlanId !== 'string'
    || root.selection !== null && !isCapabilitySelection(root.selection) || root.textOnly !== (root.selection === null)
    || root.approval !== null && !approval || root.approvalState !== (approval ? 'saved' : 'none')
    || root.compositionApprovalRequired !== undefined && typeof root.compositionApprovalRequired !== 'boolean'
    || typeof catalog.available !== 'boolean' || !Array.isArray(catalog.presets) || catalog.presets.length > 128
    || catalog.mounted !== false || catalog.effectiveToolScopeVerified !== false
    || catalog.externalToolAuthorizationVerified !== false || catalog.requiresSeparateExternalToolAuthorization !== true) return null;
  const presets: CapabilityPreset[] = [];
  for (const entry of catalog.presets) {
    const preset = asRecord(entry);
    if (!isChatPlanReference(preset.presetId) || !capabilityHash(preset.revision)
      || typeof preset.name !== 'string' || preset.name.length > 128 || typeof preset.description !== 'string' || preset.description.length > 512
      || typeof preset.composable !== 'boolean' || !strings(preset.packages, 1024, 512) || !strings(preset.missingReasons, 128, 256)) return null;
    presets.push({ presetId: preset.presetId, revision: preset.revision, name: preset.name, description: preset.description,
      composable: preset.composable, packages: preset.packages.slice(), missingReasons: preset.missingReasons.slice() });
  }
  if (new Set(presets.map(preset => preset.presetId)).size !== presets.length || !catalog.available && presets.length !== 0) return null;
  return { revisions, activePlanId: root.activePlanId as string | null,
    selection: root.selection === null ? null : { ...root.selection as CapabilitySelection }, approval,
    compositionApprovalRequired: root.compositionApprovalRequired !== false, available: catalog.available, presets };
}

export function parseCapabilityPreview(value: unknown): CapabilityPreview | null {
  const root = asRecord(value);
  const preparation = asRecord(root.preparation);
  const summary = asRecord(preparation.summary);
  const revisions = capabilityRevisions(root.revisions);
  const request = preparation.capabilityApprovalRequest == null ? null : parseRequest(preparation.capabilityApprovalRequest);
  if (!revisions || root.readOnly !== true || root.externalMutation !== false || typeof root.approvalMatchesPreview !== 'boolean'
    || root.selection !== null && !isCapabilitySelection(root.selection) || root.textOnly !== (root.selection === null)
    || preparation.capabilityApprovalRequest != null && !request
    || !['prepared', 'blocked'].includes(String(preparation.state))) return null;
  const ready = preparation.state === 'prepared' && summary.ready === true;
  const targetRevision = capabilityHash(preparation.targetRevision) ? preparation.targetRevision : null;
  const composition = asRecord(summary.capabilityComposition);
  if (ready && (!targetRevision || root.selection !== null && (!request || !sameCapabilitySelection(request.source, root.selection as CapabilitySelection)
    || composition.schema !== 1 || composition.revision !== request.compositionRevision
    || !isCapabilitySelection(composition.source) || !sameCapabilitySelection(composition.source, request.source)
    || composition.externalToolAuthorizationVerified !== false))) return null;
  const routes: { conversationKind: 'group' | 'private'; contextWindow: number }[] = [];
  if (Array.isArray(summary.selectablePresets)) for (const entry of summary.selectablePresets) {
    const route = asRecord(entry);
    if ((route.conversationKind !== 'group' && route.conversationKind !== 'private')
      || typeof route.contextWindow !== 'number' || !Number.isSafeInteger(route.contextWindow) || route.contextWindow < 1) return null;
    routes.push({ conversationKind: route.conversationKind, contextWindow: route.contextWindow });
  }
  return { revisions, selection: root.selection as CapabilitySelection | null, request, targetRevision, ready,
    approvalMatchesPreview: root.approvalMatchesPreview, routes };
}
