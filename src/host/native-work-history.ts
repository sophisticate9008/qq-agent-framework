import { parseNativeWorkView, type NativeWorkReadQuery, type NativeWorkView } from '../contracts/native-work.ts'
import type { DurableStore, StoredRecord } from './types.ts'
import { assert, isRecord, reference, snapshot } from '../core/values.ts'

const namespace = 'native-work.executions'
function projection(stored: StoredRecord): NativeWorkView {
  const value = stored.value
  assert(isRecord(value) && value.schema === 1 && value.id === stored.key,
    'INVALID_NATIVE_WORK_RECORD', 'The persisted work evidence cannot be interpreted safely.')
  const view = parseNativeWorkView({ id: stored.key, childId: value.childId, parentSessionId: value.parentSessionId,
    conversationId: value.conversationId, generation: value.generation, createdAt: value.createdAt, deadlineAt: value.deadlineAt,
    status: value.status, result: value.result ?? null, lateResult: value.lateResult ?? null,
    delivery: value.delivery ?? 'unavailable', lastError: value.lastError ?? null, resultId: value.resultId ?? null,
    deliveryId: value.deliveryId ?? null, deliveryMessageId: value.deliveryMessageId ?? null,
    deliveryError: value.deliveryError ?? null, deliveryFileId: value.deliveryFileId ?? null })
  assert(view !== null, 'INVALID_NATIVE_WORK_RECORD', 'The persisted work evidence cannot be interpreted safely.')
  return snapshot(view)
}

/** Reading historical work never instantiates an executor or reconciles interrupted actions. */
export function createNativeWorkHistoryReader(store: Pick<DurableStore, 'read' | 'list'>) {
  return Object.freeze({
    read(id: string): Readonly<NativeWorkView> | null {
      assert(reference(id), 'INVALID_NATIVE_WORK_INPUT', 'A bounded work identifier is required.')
      const stored = store.read(namespace, id)
      return stored ? projection(stored) : null
    },
    list(query: NativeWorkReadQuery = {}) {
      const limit = query.limit ?? 100
      assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000
        && (query.conversationId === undefined || reference(query.conversationId))
        && (query.after === undefined || reference(query.after)), 'INVALID_NATIVE_WORK_INPUT', 'Work listing needs bounded pagination.')
      const pageSize = Math.min(limit, 100)
      const batch = store.list(namespace, { limit: pageSize, ...(query.after === undefined ? {} : { after: query.after }) })
      const records: NativeWorkView[] = []
      let bytes = 0
      let consumed = 0
      for (const stored of batch) {
        const view = projection(stored)
        if (query.conversationId === undefined || view.conversationId === query.conversationId) {
          const size = Buffer.byteLength(JSON.stringify(view))
          if (records.length > 0 && bytes + size > 3 * 1024 * 1024) break
          records.push(view)
          bytes += size
        }
        consumed++
      }
      return snapshot({ records, next: consumed < batch.length || batch.length === pageSize ? batch[consumed - 1]!.key : null })
    }
  })
}
