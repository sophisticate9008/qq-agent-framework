import { isRecord } from './values.ts'

export type StickerSendingConfiguration = {
  readonly useAiSelection: boolean
  readonly dshSelectionTimeoutSeconds: number
}
export const DEFAULT_STICKER_SENDING_CONFIGURATION: StickerSendingConfiguration = Object.freeze({
  useAiSelection: true, dshSelectionTimeoutSeconds: 10,
})
export function validateStickerSendingConfiguration(value: unknown): StickerSendingConfiguration {
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.useAiSelection !== 'boolean'
    || !Number.isSafeInteger(value.dshSelectionTimeoutSeconds) || Number(value.dshSelectionTimeoutSeconds) < 1
    || Number(value.dshSelectionTimeoutSeconds) > 60) throw new TypeError('Invalid sticker sending configuration')
  return { useAiSelection: value.useAiSelection, dshSelectionTimeoutSeconds: Number(value.dshSelectionTimeoutSeconds) }
}
