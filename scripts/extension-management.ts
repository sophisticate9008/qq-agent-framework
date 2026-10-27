import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { gatewayAdminAddress, loadGatewayAdminConfiguration } from '../src/admin/gateway.ts'
import { NATIVE_REVISION_PATTERN } from '../src/contracts/native-revisions.ts'
import type { ReloadableExtensionStatus } from '../src/contracts/reloadable-extensions.ts'
import { identifier, isRecord } from '../src/core/values.ts'

export class ExtensionManagementError extends Error {}

function fail(message: string): never { throw new ExtensionManagementError(message) }

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_REVISION_PATTERN.test(value)
}

function status(input: unknown): ReloadableExtensionStatus {
  if (!isRecord(input) || !identifier(input.id) || typeof input.displayName !== 'string'
    || input.displayName.trim().length === 0 || input.displayName.length > 80 || /[\x00-\x1f\x7f]/.test(input.displayName)
    || !validRevision(input.currentRevision) || !validCount(input.activeCalls)
    || typeof input.reloading !== 'boolean' || typeof input.closed !== 'boolean'
    || !(input.error === null || typeof input.error === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(input.error))
    || !(input.retiring === null || isRecord(input.retiring) && validRevision(input.retiring.revision)
      && validCount(input.retiring.activeCalls))) fail('插件状态响应无效。')
  return { id: input.id, displayName: input.displayName, currentRevision: input.currentRevision,
    activeCalls: input.activeCalls, retiring: input.retiring === null ? null
      : { revision: String(input.retiring.revision), activeCalls: Number(input.retiring.activeCalls) },
    reloading: input.reloading, closed: input.closed, error: input.error }
}

async function readToken(filename: string): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) !== 0
      || process.getuid && info.uid !== process.getuid()) fail('管理端令牌须为当前用户持有的私有普通文件。')
    const token = (await handle.readFile('utf8')).trim()
    if (token.length < 24 || /[\r\n]/.test(token)) fail('管理端令牌无效。')
    return token
  } finally { await handle.close() }
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) fail('管理服务未返回插件状态。')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 131_072) fail('插件状态响应超过容量。')
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof ExtensionManagementError) throw error
    fail('管理服务返回了无效的插件状态。')
  } finally { await reader.cancel().catch(() => {}) }
}

/** Credentials remain in memory; command arguments accept a registered id only. Writes never retry. */
export async function manageExtensions(root: string, argumentsList: readonly string[],
  output: (value: string) => void = console.log): Promise<void> {
  const listing = argumentsList.length === 0 || argumentsList.length === 1 && argumentsList[0] === 'list'
  const reloading = argumentsList.length === 2 && argumentsList[0] === 'reload' && identifier(argumentsList[1])
  if (!listing && !reloading) fail('用法：qqagent extensions [list] 或 qqagent extensions reload <插件标识>。')
  let configuration: ReturnType<typeof loadGatewayAdminConfiguration>
  let token: string
  try {
    configuration = loadGatewayAdminConfiguration(join(root, 'runtime/live/framework-admin.json'))
    token = await readToken(configuration.tokenFile)
  } catch (error) {
    if (error instanceof ExtensionManagementError) throw error
    fail('无法读取本机管理配置或令牌，请先完成管理端初始化。')
  }
  const endpoint = new URL('/api/chat/extensions/reload', gatewayAdminAddress(configuration))
  const request = async (body?: { id: string; expectedRevision: string }): Promise<unknown> => {
    let response: Response
    try {
      response = await fetch(endpoint, { method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json',
          origin: configuration.publicOrigin || endpoint.origin } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
        signal: AbortSignal.timeout(body ? 60_000 : 5_000) })
    } catch {
      fail(body ? '插件重载结果尚未确认；请运行 qqagent extensions 查询状态，勿自动重试。' : '无法连接本机管理服务。')
    }
    if (!response.ok) {
      let failureCode: string | undefined
      try {
        const failure = await readResponse(response)
        if (isRecord(failure) && typeof failure.error === 'string'
          && /^(?:extension_[a-z_]{1,54}|operation_unknown|handler_timeout|request_aborted|origin_forbidden)$/.test(failure.error)) {
          failureCode = failure.error
        }
      } catch { /* An invalid error body does not establish the result of a write. */ }
      if (failureCode === 'extension_contract_changed' || failureCode === 'extension_transport_changed') {
        fail('插件工具协议或传输装配已变化，需要完整应用插件；普通代码重载未切换当前实例。')
      }
      if (failureCode === 'extension_reload_limit') fail('插件已达到本进程的源码代次上限；请按需重启 framework-admin。')
      if (failureCode === 'extension_dispose_failed') fail('插件清理失败；请查询错误与排空状态，勿继续重载堆积实例。')
      if (failureCode === 'extension_reload_timeout' || failureCode === 'extension_reload_aborted'
        || failureCode === 'operation_unknown' || failureCode === 'handler_timeout' || failureCode === 'request_aborted') {
        fail('插件重载结果尚未确认；请运行 qqagent extensions 查询状态，勿自动重试。')
      }
      if (failureCode === 'origin_forbidden') fail('管理端同源校验失败；请核对本机管理配置中的 publicOrigin。')
      fail(response.status === 401 || response.status === 403 ? '管理端鉴权失败。'
        : response.status === 409 ? '插件版本已变化或仍在排空；请查询状态后再决定下一步。'
        : response.status === 404 ? '插件未登记或当前部署尚不支持重载。'
        : `插件操作未成功（HTTP ${response.status}）；请查询状态。`)
    }
    return readResponse(response)
  }
  const inventory = await request()
  if (!isRecord(inventory) || inventory.schema !== 1 || !Array.isArray(inventory.items)
    || inventory.items.length > 128) fail('插件目录响应无效。')
  const items = inventory.items.map(status)
  if (new Set(items.map(item => item.id)).size !== items.length) fail('插件目录包含重复标识。')
  if (listing) { output(JSON.stringify({ schema: 1, items }, null, 2)); return }
  const id = argumentsList[1]!
  const selected = items.find(item => item.id === id)
  if (!selected) fail('指定插件未登记；请先运行 qqagent extensions。')
  const result = await request({ id, expectedRevision: selected.currentRevision })
  if (!isRecord(result) || result.schema !== 1 || result.id !== id
    || result.previousRevision !== selected.currentRevision || !validRevision(result.currentRevision)
    || result.changed !== (result.currentRevision !== selected.currentRevision) || typeof result.draining !== 'boolean') {
    fail('重载响应未能核验；请查询插件状态，勿自动重试。')
  }
  output(JSON.stringify({ schema: 1, id, previousRevision: selected.currentRevision,
    currentRevision: result.currentRevision, changed: result.changed, draining: result.draining }, null, 2))
}
