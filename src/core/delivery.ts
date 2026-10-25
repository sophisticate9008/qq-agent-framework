import type { DeliveryReceipt, FileUploadReceipt, MessageDeliveryReceipt } from './types.ts'
import { isRecord, reference, snapshot } from './values.ts'

export function isConfirmedMessageReceipt(value: unknown): value is MessageDeliveryReceipt {
  return isRecord(value) && value.status === 'confirmed' && value.kind === undefined && reference(value.messageId)
}

export function isFileUploadReceipt(value: unknown): value is FileUploadReceipt {
  return isRecord(value) && value.status === 'confirmed' && value.kind === 'file-upload' && value.messageId === undefined
    && reference(value.fileId) && reference(value.name) && !/[/\\]/.test(value.name)
}

export function isConfirmedDeliveryReceipt(value: unknown): value is MessageDeliveryReceipt | FileUploadReceipt {
  return isConfirmedMessageReceipt(value) || isFileUploadReceipt(value)
}

/** File upload acknowledgements never identify a quotable QQ message. */
export function deliveryMessageId(value: unknown): string | null {
  return isConfirmedMessageReceipt(value) ? value.messageId : null
}

export function normalizeDeliveryReceipt(value: unknown): Readonly<DeliveryReceipt> {
  if (isConfirmedMessageReceipt(value)) return snapshot({ status: 'confirmed', messageId: value.messageId })
  if (isFileUploadReceipt(value)) return snapshot({ status: 'confirmed', kind: 'file-upload', fileId: value.fileId, name: value.name })
  return snapshot({ status: isRecord(value) && value.status === 'rejected' ? 'rejected' : 'unknown' })
}
