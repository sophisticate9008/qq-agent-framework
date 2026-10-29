import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { isRecord } from '../src/core/values.ts'

export interface SimulatedMessage {
  readonly actor: 'owner' | 'member'
  readonly memberIndex?: number
  readonly kind: 'private' | 'group'
  readonly text: string
  readonly mention?: boolean
  readonly groupId?: string
  readonly replyTo?: number
  readonly segments?: readonly Record<string, unknown>[]
}
export interface SimulatedAsset {
  readonly path: string
  readonly kind: 'image' | 'record' | 'file' | 'video'
}

export function simulatedMemberIndex(actor: unknown, value: unknown): number {
  if (value === undefined) return 1
  if (actor !== 'member' || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 8)
    throw new Error('simulation_invalid_member_index')
  return value
}

export function createSimulatedMembers(identity: { readonly selfId: string; readonly ownerId: string; readonly memberId: string }) {
  const reserved = new Set([identity.selfId, identity.ownerId, identity.memberId])
  if (!/^[1-9][0-9]{0,14}$/.test(identity.memberId) || identity.memberId === identity.ownerId || identity.memberId === identity.selfId)
    throw new Error('simulation_invalid_member_identity')
  const members = [{ memberIndex: 1, userId: identity.memberId, nickname: '模拟群友' }]
  let candidate = 900000000010n
  while (members.length < 8) {
    const userId = String(candidate++)
    if (reserved.has(userId)) continue
    reserved.add(userId)
    const memberIndex = members.length + 1
    members.push({ memberIndex, userId, nickname: `模拟群友${memberIndex}` })
  }
  return members
}

