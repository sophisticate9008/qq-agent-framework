import { asRecord } from './api.ts';

export interface ExecutionPolicy {
  readonly schema: 1;
  readonly turnTimeoutMs: number;
  readonly noticeEnabled: boolean;
  readonly noticeText: string | null;
  readonly cancelOnTimeout: boolean;
  readonly cancelTimeoutMs: number;
  readonly noticeTimeoutMs: number;
  readonly maxActive: number;
  readonly unknownHandling: 'isolate-session';
  readonly lateFinal: 'record-only';
}

export interface ExecutionConfiguration {
  readonly revision: string;
  readonly policy: ExecutionPolicy;
}

export interface ExecutionForm {
  readonly turnSeconds: string;
  readonly noticeEnabled: boolean;
  readonly noticeText: string;
  readonly cancelOnTimeout: boolean;
  readonly cancelSeconds: string;
  readonly noticeSeconds: string;
  readonly maxActive: string;
}

export const defaultTimeoutNotice = '请求已超时，结果尚未确认，未自动重复提交。';

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function parseExecutionConfiguration(value: unknown): ExecutionConfiguration | null {
  const root = asRecord(value);
  const policy = asRecord(root.policy);
  if (typeof root.revision !== 'string' || !/^[a-f0-9]{64}$/.test(root.revision)
    || Object.keys(policy).length !== 10 || policy.schema !== 1
    || !bounded(policy.turnTimeoutMs, 10, 300_000) || !bounded(policy.cancelTimeoutMs, 10, 30_000)
    || !bounded(policy.noticeTimeoutMs, 10, 30_000) || !bounded(policy.maxActive, 1, 256)
    || typeof policy.noticeEnabled !== 'boolean' || typeof policy.cancelOnTimeout !== 'boolean'
    || policy.noticeText !== null && (typeof policy.noticeText !== 'string' || policy.noticeText.length > 8000 || policy.noticeText.includes('\0'))
    || policy.noticeEnabled && (typeof policy.noticeText !== 'string' || !policy.noticeText.trim())
    || policy.unknownHandling !== 'isolate-session' || policy.lateFinal !== 'record-only') return null;
  return { revision: root.revision, policy: {
    schema: 1, turnTimeoutMs: policy.turnTimeoutMs, noticeEnabled: policy.noticeEnabled,
    noticeText: policy.noticeText as string | null, cancelOnTimeout: policy.cancelOnTimeout,
    cancelTimeoutMs: policy.cancelTimeoutMs, noticeTimeoutMs: policy.noticeTimeoutMs, maxActive: policy.maxActive,
    unknownHandling: 'isolate-session', lateFinal: 'record-only',
  } };
}

export function executionForm(policy: ExecutionPolicy): ExecutionForm {
  return { turnSeconds: String(policy.turnTimeoutMs / 1000), noticeEnabled: policy.noticeEnabled,
    noticeText: policy.noticeText ?? '', cancelOnTimeout: policy.cancelOnTimeout,
    cancelSeconds: String(policy.cancelTimeoutMs / 1000), noticeSeconds: String(policy.noticeTimeoutMs / 1000),
    maxActive: String(policy.maxActive) };
}

export function secondsToMilliseconds(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value)) return null;
  const [seconds, fraction = ''] = value.split('.');
  const result = Number(seconds) * 1000 + Number(fraction.padEnd(3, '0'));
  return Number.isSafeInteger(result) ? result : null;
}

export function executionPolicy(form: ExecutionForm): ExecutionPolicy | null {
  return parseExecutionConfiguration({ revision: '0'.repeat(64), policy: {
    schema: 1, turnTimeoutMs: secondsToMilliseconds(form.turnSeconds), noticeEnabled: form.noticeEnabled,
    noticeText: form.noticeText || null, cancelOnTimeout: form.cancelOnTimeout,
    cancelTimeoutMs: secondsToMilliseconds(form.cancelSeconds), noticeTimeoutMs: secondsToMilliseconds(form.noticeSeconds),
    maxActive: /^[1-9][0-9]*$/.test(form.maxActive) ? Number(form.maxActive) : null,
    unknownHandling: 'isolate-session', lateFinal: 'record-only',
  } })?.policy ?? null;
}
