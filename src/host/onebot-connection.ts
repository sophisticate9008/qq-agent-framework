import { createOneBotWebSocketClient, type OneBotWebSocketOptions } from '../adapters/onebot-websocket.ts'
import {
  validateAdapterConfiguration,
  type AdapterConnectionStatus,
  type AdapterRuntimePort,
  type NativeAdapterConfiguration
} from './adapter-configuration.ts'

export interface OneBotConnectionManager extends AdapterRuntimePort {
  connect(configuration: NativeAdapterConfiguration, signal: AbortSignal): Promise<void>
  disconnect(): Promise<void>
  connectionStatus(): AdapterConnectionStatus
  close(): Promise<void>
}

export class OneBotConnectionError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

const DISCONNECTED: AdapterConnectionStatus = Object.freeze({
  state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0, chatReady: false, accountOnline: null, accountGood: null
})

async function untilAborted<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  let rejectAbort: ((error: OneBotConnectionError) => void) | undefined
  const cancelled = new Promise<never>((_resolvePromise, rejectPromise) => { rejectAbort = rejectPromise })
  const cancel = (): void => rejectAbort?.(new OneBotConnectionError('adapter_runtime_aborted'))
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  try {
    return await Promise.race([operation, cancelled])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

async function closeClient(client: ReturnType<typeof createOneBotWebSocketClient>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    await untilAborted(client.close(), controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export function createOneBotConnectionManager(options: {
  readonly createClient?: typeof createOneBotWebSocketClient
  readonly onEvent?: OneBotWebSocketOptions['onEvent']
  readonly onProtocolEvent?: OneBotWebSocketOptions['onProtocolEvent']
  readonly accountId?: OneBotWebSocketOptions['accountId']
} = {}): OneBotConnectionManager {
  const createClient = options.createClient ?? createOneBotWebSocketClient
  let client: ReturnType<typeof createOneBotWebSocketClient> | undefined
  let lifecycle: AbortController | undefined
  let connecting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let closed = false
  let last: AdapterConnectionStatus = DISCONNECTED

  function connectionStatus(): AdapterConnectionStatus {
    if (client === undefined) return last
    const status = client.status()
    return Object.freeze({
      state: status.state, selfId: status.selfId, lastError: status.lastError,
      received: status.received, dropped: status.dropped, chatReady: false,
      accountOnline: status.accountOnline ?? null, accountGood: status.accountGood ?? null
    })
  }

  async function disconnect(): Promise<void> {
    if (stopping !== undefined) return stopping
    lifecycle?.abort()
    const pending = connecting
    const operation = (async () => {
      await pending?.catch(() => undefined)
      const previous = client
      if (previous !== undefined) {
        last = connectionStatus()
        await closeClient(previous)
        if (client === previous) client = undefined
      }
      lifecycle = undefined
      last = Object.freeze({ ...last, state: 'disconnected', selfId: null, lastError: null, accountOnline: null, accountGood: null })
    })()
    stopping = operation
    try {
      await operation
    } finally {
      if (stopping === operation) stopping = undefined
    }
  }

  return Object.freeze({
    status() {
      const status = connectionStatus()
      return { running: status.state === 'connected' && status.selfId !== null
        && status.accountOnline !== false && status.accountGood !== false }
    },
    connectionStatus,
    async connect(configuration: NativeAdapterConfiguration, signal: AbortSignal) {
      if (closed) throw new OneBotConnectionError('adapter_runtime_closed')
      if (connecting !== undefined || stopping !== undefined) throw new OneBotConnectionError('adapter_runtime_busy')
      const selected = validateAdapterConfiguration(configuration)
      if (!selected.onebotWs.enabled) throw new OneBotConnectionError('onebot_ws_not_enabled')
      if (signal.aborted) throw new OneBotConnectionError('adapter_runtime_aborted')
      const controller = new AbortController()
      const cancel = (): void => controller.abort()
      signal.addEventListener('abort', cancel, { once: true })
      // Allow both disposal of the previous socket and the new five-second handshake.
      const timer = setTimeout(cancel, 10_000)
      const operation = (async () => {
        try {
          lifecycle?.abort()
          if (client !== undefined) {
            await untilAborted(closeClient(client), controller.signal)
            client = undefined
          }
          if (controller.signal.aborted) throw new OneBotConnectionError('adapter_runtime_aborted')
          lifecycle = controller
          client = createClient({
            endpoint: selected.onebotWs.endpoint,
            ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
            ...(options.onProtocolEvent === undefined ? {} : { onProtocolEvent: options.onProtocolEvent }),
            ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
            ...(selected.onebotWs.secret === '' ? {} : { accessToken: selected.onebotWs.secret }),
            // Native admission enforces the configured turn deadline, including preparation.
            callbackTimeoutMs: 300_000, connectTimeoutMs: 5_000, maxReconnectAttempts: null
          })
          await untilAborted(client.connect(controller.signal), controller.signal)
          if (controller.signal.aborted) throw new OneBotConnectionError('adapter_runtime_aborted')
          const status = connectionStatus()
          if (status.state !== 'connected' || status.selfId === null) {
            throw new OneBotConnectionError('onebot_ws_login_unverified')
          }
        } catch (error: unknown) {
          controller.abort()
          const previous = client
          if (previous !== undefined) {
            last = connectionStatus()
            await closeClient(previous)
            if (client === previous) client = undefined
          }
          const code = signal.aborted ? 'adapter_runtime_aborted'
            : error instanceof Error && 'code' in error && typeof error.code === 'string'
              && /^onebot_ws_[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'onebot_ws_connection_failed'
          last = Object.freeze({ ...last, state: 'error', selfId: null, lastError: code, accountOnline: null, accountGood: null })
          throw new OneBotConnectionError(code)
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', cancel)
        }
      })()
      connecting = operation
      try {
        await operation
      } finally {
        if (connecting === operation) connecting = undefined
      }
    },
    disconnect,
    async close() {
      closed = true
      await disconnect()
    }
  })
}
