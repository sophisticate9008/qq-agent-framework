import { NATIVE_MEDIA_CONFIGURATION } from './native-media-configuration.ts'
import { STICKER_LIBRARY_CONFIGURATION } from './sticker-library-configuration.ts'
import { NATIVE_OUTPUT_CONFIGURATION } from './native-output.ts'
import { createPackageConfigurationRegistry, type PackageConfigurationContribution } from './package-configuration.ts'
import { createPackageConfigurationFileStore } from '../storage/package-configuration.ts'

/** Management declarations exist before any package lifecycle or runtime is started. */
export function createNativePackageConfigurationRegistry(options: {
  readonly directory: string
  readonly contributions?: readonly PackageConfigurationContribution[]
}) {
  return createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(options.directory),
    contributions: [NATIVE_OUTPUT_CONFIGURATION, NATIVE_MEDIA_CONFIGURATION, STICKER_LIBRARY_CONFIGURATION, ...(options.contributions ?? [])] })
}
