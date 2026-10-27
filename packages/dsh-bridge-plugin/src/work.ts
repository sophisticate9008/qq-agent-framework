import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { normalizeWorkOutput, validWorkOutput, type WorkMediaReference, type WorkOutput } from './work-output.js'
import { readWorkUsage, type WorkUsageStep } from './work-usage.js'
import { readWorkProgress, type WorkProgress } from './work-progress.js'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { validIdentifier } from './receipts.js'
import { workFingerprint, type WorkJournal, type WorkJournalRecord } from './work-journal.js'

export interface WorkAddress {
  readonly issuerEpoch: string
  readonly id: string
  readonly parentSessionId: string
  readonly childId: string
  readonly generation: number
}
export interface WorkTarget {
  readonly fullAccess?: boolean
  readonly parentSessionId: string
  readonly modelProvider: string
  readonly model: string
  readonly agentPreset: string
  readonly reasoningEffort?: string
}
export interface WorkStart extends WorkAddress, WorkTarget {
  readonly task: string
  readonly context: string
  readonly timeoutMs: number
}
interface Entry {
  readonly request: WorkStart
  readonly fingerprint: string
  persistence: Promise<void>
  acceptedMessageId: string | null
  followupRequestId: string | null
  readonly pendingFollowups: Set<string>
  readonly attachments: WorkMediaReference[]
  usage?: readonly WorkUsageStep[]
  progress?: readonly WorkProgress[]
  recovered?: boolean
  permissionVerified?: boolean
  readonly controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  activation?: SubagentActivation
  state: 'starting' | 'running' | 'completed' | 'unknown'
  result: { stopReason: string; output: readonly WorkOutput[] } | null
  error: string | null
}

