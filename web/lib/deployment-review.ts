import { parsePublicNativeDeploymentReconciliationResult } from '../../src/contracts/native-deployment.ts';
export { parsePublicNativeDeploymentReconciliationResult as parsePublicDeploymentReconciliation } from '../../src/contracts/native-deployment.ts';

export function verifiedManualDeploymentReview(value: unknown): boolean {
  const result = parsePublicNativeDeploymentReconciliationResult(value);
  return result !== null && result.verified && result.missingReasons.length === 0 && result.presets.length > 0
    && result.verificationScope === 'provider-preset-and-managed-file-provenance'
    && result.unverified.length === 1 && result.unverified[0] === 'credential_loaded_value_identity';
}
