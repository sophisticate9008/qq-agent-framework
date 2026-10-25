export interface NativePackageContentIdentity {
  readonly fingerprint: string
  readonly coverage: 'entry-only' | 'builtin-host-files' | 'package-tree-and-dependency-locks-v1'
  readonly files: number
}
export interface NativePackageContentManifest {
  readonly schema: 1
  readonly entry: string
  readonly dependencies: readonly { readonly specifier: string; readonly lockFile: string }[]
}
