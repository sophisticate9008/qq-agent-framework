import { normalizeContent } from '../core/content.ts';
import { assert, identifier, snapshot } from '../core/values.ts';
import type { FrameworkEvent } from '../core/types.ts';
import type { AgentInputPreparation } from './bridge.ts';
import { json } from './data.ts';

export interface AgentInputProvider extends AgentInputPreparation {
  readonly id: string;
  readonly order?: number;
}

/** Compose trusted input providers without allowing them to replace the event's source identity. */
export function composeAgentInputPreparation(providers: readonly AgentInputProvider[]): AgentInputPreparation {
  assert(Array.isArray(providers) && providers.length <= 32, 'INVALID_INPUT_PROVIDERS', 'Input providers must be bounded.');
  const names = new Set<string>();
  const ordered = providers.map(provider => {
    assert(identifier(provider.id) && !names.has(provider.id) && typeof provider.prepare === 'function'
      && (provider.order === undefined || Number.isSafeInteger(provider.order))
      && Array.isArray(provider.capabilities) && provider.capabilities.length <= 32
      && provider.capabilities.every(identifier) && new Set(provider.capabilities).size === provider.capabilities.length,
    'INVALID_INPUT_PROVIDERS', 'Input providers require unique identities, order and declared capabilities.');
    names.add(provider.id);
    return Object.freeze({ id: provider.id, order: provider.order ?? 0, prepare: provider.prepare,
      capabilities: Object.freeze([...provider.capabilities]) });
  }).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const capabilities = Object.freeze([...new Set(ordered.flatMap(provider => provider.capabilities))]);
  assert(capabilities.length <= 32, 'INVALID_INPUT_PROVIDERS', 'Combined input capabilities must be bounded.');
  return Object.freeze({ capabilities, async prepare(execution: Parameters<AgentInputPreparation['prepare']>[0], event: FrameworkEvent) {
    const source = snapshot(event);
    let content = normalizeContent(source.data.content);
    for (const provider of ordered) {
      execution.signal.throwIfAborted();
      const current: FrameworkEvent = snapshot({ ...source, data: { ...source.data,
        content: json(content),
        text: content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') } });
      const prepared = await provider.prepare(execution, current);
      execution.signal.throwIfAborted();
      if (prepared === null) return null;
      content = normalizeContent(prepared);
    }
    return content;
  } });
}