/** Owner transport for the SDK-managed continuable spawn backend; no raw subagent RPC. */
export function createWorkChannel(options: {
  readonly issuerEpoch: string
  readonly getAgent: (id: string) => Agent | undefined
  readonly runtime: () => SubagentRuntime | undefined
  readonly hasPreset: (id: string) => Promise<boolean>
  readonly continuationAvailable: () => boolean
  readonly fullAccessAvailable?: () => boolean
  readonly applyFullAccess?: (agent: Agent) => void
  readonly journal?: WorkJournal
  readonly readAsset?: (asset: WorkMediaReference, signal: AbortSignal) => Promise<Uint8Array>
}) {
  const entries = new Map<string, Entry>()
  let closed = false
  function epoch(value: string): void {
    if (closed || value !== options.issuerEpoch) throw new TypeError('Work channel epoch changed')
  }
  async function target(request: WorkTarget) {
    if (request.fullAccess !== undefined && typeof request.fullAccess !== 'boolean') throw new TypeError('Invalid work permission')
    if (![request.parentSessionId, request.modelProvider, request.model, request.agentPreset].every(validIdentifier)
      || request.reasoningEffort !== undefined && !validIdentifier(request.reasoningEffort)) throw new TypeError('Invalid work target')
    const runtime = options.runtime()
    const parent = options.getAgent(request.parentSessionId)
    const provider = runtime?.getProvider('spawn')
    const available = (!request.fullAccess || options.fullAccessAvailable?.() === true && options.applyFullAccess !== undefined) && options.continuationAvailable() && parent?.session.id === request.parentSessionId && await options.hasPreset(request.agentPreset)
      && provider?.prepareContinuable !== undefined && provider.inheritsParentContext === false
      && provider.capabilities.agentOptions && provider.capabilities.agentPreset
    return { runtime, parent, available: available === true }
  }
  function durable(entry: Entry): WorkJournalRecord {
    const request = entry.request
    return { schema: 1, fingerprint: entry.fingerprint,
      address: { id: request.id, parentSessionId: request.parentSessionId, childId: request.childId, generation: request.generation },
      target: { ...(request.fullAccess === undefined ? {} : { fullAccess: request.fullAccess }), modelProvider: request.modelProvider, model: request.model, agentPreset: request.agentPreset, timeoutMs: request.timeoutMs, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) },
      state: entry.state, result: entry.result, error: entry.error, permissionVerified: entry.permissionVerified === true, usage: entry.usage ?? [], progress: entry.progress ?? [],
      acceptedMessageId: entry.acceptedMessageId, followupRequestId: entry.followupRequestId }
  }
  function persist(entry: Entry): Promise<void> {
    const record = durable(entry)
    entry.persistence = entry.persistence.then(() => options.journal?.write(record)).catch(() => {
      entry.state = 'unknown'; entry.error = 'WORK_STORAGE_UNKNOWN'; entry.controller.abort()
      throw new TypeError('Durable work evidence is unavailable')
    })
    void entry.persistence.catch(() => {})
    return entry.persistence
  }
  async function locate(address: WorkAddress): Promise<Entry | undefined> {
    epoch(address.issuerEpoch)
    let entry = entries.get(address.id)
    if (!entry && options.journal) {
      const saved = await options.journal.read(address.id)
      if (saved) {
        const request: WorkStart = { ...saved.address, ...saved.target, issuerEpoch: options.issuerEpoch, task: '', context: '' }
        entry = { request, usage: saved.usage ?? [], progress: saved.progress ?? [], recovered: true, permissionVerified: saved.permissionVerified === true, fingerprint: saved.fingerprint, persistence: Promise.resolve(), acceptedMessageId: saved.acceptedMessageId,
          followupRequestId: saved.followupRequestId, pendingFollowups: new Set(), attachments: [], controller: new AbortController(), result: saved.result,
          state: saved.state === 'completed' ? 'completed' : 'unknown', error: saved.state === 'completed' ? saved.error : 'WORK_RECOVERY_REQUIRED' }
        // A recovered record is evidence only. It never launches or replays a child.
        if (entries.size >= 64) throw new TypeError('Work retention capacity is occupied')
        entries.set(address.id, entry)
      }
    }
    if (entry && (entry.request.parentSessionId !== address.parentSessionId || entry.request.childId !== address.childId
      || entry.request.generation !== address.generation)) throw new TypeError('Work parent or generation does not match')
    return entry
  }
  function view(entry: Entry) {
    return { schema: 1 as const, issuerEpoch: options.issuerEpoch, id: entry.request.id, parentSessionId: entry.request.parentSessionId,
      childId: entry.request.childId, generation: entry.request.generation, fullAccess: entry.request.fullAccess === true && entry.permissionVerified === true, usage: entry.usage ?? [], progress: entry.progress ?? [], state: entry.state, result: entry.result, error: entry.error }
  }
  function captureEvidence(entry: Entry, child = options.getAgent(entry.request.childId)): void {
    if (entry.recovered || child?.id !== entry.request.childId || child.session.id !== entry.request.childId || child.session.header.origin !== 'subagent'
      || child.session.header.parentSession !== entry.request.parentSessionId || typeof child.session.snapshotEvents !== 'function') return
    const events = child.session.snapshotEvents()
    const usage = readWorkUsage(events)
    const progress = readWorkProgress(events)
    if (JSON.stringify(usage) !== JSON.stringify(entry.usage ?? []) || JSON.stringify(progress) !== JSON.stringify(entry.progress ?? [])) {
      entry.usage = usage; entry.progress = progress; void persist(entry).catch(() => {})
    }
  }
  function isolate(entry: Entry, error: string): void {
    if (entry.state === 'completed') return
    captureEvidence(entry)
    entry.state = 'unknown'; entry.error = error; entry.controller.abort()
    void persist(entry).catch(() => {})
    void entry.activation?.dispose().catch(() => { entry.error = 'WORK_STOP_UNKNOWN'; void persist(entry).catch(() => {}) })
  }
  function completed(entry: Entry, stopReason: string, output: readonly ContentBlock[]): void {
    if (entry.pendingFollowups.size > 0) return
    captureEvidence(entry)
    try {
      const normalized = [...normalizeWorkOutput(output)]
      for (const asset of entry.attachments) if (!normalized.some(block => block.type === 'media-reference'
        && block.kind === asset.kind && block.attachmentId === asset.attachmentId)) normalized.push(asset)
      if (normalized.length > 256 || Buffer.byteLength(JSON.stringify(normalized)) > 262144) throw new TypeError('Work output exceeds retention bounds')
      entry.result = { stopReason, output: normalized }
      if (entry.state !== 'unknown') entry.state = 'completed'
      clearTimeout(entry.timer); void persist(entry).catch(() => {})
    } catch { isolate(entry, 'WORK_OUTPUT_UNSUPPORTED') }
  }

  return Object.freeze({
    /** The SDK detaches its registry entry before subagent/end; the paired disposal carries the exact child. */
    recordDisposedChild(agent: Agent): void {
      for (const entry of entries.values()) if (entry.request.childId === agent.session.id) captureEvidence(entry, agent)
    },
    /** Called by the SDK's serial creation barrier, before the first child turn. */
    admitCreatedChild(agent: Agent): void {
      const entry = [...entries.values()].find(value => value.request.childId === agent.session.id)
      if (!entry || entry.request.fullAccess !== true) return
      const request = entry.request
      if (closed || !['starting', 'running'].includes(entry.state) || entry.controller.signal.aborted
        || agent.id !== request.childId || options.getAgent(agent.id) !== agent
        || agent.session.header.origin !== 'subagent' || agent.session.header.parentSession !== request.parentSessionId
        || options.getAgent(request.parentSessionId)?.session.id !== request.parentSessionId
        || agent.options.provider !== request.modelProvider || agent.options.model !== request.model
        || !options.applyFullAccess) throw new TypeError('The owner-admitted work child identity changed')
      options.applyFullAccess(agent)
      entry.permissionVerified = true
    },
    hasAttachmentLease(childId: string): boolean {
      return !closed && [...entries.values()].some(entry => entry.request.childId === childId
        && (entry.state === 'starting' || entry.state === 'running') && !entry.controller.signal.aborted)
    },
    registerAttachment(childId: string, asset: WorkMediaReference): void {
      const entry = [...entries.values()].find(value => value.request.childId === childId)
      if (closed || !entry || !['starting', 'running'].includes(entry.state) || entry.controller.signal.aborted || !validWorkOutput(asset))
        throw new TypeError('The work attachment lease is unavailable')
      if (entry.attachments.some(value => value.kind === asset.kind && value.attachmentId === asset.attachmentId)) return
      if (entry.attachments.length >= 3) throw new TypeError('A work result accepts at most three attachments')
      entry.attachments.push(Object.freeze({ ...asset }))
    },
    recordClaim(childId: string, requestId: string): void {
      for (const entry of entries.values()) if (entry.request.childId === childId) entry.pendingFollowups.delete(requestId)
    },
    recordStart(childId: string): void {
      for (const entry of entries.values()) if (entry.request.childId === childId && entry.state !== 'unknown') {
        if (entry.state === 'completed') entry.attachments.length = 0
        entry.state = 'running'; entry.result = null; void persist(entry).catch(() => {})
      }
    },
    recordEnd(event: { id: string; stopReason: string; lastAssistantMessage?: readonly ContentBlock[] }): void {
      for (const entry of entries.values()) if (entry.request.childId === event.id) completed(entry, event.stopReason, event.lastAssistantMessage ?? [])
    },
    async verify(request: WorkTarget & { issuerEpoch: string }) {
      epoch(request.issuerEpoch)
      return { schema: 1 as const, issuerEpoch: options.issuerEpoch, available: (await target(request)).available,
        provider: 'spawn', continuable: true, externalToolAuthorizationVerified: false,
        childFullAccessSupported: options.fullAccessAvailable?.() === true }
    },
    async start(request: WorkStart, signal: AbortSignal) {
      epoch(request.issuerEpoch)
      if (![request.id, request.childId].every(validIdentifier) || request.childId === request.parentSessionId
        || !Number.isSafeInteger(request.generation) || request.generation < 1
        || typeof request.task !== 'string' || !request.task.trim() || request.task.length > 16000
        || typeof request.context !== 'string' || request.context.length > 32000
        || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 10 || request.timeoutMs > 300000) throw new TypeError('Invalid work request')
      if (entries.has(request.id)) throw new TypeError('Work creation was already observed; inspect its result instead')
      if (entries.size >= 64) throw new TypeError('Work retention capacity is occupied')
      const selected = await target(request)
      if (!selected.available || !selected.runtime || !selected.parent) throw new TypeError('The continuable SDK spawn backend is unavailable')
      signal.throwIfAborted()
      if (entries.size >= 64 || entries.has(request.id) || [...entries.values()].some(entry => entry.request.childId === request.childId)) {
        throw new TypeError('Work identity is already reserved; inspect its result instead')
      }
      const controller = new AbortController()
      const entry: Entry = { request: Object.freeze({ ...request }), fingerprint: workFingerprint(request), persistence: Promise.resolve(),
        acceptedMessageId: null, followupRequestId: null, pendingFollowups: new Set(), attachments: [], controller, state: 'starting', result: null, error: null,
        timer: setTimeout(() => isolate(entry, 'WORK_DEADLINE_UNKNOWN'), request.timeoutMs) }
      // Reserve before the first external action; an uncertain start is never retried.
      try { await options.journal?.reserve(durable(entry)) } catch (error) { clearTimeout(entry.timer); throw error }
      entries.set(request.id, entry)
      const startupSignal = AbortSignal.any([signal, controller.signal])
      try {
        const activation = await selected.runtime.startActivation({ provider: 'spawn', label: request.task.slice(0, 120),
          childId: SessionId(request.childId), delivery: 'caller', signal: startupSignal,
          request: { parent: selected.parent, agentPreset: request.agentPreset,
            agentOptions: { provider: request.modelProvider, model: request.model,
              ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }) },
            prompt: [{ type: 'text', text: request.task }, ...(request.context ? [{ type: 'text' as const, text: request.context }] : [])] } })
        entry.activation = activation
        entry.acceptedMessageId = activation.messageId ?? null
        if (activation.childId !== request.childId || startupSignal.aborted || request.fullAccess === true && entry.permissionVerified !== true) {
          isolate(entry, 'WORK_START_UNKNOWN')
          return view(entry)
        }
        if (entry.state === 'starting') entry.state = 'running'
        await persist(entry)
        void activation.result.then(result => completed(entry, result.stopReason, result.output))
          .catch(() => isolate(entry, 'WORK_RESULT_UNKNOWN')).finally(() => clearTimeout(entry.timer))
        return view(entry)
      } catch {
        clearTimeout(entry.timer); isolate(entry, 'WORK_START_UNKNOWN'); return view(entry)
      }
    },
    async inspect(address: WorkAddress) {
      const entry = await locate(address)
      if (entry) { captureEvidence(entry); await entry.persistence }
      return entry ? view(entry) : { schema: 1 as const, issuerEpoch: options.issuerEpoch, id: address.id,
        parentSessionId: address.parentSessionId, childId: address.childId, generation: address.generation,
        state: 'unknown' as const, result: null, error: 'WORK_RECORD_UNAVAILABLE' }
    },
    async readAsset(address: WorkAddress & { kind: 'image' | 'file'; attachmentId: string; offset: number; limit: number }, signal: AbortSignal) {
      const entry = await locate(address)
      if (!entry || !options.readAsset || !['image', 'file'].includes(address.kind)
        || !Number.isSafeInteger(address.offset) || address.offset < 0
        || !Number.isSafeInteger(address.limit) || address.limit < 1 || address.limit > 192 * 1024) throw new TypeError('Work attachment is unavailable')
      await entry.persistence
      const asset = entry.result?.output.find((block): block is WorkMediaReference => block.type === 'media-reference'
        && block.kind === address.kind && block.attachmentId === address.attachmentId)
      if (!asset || address.offset >= asset.bytes) throw new TypeError('Attachment does not belong to this work result')
      signal.throwIfAborted()
      const bytes = await options.readAsset(asset, signal)
      signal.throwIfAborted()
      if (bytes.length !== asset.bytes || bytes.length > 8 * 1024 * 1024) throw new TypeError('Work attachment size changed')
      return { schema: 1 as const, issuerEpoch: options.issuerEpoch, id: address.id, parentSessionId: address.parentSessionId,
        childId: address.childId, generation: address.generation, asset, offset: address.offset, nextOffset: address.offset + address.limit >= asset.bytes ? null : address.offset + address.limit,
        data: Buffer.from(bytes.subarray(address.offset, address.offset + address.limit)).toString('base64') }
    },
    async followup(address: WorkAddress & { requestId: string; text: string; delivery: 'queue' | 'steer' }, signal: AbortSignal) {
      const entry = await locate(address)
      if (!entry || !validIdentifier(address.requestId) || typeof address.text !== 'string' || !address.text.trim()
        || address.text.length > 16000 || !['queue', 'steer'].includes(address.delivery)) throw new TypeError('Invalid work follow-up')
      const runtime = options.runtime()
      if (!runtime || entry.state === 'unknown') throw new TypeError('Work continuation is unavailable')
      await entry.persistence
      // Explicit continuation resumes live observation; journal inspection alone never does.
      entry.recovered = false
      const terminal = entry.state === 'completed'
      if (terminal) {
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => isolate(entry, 'WORK_DEADLINE_UNKNOWN'), entry.request.timeoutMs)
        entry.state = 'starting'; entry.result = null; entry.attachments.length = 0
      }
      entry.pendingFollowups.add(address.requestId)
      entry.followupRequestId = address.requestId
      entry.acceptedMessageId = null
      await persist(entry)
      try {
        const accepted = await runtime.prompt({ requestId: address.requestId as Parameters<SubagentRuntime['prompt']>[0]['requestId'],
          parentSessionId: SessionId(address.parentSessionId), childSessionId: SessionId(address.childId), mode: 'continuable',
          delivery: address.delivery, content: [{ type: 'text', text: address.text }] }, signal)
        if (entry.state === 'starting') entry.state = 'running'
        entry.acceptedMessageId = accepted.messageId
        await persist(entry)
        return accepted
      } catch (error) { isolate(entry, 'WORK_FOLLOWUP_UNKNOWN'); throw error }
    },
    async interrupt(address: WorkAddress) {
      const entry = await locate(address)
      const runtime = options.runtime()
      if (!entry || !runtime) throw new TypeError('Work activation is unavailable')
      return runtime.interruptByParent(SessionId(address.childId), SessionId(address.parentSessionId), 'continuable')
    },
    async close(): Promise<void> {
      closed = true
      const active = [...entries.values()].filter(entry => entry.state !== 'completed')
      for (const entry of active) { clearTimeout(entry.timer); isolate(entry, 'WORK_CHANNEL_CLOSED') }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.allSettled(active.map(entry => entry.activation?.dispose())),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new TypeError('Work shutdown is unconfirmed')), 5000) })])
        await Promise.allSettled([...entries.values()].map(entry => entry.persistence))
      } finally { clearTimeout(timer) }
    }
  })
}
