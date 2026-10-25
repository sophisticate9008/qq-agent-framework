import type { NativeToolPermissionRuntime } from '../contracts/native-tool-permissions.ts';
import { assert, FrameworkError } from '../core/values.ts';
import type { createBridgeHost } from './bridge.ts';
import { createNativeToolPermissionsRepository } from './native-tool-permissions.ts';

const prefix = 'native-framework-tool:';
/** Configuration grants are immutable identities; synchronization never refills or reactivates a policy grant. */
export function createNativeToolPolicy(options: {
  readonly directory: string;
  readonly currentHost: () => ReturnType<typeof createBridgeHost> | undefined;
  readonly available: () => boolean;
  readonly signal: () => AbortSignal | undefined;
}) {
  const repository = createNativeToolPermissionsRepository(options.directory);
  let appliedRevision: string | null = null;
  let appliedHost: ReturnType<typeof createBridgeHost> | undefined;
  let failed = false;
  let operation: Promise<void> = Promise.resolve();
  async function synchronize(signal: AbortSignal) {
    signal.throwIfAborted();
    const host = options.currentHost();
    const generation = options.signal();
    if (!host || !generation || generation.aborted || !options.available()) return;
    const document = await repository.read();
    signal.throwIfAborted();
    if (options.currentHost() !== host || options.signal() !== generation || generation.aborted || !options.available())
      throw new FrameworkError('TOOL_POLICY_GENERATION_CHANGED', 'Tool policy belongs to a different runtime generation.');
    const previous = host.policy.describe().grants;
    const expected = new Map(document.configuration.grants.map(grant => [prefix + grant.id, grant]));
    for (const grant of previous) {
      if (!grant.id.startsWith(prefix)) continue;
      const configured = expected.get(grant.id);
      if (!configured || configured.revokedAt !== null || configured.expiresAt !== null && configured.expiresAt <= Date.now()) {
        if (grant.active) host.policy.revoke(grant.id);
        continue;
      }
      assert(grant.featureId === 'framework-tools' && grant.conversationId === configured.conversationId
        && grant.expiresAt === configured.expiresAt && grant.capabilities.length === configured.capabilities.length
        && grant.capabilities.every(capability => configured.capabilities.some(item => item === capability)
          && grant.maxUses[capability] === configured.maxUses[capability as keyof typeof configured.maxUses]),
      'TOOL_POLICY_IDENTITY_CONFLICT', 'An existing grant cannot change target, capability, expiry or budget.');
    }
    const known = new Set(previous.map(grant => grant.id));
    for (const [id, grant] of expected) {
      if (known.has(id) || grant.revokedAt !== null || grant.expiresAt !== null && grant.expiresAt <= Date.now()) continue;
      host.policy.grant({ ...(host.accountScope ? { accountScope: host.accountScope } : {}), id, featureId: 'framework-tools', conversationId: grant.conversationId,
        capabilities: [...grant.capabilities], maxUses: grant.maxUses, expiresAt: grant.expiresAt });
    }
    appliedRevision = document.revision;
    appliedHost = host;
  }
  return Object.freeze({
    sync(signal: AbortSignal): Promise<void> {
      const current = operation.catch(() => undefined).then(() => synchronize(signal));
      operation = current.then(() => { failed = false; }, error => { failed = true; throw error; });
      void operation.catch(() => undefined);
      return operation;
    },
    status(revision: string): NativeToolPermissionRuntime {
      if (!options.available() || !options.currentHost() || options.signal()?.aborted !== false)
        return { state: 'not-running', appliedRevision: null };
      const current = appliedHost === options.currentHost() ? appliedRevision : null;
      return { state: failed ? 'unknown' : current === revision ? 'applied' : 'pending', appliedRevision: current };
    },
    async drain() { await operation.catch(() => undefined); }
  });
}
