import type { PluginModelSelection } from '../../src/contracts/plugin-model.ts'
import type { ImageGenerationService } from '../../src/contracts/image-generation.ts'
import type { PluginRuntimeServices } from '../../src/host/plugin-runtime.ts'
import type { DurableStore } from '../../src/contracts/ports.ts'

export interface DiaryConfiguration {
  readonly enabled: boolean
  readonly publish: boolean
  readonly timeZone: string
  readonly persona: string
  readonly model: PluginModelSelection
  readonly visionModel: PluginModelSelection
  readonly windows: readonly { readonly start: number; readonly end: number }[]
}
export interface DiaryMedia {
  save(id: string, image: Awaited<ReturnType<ImageGenerationService['generate']>>): Promise<{ readonly id: string; readonly protocolImage: string }>
  resolve?(id: string): Promise<{ readonly protocolImage: string }>
  prune?(retainedIds: readonly string[]): Promise<void>
}
export interface DiaryOptions {
  readonly store: DurableStore
  readonly runtime: PluginRuntimeServices
  readonly images: ImageGenerationService
  readonly media: DiaryMedia
  readonly configuration: () => DiaryConfiguration
  readonly signal: AbortSignal
  readonly clock?: () => number
  readonly random?: () => number
  readonly observe?: (event: { phase: string; day: string; slot?: number; attempt?: number; code?: string }) => void
}
export interface DiarySlot {
  index: number
  at: number
  until: number
  scene: string
  style: string
  state: 'scheduled' | 'generating' | 'reviewing' | 'publishing' | 'published' | 'preview' | 'skipped' | 'unknown'
  attempts: number
  caption?: string
  prompt?: string
  artifactId?: string
  protocolImage?: string
  review?: { acceptable: boolean; captionMatches: boolean; issues: string[]; correction: string }
  receipt?: string
  error?: string
}
export interface DiaryDay {
  date: string
  state: 'planning' | 'planned' | 'unknown'
  createdAt: number
  updatedAt: number
  slots: DiarySlot[]
}
