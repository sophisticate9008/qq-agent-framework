import { NATIVE_OUTPUT_CONFIGURATION } from './native-output.ts'
import { CHAT_INPUT_CONFIGURATION_CONTRIBUTION } from './chat-input-configuration.ts'
import { createPackageConfigurationRegistry, type PackageConfigurationContribution } from './package-configuration.ts'
import { createPackageConfigurationFileStore } from '../storage/package-configuration.ts'

/** Management declarations exist before any package lifecycle or runtime is started. */
export function createNativePackageConfigurationRegistry(options: {
  readonly directory: string
  readonly contributions?: readonly PackageConfigurationContribution[]
}) {
  return createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(options.directory),
    contributions: [CHAT_INPUT_CONFIGURATION_CONTRIBUTION, NATIVE_OUTPUT_CONFIGURATION, ...(options.contributions ?? [])] })
}
