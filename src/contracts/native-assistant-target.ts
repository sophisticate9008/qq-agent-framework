export const NATIVE_ASSISTANT_DEPLOYMENT_PATH = '/api/chat/assistant/deployment'
export interface NativeAssistantDeploymentRequest {
  readonly assistantRevision: string
  readonly configurationRevision: string
  readonly targetRevision: string
  readonly operationRevision: string
}
export interface NativeAssistantDeploymentSnapshot {
  readonly schema: 1
  readonly state: 'prepared' | 'blocked' | 'applying' | 'verified' | 'pending_reload' | 'unknown' | 'conflict'
  readonly assistantRevision: string
  readonly configurationRevision: string | null
  readonly targetRevision: string | null
  readonly operationRevision: string
  readonly provider: string | null
  readonly model: string | null
  readonly agentPreset: string | null
  readonly externalProvider: string | null
  readonly fullAccess: false
  readonly missingReasons: readonly string[]
}
export function parseNativeAssistantDeploymentSnapshot(input: unknown): NativeAssistantDeploymentSnapshot | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const keys = ['schema', 'state', 'assistantRevision', 'configurationRevision', 'targetRevision', 'operationRevision', 'provider', 'model', 'agentPreset', 'externalProvider', 'fullAccess', 'missingReasons']
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.schema !== 1
    || !['prepared', 'blocked', 'applying', 'verified', 'pending_reload', 'unknown', 'conflict'].includes(String(value.state))
    || !['assistantRevision', 'operationRevision'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(String(value[key])))
    || !['configurationRevision', 'targetRevision'].every(key => value[key] === null || typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(String(value[key])))
    || !['provider', 'model', 'agentPreset', 'externalProvider'].every(key => value[key] === null || typeof value[key] === 'string'
      && String(value[key]).length > 0 && String(value[key]).length <= 160 && !/[\u0000-\u001f\u007f]/.test(String(value[key])))
    || value.fullAccess !== false || !Array.isArray(value.missingReasons) || value.missingReasons.length > 128
    || !value.missingReasons.every(reason => typeof reason === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(reason))
    || value.state === 'verified' && (value.agentPreset === null || value.externalProvider === null || value.missingReasons.length !== 0)) return null
  return Object.freeze({ ...value, missingReasons: Object.freeze([...value.missingReasons]) }) as unknown as NativeAssistantDeploymentSnapshot
}
