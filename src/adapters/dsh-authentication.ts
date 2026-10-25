import type { DshJsonRpcOptions } from './dsh-jsonrpc.ts'
import { createLocalDshAuthenticationProvider } from './dsh-local-auth.ts'

export function createDshAuthenticationOptions(configuration: {
  readonly endpoint: string
  readonly auth: string
  readonly localCredentialsPath?: string
}): Pick<DshJsonRpcOptions, 'auth' | 'authenticationProvider'> {
  return configuration.localCredentialsPath
    ? { auth: '', authenticationProvider: createLocalDshAuthenticationProvider({
      endpoint: configuration.endpoint, credentialsPath: configuration.localCredentialsPath
    }) }
    : { auth: configuration.auth }
}
