import type { NativePackageDefinition } from './native-packages.ts'
import { createBuiltinPackageContent } from './native-package-content.ts'
import { STICKER_LIBRARY_CONFIGURATION } from './sticker-library-configuration.ts'
import { STICKER_SENDING_CONFIGURATION } from './sticker-sending-configuration.ts'

/** Background collection and local matching are distinct built-in mechanisms. */
export function createStickerPackages(service: { readonly stop: () => Promise<void> }): readonly NativePackageDefinition[] {
  const content = createBuiltinPackageContent(import.meta.url, ['./sticker-library', './native-sticker-send', './sticker-library-configuration',
    './sticker-sending-configuration', './sticker-dsh-selector', './sticker-semantic-refinement', './sticker-semantics', './sticker-matching', '../contracts/sticker-library', '../contracts/sticker-sending'])
  return [{ content, configurations: [STICKER_LIBRARY_CONFIGURATION],
    manifest: { schema: 1, id: 'sticker-library', version: '1.0.0', dependencies: ['media'], provides: [], requires: [], contributions: [],
      displayName: '表情收藏', description: '用独立绑定会话筛选、打标和收藏表情，统一管理账号与额外存储。' },
    install(context) { context.own('task', 'collection-and-index', () => service.stop()) } },
  { content, configurations: [STICKER_SENDING_CONFIGURATION], manifest: { schema: 1, id: 'sticker-sending', version: '1.0.0', dependencies: ['sticker-library'], provides: [], requires: [], contributions: [],
    displayName: '表情发送', description: '本地标注检索与可配置的独立DSH筛选，回执静默结束，不续聊。' } }]
}
