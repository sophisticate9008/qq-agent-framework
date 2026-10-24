export function classifyOneBotResponse(value: unknown): 'confirmed' | 'rejected' | 'unknown' {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const body = value as Record<string, unknown>
  if (!Number.isSafeInteger(body.retcode)) return 'unknown'
  if (body.status === 'failed' && body.retcode !== 0 && body.retcode !== 1) return 'rejected'
  return body.status === 'ok' && body.retcode === 0 ? 'confirmed' : 'unknown'
}
