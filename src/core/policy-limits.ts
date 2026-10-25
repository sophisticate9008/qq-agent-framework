export type PolicyAttemptLimits = Record<string, number | null>;

export function isPolicyAttemptLimit(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function incrementPolicyUsage(used: number): number {
  return used < Number.MAX_SAFE_INTEGER ? used + 1 : used;
}
