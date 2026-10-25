export function redactNativeText(value: string | undefined, sensitiveValues: readonly string[] = []): string | null {
  if (typeof value !== 'string') return null
  let source = value.slice(0, 8_192)
  for (const secret of sensitiveValues) if (typeof secret === 'string' && secret.length > 0) source = source.split(secret).join('[redacted]')
  const cleaned = source
    .replace(/<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|thinking|analysis|reasoning)\s*>|$)/gi, '[redacted]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\bBearer\s+[^\s,;"'<>{}\[\]]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, address => {
      try {
        const url = new URL(address)
        if (url.username || url.password) { url.username = 'redacted'; url.password = '' }
        for (const key of [...url.searchParams.keys()]) {
          if (/token|secret|password|passwd|credential|authorization|api[-_]?key|signature|^auth$|^sig$/i.test(key)) url.searchParams.set(key, '[redacted]')
        }
        return url.href
      } catch { return '[redacted-url]' }
    })
    .replace(/([?&#](?:token|access[-_]?token|refresh[-_]?token|api[-_]?key|auth|authorization|secret|password|passwd|client[-_]?secret|credential|signature|sig)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/((?:["']?)(?:authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|passwd|credentials?|密钥|令牌|密码)(?:["']?)\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;}\]]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-(?:proj-|svcacct-)?|pk-|AIza)[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.length > 2_000 ? `${cleaned.slice(0, 1_999)}…` : cleaned
}
