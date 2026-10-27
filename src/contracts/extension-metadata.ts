/** User-facing metadata is independent of stable identity and execution permissions. */
export interface ExtensionMetadata {
  readonly displayName?: string
  readonly description?: string
  /** Exact registered tool names owned by this extension; never grants execution access. */
  readonly toolNames?: readonly string[]
}

export function validExtensionMetadata(value: { readonly displayName?: unknown; readonly description?: unknown; readonly toolNames?: unknown }): boolean {
  return (value.displayName === undefined || validText(value.displayName, 80))
    && (value.description === undefined || validText(value.description, 500))
    && (value.toolNames === undefined || Array.isArray(value.toolNames) && value.toolNames.length <= 128
      && value.toolNames.every(name => typeof name === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(name))
      && new Set(value.toolNames).size === value.toolNames.length)
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export function extensionMetadata(value: ExtensionMetadata): ExtensionMetadata {
  return {
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.toolNames === undefined ? {} : { toolNames: [...value.toolNames] }),
  }
}