/** A local protocol peer. No upstream, proxy, or URL supplied by a model exists here. */
export async function startSimulatedOneBot(options: {
  readonly selfId: string
  readonly ownerId: string
  readonly memberId: string
  readonly groupId: string
  readonly directory: string
  readonly record: (entry: Readonly<Record<string, unknown>>) => void
}) {
  const members = createSimulatedMembers(options)
  const memberIds = new Set(members.map(member => member.userId))
  const knownIds = new Set([options.ownerId, options.selfId, ...memberIds])
  const nickname = (userId: string) => userId === options.selfId ? '模拟机器人' : userId === options.ownerId ? '模拟主人'
    : members.find(member => member.userId === userId)?.nickname ?? '模拟群友'
  const sender = (actor: 'owner' | 'member', memberIndex?: number) => {
    const index = simulatedMemberIndex(actor, memberIndex)
    return actor === 'owner' ? options.ownerId : members[index - 1]!.userId
  }
  const secret = randomBytes(32).toString('hex')
  const messages = new Map<number, Readonly<Record<string, unknown>>>()
  const sockets = new Set<WebSocket>()
  const assets = new Map<string, { readonly bytes: Buffer; readonly name: string; readonly kind: string }>()
  const forwards = new Map<string, readonly Record<string, unknown>[]>()
  let sequence = 1_000_000
  let sent = 0
  let videoReads = 0
  const allowedSends = new Set(['send_private_msg', 'send_group_msg', 'send_msg', 'send_group_forward_msg', 'send_private_forward_msg'])
  async function registerAsset(filename: string, kind: SimulatedAsset['kind']) {
    const maximumBytes = kind === 'video' ? 64 * 1024 * 1024 : 8 * 1024 * 1024
    const information = await lstat(filename)
    if (!information.isFile() || information.isSymbolicLink() || information.size > maximumBytes) throw new Error('simulation_asset_unsafe')
    const key = randomBytes(16).toString('hex')
    const bytes = await readFile(filename)
    if (bytes.length > maximumBytes || bytes.length !== information.size) throw new Error('simulation_asset_changed')
    assets.set(key, { bytes, name: basename(filename), kind })
    return { type: kind, data: { file: key, file_id: key, name: basename(filename), size: bytes.length,
      ...(kind === 'video' ? { url: `${endpoint}/assets/${key}`, file_size: bytes.length } : {}) } }
  }
  function registerForward(nodes: readonly Record<string, unknown>[]) {
    const key = randomBytes(16).toString('hex')
    forwards.set(key, nodes)
    return { type: 'forward', data: { id: key } }
  }
  function emitNotice(event: Readonly<Record<string, unknown>>) {
    if (![...sockets].some(socket => socket.readyState === WebSocket.OPEN)) throw new Error('simulation_protocol_not_connected')
    options.record({ type: 'protocol-notice', event })
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
  }
  async function captureBytes(source: unknown, messageId: number, index: number, kind = 'file') {
    if (typeof source !== 'string') throw new Error('simulation_outbound_asset_invalid')
    let bytes: Buffer
    if (source.startsWith('base64://')) {
      const raw = source.slice(9)
      if (raw.length > 12 * 1024 * 1024) throw new Error('simulation_outbound_asset_too_large')
      bytes = Buffer.from(raw, 'base64')
      if (bytes.toString('base64') !== raw) throw new Error('simulation_outbound_base64_invalid')
    } else if (isAbsolute(source)) {
      const path = await realpath(source)
      if (!path.startsWith(options.directory + sep)) throw new Error('simulation_outbound_path_outside_run')
      const information = await lstat(path)
      if (!information.isFile() || information.size > 8 * 1024 * 1024) throw new Error('simulation_outbound_asset_invalid')
      bytes = await readFile(path)
    } else {
      const key = source.startsWith(endpoint + '/assets/') ? source.slice((endpoint + '/assets/').length) : source
      const known = assets.get(key)
      if (!known) throw new Error('simulation_outbound_asset_source_unsupported')
      bytes = known.bytes
    }
    if (bytes.length > 8 * 1024 * 1024) throw new Error('simulation_outbound_asset_too_large')
    const directory = join(options.directory, 'outbound-assets')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filename = join(directory, `${messageId}-${index}.bin`)
    await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' })
    const fileId = randomBytes(16).toString('hex')
    assets.set(fileId, { bytes, name: basename(filename), kind })
    return { filename, fileId, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  async function action(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    options.record({ type: 'protocol-action', action: name, params, source: 'simulation-fixture' })
    if (name === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: Number(options.selfId), nickname: '模拟机器人' } }
    if (name === 'get_status') return { status: 'ok', retcode: 0, data: { online: true, good: true } }
    if (name === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'qbf-simulation', protocol_version: 'v11' } }
    if (name === 'get_msg') {
      const message = messages.get(Number(params.message_id))
      return message ? { status: 'ok', retcode: 0, data: message } : { status: 'failed', retcode: 1404, data: null, message: 'simulation_message_not_found' }
    }
    if (name === 'get_forward_msg') {
      const nodes = forwards.get(String(params.id ?? params.message_id))
      return nodes ? { status: 'ok', retcode: 0, data: { messages: nodes } }
        : { status: 'failed', retcode: 1404, data: null, message: 'simulation_forward_not_found' }
    }
    if (['get_image', 'get_record', 'get_file', 'get_group_file_url', 'get_private_file_url'].includes(name)) {
      const key = String(params.file ?? params.file_id)
      const asset = assets.get(key)
      if (asset?.kind === 'video' && name === 'get_file') return { status: 'failed', retcode: 1400, data: null, message: 'simulation_video_requires_registered_url' }
      return asset ? { status: 'ok', retcode: 0, data: { file: key, file_name: asset.name, file_size: asset.bytes.length, url: `${endpoint}/assets/${key}` } }
        : { status: 'failed', retcode: 1404, data: null, message: 'simulation_asset_not_found' }
    }
    if (name === 'get_group_list') return { status: 'ok', retcode: 0, data: [{ group_id: Number(options.groupId), group_name: '本地模拟群', member_count: knownIds.size, max_member_count: knownIds.size }] }
    if (name === 'get_group_info') return String(params.group_id) === options.groupId
      ? { status: 'ok', retcode: 0, data: { group_id: Number(options.groupId), group_name: '本地模拟群', member_count: knownIds.size, max_member_count: knownIds.size } }
      : { status: 'failed', retcode: 1404, data: null, message: 'simulation_group_not_found' }
    if (name === 'get_group_msg_history' || name === 'get_friend_msg_history') {
      const count = typeof params.count === 'number' && Number.isSafeInteger(params.count) ? Math.min(100, Math.max(1, params.count)) : 10
      const history = [...messages.values()].filter(message => name === 'get_group_msg_history'
        ? String(message.group_id) === String(params.group_id)
        : message.message_type === 'private' && String(message.user_id === Number(options.selfId) ? message.target_id : message.user_id) === String(params.user_id))
      return { status: 'ok', retcode: 0, data: { messages: history.slice(-count) } }
    }
    if (name === 'get_friend_list') return { status: 'ok', retcode: 0, data: [options.ownerId, options.memberId].map(userId => ({ user_id: Number(userId), nickname: nickname(userId), remark: '' })) }
    if (['get_group_member_info', 'get_group_member_list', 'get_stranger_info'].includes(name)) {
      if (name !== 'get_stranger_info' && String(params.group_id) !== options.groupId
        || name !== 'get_group_member_list' && !knownIds.has(String(params.user_id))) {
        return { status: 'failed', retcode: 1404, data: null, message: 'simulation_member_not_found' }
      }
      const member = (userId: string) => ({ group_id: Number(options.groupId), user_id: Number(userId), nickname: nickname(userId), card: '', role: 'member', sex: 'unknown', age: 0, area: '', join_time: 1, last_sent_time: 1, level: '1', unfriendly: false, title: '', title_expire_time: 0, card_changeable: false })
      const requested = String(params.user_id)
      return { status: 'ok', retcode: 0, data: name === 'get_group_member_list' ? [...knownIds].map(member) : member(requested) }
    }
    if (name === 'fetch_custom_face_detail' || name === 'get_custom_face') return { status: 'ok', retcode: 0,
      data: [...assets].filter(([, asset]) => asset.kind === 'image').map(([key, asset]) => ({ emoji_id: key, desc: asset.name, url: `${endpoint}/assets/${key}` })) }
    if (name === 'group_poke' || name === 'friend_poke' || name === 'delete_msg') {
      if (name !== 'delete_msg' && (!knownIds.has(String(params.user_id))
        || name === 'group_poke' && String(params.group_id) !== options.groupId)) return { status: 'failed', retcode: 1404, data: null, message: 'simulation_poke_target_not_found' }
      if (name === 'delete_msg' && !messages.has(Number(params.message_id))) return { status: 'failed', retcode: 1404, data: null, message: 'simulation_message_not_found' }
      if (name === 'delete_msg') messages.delete(Number(params.message_id))
      sent++
      options.record({ type: 'outbound', action: name, params, deliveredTo: 'local-capture' })
      return { status: 'ok', retcode: 0, data: null }
    }
    if (allowedSends.has(name) || name === 'upload_group_file' || name === 'upload_private_file') {
      const targetId = params.group_id ?? params.user_id
      if (!/^[1-9][0-9]{0,14}$/.test(String(targetId)) || name.startsWith('upload_') && (typeof params.file !== 'string' || typeof params.name !== 'string')
        || name.includes('forward') && (!Array.isArray(params.messages) || params.messages.length < 1 || params.messages.length > 32)
        || allowedSends.has(name) && !name.includes('forward') && typeof params.message !== 'string' && !Array.isArray(params.message)) {
        return { status: 'failed', retcode: 1400, data: null, message: 'simulation_invalid_send_shape' }
      }
      const messageId = ++sequence
      const captured: Awaited<ReturnType<typeof captureBytes>>[] = []
      async function captureSegments(content: unknown): Promise<void> {
        if (!Array.isArray(content)) return
        for (const segment of content) {
          if (!isRecord(segment) || !isRecord(segment.data)
            || !['text', 'at', 'reply', 'face', 'image', 'record', 'file', 'mface', 'node'].includes(String(segment.type))) throw new Error('simulation_invalid_send_segment')
          if (segment.type === 'face' && !/^(0|[1-9][0-9]{0,4})$/.test(String(segment.data.id))) throw new Error('simulation_invalid_face_id')
          if (['image', 'record', 'file', 'mface'].includes(String(segment.type))) captured.push(await captureBytes(segment.data.file ?? segment.data.url, messageId, captured.length, String(segment.type)))
          if (segment.type === 'node') {
            if (!/^[1-9][0-9]{0,14}$/.test(String(segment.data.user_id ?? segment.data.uin)) || !Array.isArray(segment.data.content)
              || segment.data.content.length < 1 || segment.data.content.length > 64) throw new Error('simulation_invalid_forward_node')
            await captureSegments(segment.data.content)
          }
        }
      }
      try {
        if (name.startsWith('upload_')) captured.push(await captureBytes(params.file, messageId, 0))
        else await captureSegments(params.message ?? params.messages)
      } catch (error) {
        options.record({ type: 'outbound-asset-rejected', action: name, code: error instanceof Error ? error.message : 'simulation_capture_failed' })
        return { status: 'failed', retcode: 1400, data: null, message: 'simulation_asset_capture_failed' }
      }
      sent++
      let capturedIndex = 0
      function historySegments(value: unknown): unknown {
        if (!Array.isArray(value)) return value
        return value.map(segment => {
          if (!isRecord(segment) || !isRecord(segment.data)) return segment
          if (segment.type === 'node') return { ...segment, data: { ...segment.data, content: historySegments(segment.data.content) } }
          if (['image', 'record', 'file', 'mface'].includes(String(segment.type))) {
            const asset = captured[capturedIndex++]
            return asset ? { ...segment, data: { ...segment.data, file: asset.fileId, url: `${endpoint}/assets/${asset.fileId}` } } : segment
          }
          return segment
        })
      }
      const historyContent = historySegments(params.message ?? params.messages)
      const message = { message_id: messageId, user_id: Number(options.selfId), time: Math.floor(Date.now() / 1000),
        message_type: params.group_id === undefined ? 'private' : 'group',
        message: historyContent, raw_message: typeof params.message === 'string' ? params.message : '',
        sender: { user_id: Number(options.selfId), nickname: '模拟机器人' },
        ...(params.user_id === undefined ? {} : { target_id: params.user_id }),
        ...(params.group_id === undefined ? {} : { group_id: params.group_id }) }
      messages.set(messageId, message)
      if (name.includes('forward') && Array.isArray(historyContent)) forwards.set(String(messageId), historyContent.filter(isRecord))
      options.record({ type: 'outbound', action: name, params, messageId, capturedAssets: captured, deliveredTo: 'local-capture' })
      return { status: 'ok', retcode: 0, data: { message_id: messageId, ...(name.startsWith('upload_') ? { file_id: `simulation-file-${messageId}` } : {}),
        ...(name.includes('forward') ? { forward_id: String(messageId) } : {}) } }
    }
    options.record({ type: 'unsupported-protocol-action', action: name })
    return { status: 'failed', retcode: 1404, data: null, message: 'simulation_action_not_supported' }
  }
  const server = createServer(async (request, response) => {
    const assetKey = /^\/assets\/([a-f0-9]{32})$/.exec(request.url ?? '')?.[1]
    if (request.method === 'GET' && assetKey) {
      const asset = assets.get(assetKey)
      if (!asset) { response.writeHead(404).end(); return }
      const mime = asset.kind === 'image' ? (/\.jpe?g$/i.test(asset.name) ? 'image/jpeg' : /\.webp$/i.test(asset.name) ? 'image/webp' : 'image/png')
        : asset.kind === 'record' ? (/\.wav$/i.test(asset.name) ? 'audio/wav' : 'audio/mpeg') : asset.kind === 'video' ? 'video/mp4' : 'application/octet-stream'
      if (asset.kind === 'video') videoReads++
      options.record({ type: 'asset-read', assetKind: asset.kind, assetKey, name: asset.name, bytes: asset.bytes.length,
        sha256: createHash('sha256').update(asset.bytes).digest('hex'), source: 'simulation-fixture' })
      response.writeHead(200, { 'content-type': mime, 'content-length': asset.bytes.length }).end(asset.bytes)
      return
    }
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401).end(); return }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        size += bytes.length
        if (size > 12 * 1024 * 1024) { response.writeHead(413).end(); return }
        chunks.push(bytes)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (!isRecord(body)) throw new Error('invalid_protocol_request')
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const name = pathname === '/' ? body.action : pathname.slice(1)
      if (typeof name !== 'string') throw new Error('invalid_protocol_action')
      const params = pathname === '/' && isRecord(body.params) ? body.params : body
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await action(name, params)))
    } catch { if (!response.headersSent) response.writeHead(400).end() }
  })
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${secret}` || request.url !== '/events') { socket.destroy(); return }
    websocket.handleUpgrade(request, socket, head, connection => websocket.emit('connection', connection, request))
  })
  websocket.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    socket.on('message', async data => {
      try {
        const input: unknown = JSON.parse(data.toString())
        if (!isRecord(input) || typeof input.action !== 'string') return
        socket.send(JSON.stringify({ ...await action(input.action, isRecord(input.params) ? input.params : {}), echo: input.echo }))
      } catch { socket.close(1003) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('simulation_listener_missing')
  const endpoint = `http://127.0.0.1:${address.port}`
  const heartbeat = setInterval(() => {
    const event = JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: Number(options.selfId), post_type: 'meta_event',
      meta_event_type: 'heartbeat', status: { online: true, good: true }, interval: 5000 })
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(event)
  }, 5000)
  heartbeat.unref()
  return {
    endpoint,
    members,
    websocketEndpoint: `ws://127.0.0.1:${address.port}/events`, secret,
    sent: () => sent,
    registerAsset,
    videoReadCount: () => videoReads,
    registerForward,
    async registerForwardAssets(input: readonly SimulatedAsset[], nodes: readonly Record<string, unknown>[] = []) {
      if (input.length < 1 || input.length > 8 || nodes.length > 31) throw new Error('simulation_invalid_forward_assets')
      const content = await Promise.all(input.map(asset => registerAsset(asset.path, asset.kind)))
      return registerForward([...nodes, { type: 'node', data: { uin: options.memberId, name: '模拟群友',
        time: Math.floor(Date.now() / 1000), content } }])
    },
    async uploadGroupFile(actor: 'owner' | 'member', filename: string, input: { readonly busId?: number; readonly groupId?: string; readonly memberIndex?: number } = {}) {
      const senderId = sender(actor, input.memberIndex)
      const busId = input.busId ?? 102
      if (!Number.isSafeInteger(busId) || busId < 0 || input.groupId !== undefined && !/^[1-9][0-9]{0,14}$/.test(input.groupId))
        throw new Error('simulation_invalid_group_upload')
      const asset = await registerAsset(filename, 'file')
      const event = { time: Math.floor(Date.now() / 1000), self_id: Number(options.selfId), post_type: 'notice', notice_type: 'group_upload',
        group_id: Number(input.groupId ?? options.groupId), user_id: Number(senderId),
        file: { id: asset.data.file_id, name: asset.data.name, size: asset.data.size, busid: busId } }
      emitNotice(event)
      return { fileId: asset.data.file_id, size: asset.data.size }
    },
    poke(actor: 'owner' | 'member', input: { readonly kind?: 'group' | 'private'; readonly target?: 'self' | 'other'; readonly selfSender?: boolean; readonly memberIndex?: number } = {}) {
      const senderId = sender(actor, input.memberIndex)
      const event = { time: Math.floor(Date.now() / 1000), self_id: Number(options.selfId), post_type: 'notice',
        notice_type: 'notify', sub_type: 'poke', ...(input.kind === 'private' ? {} : { group_id: Number(options.groupId) }),
        user_id: Number(input.selfSender ? options.selfId : senderId),
        target_id: Number(input.target === 'other' ? actor === 'owner' ? options.memberId : options.ownerId : options.selfId) }
      emitNotice(event)
    },
    inject(input: SimulatedMessage) {
      if (![...sockets].some(socket => socket.readyState === WebSocket.OPEN)) throw new Error('simulation_protocol_not_connected')
      const senderId = sender(input.actor, input.memberIndex)
      const messageId = ++sequence
      const segments = [...(input.replyTo === undefined ? [] : [{ type: 'reply', data: { id: String(input.replyTo) } }]),
        ...(input.mention && input.kind === 'group' ? [{ type: 'at', data: { qq: options.selfId } }] : []),
        ...(input.segments ?? []), ...(input.text ? [{ type: 'text', data: { text: input.text } }] : [])]
      const event = { time: Math.floor(Date.now() / 1000), self_id: Number(options.selfId), post_type: 'message',
        message_type: input.kind, sub_type: input.kind === 'group' ? 'normal' : 'friend', message_id: messageId,
        user_id: Number(senderId), ...(input.kind === 'group' ? { group_id: Number(input.groupId ?? options.groupId) } : {}),
        message: segments, raw_message: input.text, font: 0,
        sender: { user_id: Number(senderId), nickname: nickname(senderId), card: '', role: 'member' } }
      messages.set(messageId, event)
      options.record({ type: 'inbound', messageId, actor: input.actor,
        ...(input.actor === 'member' ? { memberIndex: input.memberIndex ?? 1 } : {}), event })
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
      return messageId
    },
    async close() {
      clearInterval(heartbeat)
      for (const socket of sockets) socket.terminate()
      await new Promise<void>(resolve => websocket.close(() => resolve()))
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}
