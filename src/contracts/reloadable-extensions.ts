export function reloadableExtensionErrorCode(error: unknown, fallback = 'EXTENSION_RELOAD_FAILED'): string {
  // A deployed host and a trusted source plugin can load different FrameworkError constructors.
  // Only this bounded namespace crosses that boundary; exception messages never do.
  try {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      const code: unknown = error.code
      if (typeof code === 'string' && /^EXTENSION_[A-Z_]{1,54}$/.test(code)) return code
    }
  } catch { /* An exception with a throwing accessor does not carry a usable error code. */ }
  return fallback
}

/** Public observations contain metadata only; plugin instances and source locations stay private. */
export interface ReloadableExtensionStatus {
  readonly id: string
  readonly displayName: string
  readonly currentRevision: string
  readonly activeCalls: number
  readonly retiring: { readonly revision: string; readonly activeCalls: number } | null
  readonly reloading: boolean
  readonly closed: boolean
  readonly error: string | null
}

export interface ReloadableExtensionResult {
  readonly id: string
  readonly previousRevision: string
  readonly currentRevision: string
  readonly changed: boolean
  readonly draining: boolean
}

/** Registration does not confer authorization. The caller checks policy before reload. */
export interface ReloadableExtensionRegistration {
  readonly id: string
  readonly displayName: string
  readonly reload: (signal?: AbortSignal) => Promise<ReloadableExtensionResult>
  readonly describe: () => ReloadableExtensionStatus
}

export interface ReloadableExtensionRegistry {
  register(extension: ReloadableExtensionRegistration): () => void
  list(): readonly ReloadableExtensionStatus[]
  reload(id: string, expectedRevision: string, signal?: AbortSignal): Promise<ReloadableExtensionResult>
}
