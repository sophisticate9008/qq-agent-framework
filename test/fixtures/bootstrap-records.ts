import type { NativeBootstrapMetadata, NativeBootstrapState } from '../../src/host/native-bootstrap.ts';

export function bootstrapRuntimeRecord(state: NativeBootstrapState | 'not-started' = 'running', count = 3) {
  const metadata: NativeBootstrapMetadata = { manifest: { id: 'isolated-extension', version: '1.2.3', apiVersion: 1 },
    codeFingerprint: 'b'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true };
  if (state === 'not-started') return { state: 'stopped', bootstrap: { ...metadata, state } };
  const features = Array.from({ length: count }, (_, index) => ({ id: `isolated-feature-${index}`, version: '1.2.3',
    capabilities: ['messaging.send', 'presentation.prepare', 'isolated.schedule'], subscriptions: ['message.received', 'isolated.ready'] }));
  return { state: 'running', bootstrap: { ...metadata, state, pendingStart: false, pendingStop: false, features,
    effectCapabilities: ['presentation.prepare', 'isolated.schedule'], eventTypes: ['isolated.ready'],
    installedFeatureIds: features.map(feature => feature.id), grantsCreatedByInstaller: false, mediaResolver: true, forwardConfigured: true } };
}
