import { createBuiltinPackageContent } from './native-package-content.ts'
import { FrameworkError } from '../core/values.ts'
import type { EffectAdapter } from '../core/types.ts'
import type { NativePackageDefinition } from './native-packages.ts'
import { CHAT_INPUT_CONFIGURATION_CONTRIBUTION, readChatInputConfiguration } from './chat-input-configuration.ts'
import type { createNativeMediaRegistry } from './native-media.ts'
import type { NativeReminderService } from './native-reminders.ts'
import type { NativeMemoryService } from './native-memory.ts'

const BUILTIN_CONTENT = createBuiltinPackageContent(import.meta.url)
const CHAT_INPUT_CONTENT = createBuiltinPackageContent(import.meta.url, ['./chat-input-configuration', '../contracts/chat-input-configuration'])

export interface NativeChatInputPackageService {
  read(conversationId: string, personaName?: string): ReturnType<typeof readChatInputConfiguration>
}
export type NativeMediaPackageService = ReturnType<typeof createNativeMediaRegistry>

/** This package reads its own CAS configuration on each input and never grants access. */
export function createChatInputNativePackage(options: { readonly directory: string }): NativePackageDefinition {
  return Object.freeze({
    content: CHAT_INPUT_CONTENT,
    manifest: { schema: 1, id: 'chat-input', version: '1.0.0', dependencies: [],
      provides: [{ id: 'chat-input', version: 1 }], requires: [],
      contributions: [{ kind: 'input-provider', id: 'chat-input' }] },
    configurations: [CHAT_INPUT_CONFIGURATION_CONTRIBUTION],
    install(context) {
      const service = Object.freeze<NativeChatInputPackageService>({ async read(conversationId, personaName) {
        context.signal.throwIfAborted()
        const result = await readChatInputConfiguration(options.directory, conversationId, personaName)
        context.signal.throwIfAborted()
        return result
      } })
      context.publish('chat-input', 1, service)
      context.contribute('input-provider', 'chat-input', service)
    }
  } satisfies NativePackageDefinition)
}

/** The host keeps existing media facts and policy; the package owns only guarded service/effect registrations. */
export function createMediaNativePackage(options: { readonly registry: NativeMediaPackageService }): NativePackageDefinition {
  return Object.freeze({
    content: BUILTIN_CONTENT,
    manifest: { schema: 1, id: 'media', version: '1.0.0', dependencies: [],
      provides: [{ id: 'media', version: 1 }], requires: [],
      contributions: [{ kind: 'effect', id: 'media.inspect' }, { kind: 'effect', id: 'media.read' }] },
    install(context) {
      const registry = options.registry
      function effect(adapter: EffectAdapter): EffectAdapter {
        return Object.freeze<EffectAdapter>({ execute(request) {
          if (context.signal.aborted) return Promise.reject(new FrameworkError('NATIVE_PACKAGE_STOPPED', 'The media package has stopped.'))
          return adapter.execute({ ...request, signal: AbortSignal.any([request.signal, context.signal]) })
        } })
      }
      const service: NativeMediaPackageService = Object.freeze({
        register(asset, signal) { return registry.register(asset, AbortSignal.any([signal, context.signal])) },
        resolveOutgoing(request) { return registry.resolveOutgoing({ ...request, signal: AbortSignal.any([request.signal, context.signal]) }) },
        inspect: effect(registry.inspect), read: effect(registry.read)
      })
      context.publish('media', 1, service)
      context.contribute('effect', 'media.inspect', service.inspect)
      context.contribute('effect', 'media.read', service.read)
    }
  } satisfies NativePackageDefinition)
}

/** The host starts the scheduler after its current guard is ready; package disposal always stops it. */
export function createRemindersNativePackage(options: { readonly service: NativeReminderService }): NativePackageDefinition {
  const effects = Object.keys(options.service.effects)
  return Object.freeze({
    content: BUILTIN_CONTENT,
    manifest: { schema: 1, id: 'reminders', version: '1.0.0', dependencies: [],
      provides: [{ id: 'reminders', version: 1 }], requires: [], contributions: [
        { kind: 'feature', id: 'reminder' }, { kind: 'event-validator', id: 'reminder.due' },
        ...effects.map(id => ({ kind: 'effect' as const, id })) ] },
    install(context) {
      context.publish('reminders', 1, options.service)
      context.contribute('feature', 'reminder', options.service.feature)
      context.contribute('event-validator', 'reminder.due', options.service.eventValidators['reminder.due'])
      for (const id of effects) context.contribute('effect', id, options.service.effects[id])
      context.own('task', 'reminder-scheduler', () => options.service.stop())
    }
  } satisfies NativePackageDefinition)
}

export type NativeMemoryPackageService = Pick<NativeMemoryService, 'query' | 'context' | 'propose'>

/** Packages may retrieve sourced data or propose a note; owner confirmation remains a separate host operation. */
export function createMemoryNativePackage(options: { readonly service: NativeMemoryService }): NativePackageDefinition {
  return Object.freeze({
    content: BUILTIN_CONTENT,
    manifest: { schema: 1, id: 'memory', version: '1.0.0', dependencies: [],
      provides: [{ id: 'memory', version: 1 }], requires: [], contributions: [{ kind: 'input-provider', id: 'memory' }] },
    install(context) {
      const service = Object.freeze<NativeMemoryPackageService>({
        query(query, signal) { return options.service.query(query, AbortSignal.any([signal, context.signal])) },
        context(query, signal) { return options.service.context(query, AbortSignal.any([signal, context.signal])) },
        propose(input, source, signal) { return options.service.propose(input, source, AbortSignal.any([signal, context.signal])) }
      })
      context.publish('memory', 1, service)
      context.contribute('input-provider', 'memory', service)
    }
  } satisfies NativePackageDefinition)
}
