/** Service versions describe interface compatibility, never permission. */
export const NATIVE_HOST_SERVICES_PACKAGE_ID = 'native-services'
export const NATIVE_HOST_SERVICE_VERSION = 1
export const NATIVE_HOST_SERVICE_IDS = Object.freeze({
  agent: 'native-agent', interactions: 'native-interactions', executions: 'native-executions', tools: 'native-tools', work: 'native-work'
} as const)
export type NativeHostServiceId = typeof NATIVE_HOST_SERVICE_IDS[keyof typeof NATIVE_HOST_SERVICE_IDS]
export interface NativeServiceAvailability {
  readonly available: boolean
  readonly missingReasons: readonly string[]
}
export interface NativeServiceAgentBinding {
  readonly conversationId: string
  readonly sessionId: string
  readonly generation: number
}
