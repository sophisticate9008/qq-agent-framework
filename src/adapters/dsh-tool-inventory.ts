import { parseNativeToolInventory, type NativeToolInventory } from '../contracts/native-tool-inventory.ts'
import type { DshBridgePluginPort } from './dsh-tool-scope.ts'

export function unavailableToolInventory(reason: string, state: 'not-connected' | 'unavailable' = 'unavailable'): NativeToolInventory {
  return { schema: 1, state, items: [], sources: [], limited: false, missingReasons: [reason], externalToolAuthorizationVerified: false }
}
export async function readDshToolInventory(port: DshBridgePluginPort | undefined, signal: AbortSignal): Promise<NativeToolInventory> {
  signal.throwIfAborted()
  if (!port) return unavailableToolInventory('tool_inventory_plugin_unavailable')
  try {
    const description = await port.describe(signal)
    if (!description.methods?.includes('bridgePlugin/inspectToolInventory') || !port.inspectToolInventory) {
      return unavailableToolInventory('tool_inventory_plugin_upgrade_required')
    }
    return parseNativeToolInventory(await port.inspectToolInventory(description.issuerEpoch, signal))
  } catch {
    signal.throwIfAborted()
    return unavailableToolInventory('tool_inventory_read_failed')
  }
}
