import { parseStickerLibrarySnapshot, parseStickerLibraryThumbnail, parseStickerLibraryDeleteResult, type StickerLibrarySnapshot } from '../contracts/sticker-library.ts'
import { isRecord, errorCode } from '../core/values.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

interface StickerLibraryManager {
  snapshot(signal: AbortSignal): Promise<unknown>
  thumbnail(id: string, signal: AbortSignal): Promise<unknown>
  remove(id: string, revision: number, operationId: string, signal: AbortSignal): Promise<unknown>
}
const MAX_LIBRARY_RESPONSE_BYTES = 4 * 1024 * 1024
function boundSnapshot(value: StickerLibrarySnapshot): StickerLibrarySnapshot {
  let bytes = Buffer.byteLength(JSON.stringify({ ...value, items: [] }))
  for (let index = 0; index < value.items.length; index++) {
    bytes += Buffer.byteLength(JSON.stringify(value.items[index])) + (index > 0 ? 1 : 0)
    if (bytes > MAX_LIBRARY_RESPONSE_BYTES) return { ...value, items: value.items.slice(0, index), limited: true }
  }
  return value
}
export function createStickerLibraryRoutes(runtime: { stickerLibrary(): StickerLibraryManager | undefined }): readonly AdminRoute[] {
  function service() {
    const library = runtime.stickerLibrary()
    if (!library) throw new AdminRequestError(503, 'runtime_not_connected')
    return library
  }
  function failed(error: unknown): never {
    if (error instanceof AdminRequestError) throw error
    const code = errorCode(error, 'STICKER_LIBRARY_UNAVAILABLE')
    throw new AdminRequestError(/CONFLICT/.test(code) ? 409 : /NOT_FOUND/.test(code) ? 404 : /INVALID/.test(code) ? 400 : 503, code.toLowerCase())
  }
  return [{ method: 'GET', pathname: '/api/chat/stickers/library', maxResponseBytes: MAX_LIBRARY_RESPONSE_BYTES,
    async handle({ query, signal }) {
      if (query.size) throw new AdminRequestError(400, 'invalid_sticker_query')
      try {
        const value = parseStickerLibrarySnapshot(await service().snapshot(signal))
        if (!value) throw new AdminRequestError(503, 'sticker_library_invalid_response')
        return boundSnapshot(value)
      } catch (error) { failed(error) }
    } },
  { method: 'GET', pathname: '/api/chat/stickers/preview', maxResponseBytes: 256 * 1024,
    async handle({ query, signal }) {
      const id = query.get('id')
      if (query.size !== 1 || query.getAll('id').length !== 1 || !id || !/^[a-f0-9]{64}$/.test(id)) throw new AdminRequestError(400, 'invalid_sticker_query')
      try {
        const value = parseStickerLibraryThumbnail(await service().thumbnail(id, signal))
        if (!value) throw new AdminRequestError(503, 'sticker_library_invalid_preview')
        return value
      } catch (error) { failed(error) }
    } },
  { method: 'POST', pathname: '/api/chat/stickers/delete', maxRequestBytes: 1024,
    async handle({ query, body, signal }) {
      if (query.size || !isRecord(body) || Object.keys(body).length !== 3 || typeof body.id !== 'string'
        || !/^[a-f0-9]{64}$/.test(body.id) || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1
        || typeof body.operationId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.operationId)) throw new AdminRequestError(400, 'invalid_sticker_delete')
      try {
        const value = parseStickerLibraryDeleteResult(await service().remove(body.id, body.revision, body.operationId, signal))
        if (!value) throw new AdminRequestError(503, 'sticker_delete_result_unknown')
        return value
      } catch (error) { failed(error) }
    } }]
}
