import { assert, isRecord } from '../core/values.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import type { NativeBootstrapHost } from './native-bootstrap.ts'
import type { DurableStore } from './types.ts'
import { digest, json } from './data.ts'
import { nativeAuthorizationMode, nativeWhitelistCapabilities } from './native-access.ts'

interface AccessGrantMap {
  schema: 1
  identity: string
  authorization: string
  execution: string
  access: string
  owner: string | null
  grants: Record<string, string>
}

const namespace = 'native-chat.access-grants'
const currentKey = 'current'
const permitted = (configuration: NativeChatConfiguration, scope: string) => configuration.access.allow.includes(scope)
  && !configuration.access.deny.includes(scope)

function readMap(store: DurableStore): AccessGrantMap | null {
  const saved = store.read(namespace, currentKey)
  if (!saved) return null
  const value = saved.value
  assert(isRecord(value) && value.schema === 1 && typeof value.identity === 'string'
    && typeof value.authorization === 'string' && typeof value.execution === 'string' && typeof value.access === 'string'
    && (value.owner === null || typeof value.owner === 'string' && /^[1-9][0-9]{0,19}$/.test(value.owner))
    && isRecord(value.grants) && Object.keys(value.grants).length <= 1024
    && Object.entries(value.grants).every(([scope, id]) => /^(group|private):[1-9][0-9]{0,19}$/.test(scope)
      && typeof id === 'string' && /^native-chat-whitelist:[a-f0-9]{64}$/.test(id)),
  'NATIVE_CHAT_ACCESS_POLICY_INVALID', 'The access grant mapping is invalid.')
  return value as unknown as AccessGrantMap
}

function samePolicy(saved: AccessGrantMap, configuration: NativeChatConfiguration, identity: string): boolean {
  return saved.identity === identity && saved.authorization === digest(configuration.authorization)
    && saved.execution === configuration.revisions.execution
}

export function rememberNativeAccessGrants(store: DurableStore, configuration: NativeChatConfiguration,
  identity: string, grants: Readonly<Record<string, string>>) {
  if (nativeAuthorizationMode(configuration.authorization) !== 'whitelist') return
  const previous = store.read(namespace, currentKey)
  const value: AccessGrantMap = { schema: 1, identity, authorization: digest(configuration.authorization),
    execution: configuration.revisions.execution, access: configuration.revisions.access, owner: configuration.access.owner,
    grants: { ...grants } }
  if (previous && digest(previous.value) === digest(value)) return
  store.write(namespace, currentKey, json(value), { expectedRevision: previous?.revision ?? null })
}

export function restoredNativeAccessGrants(store: DurableStore, configuration: NativeChatConfiguration,
  identity: string, host?: NativeBootstrapHost): Readonly<Record<string, string>> | null {
  const saved = readMap(store)
  if (!saved || !samePolicy(saved, configuration, identity) || saved.owner !== configuration.access.owner) return null
  if (saved.access !== configuration.revisions.access) {
    assert(host, 'NATIVE_CHAT_ACCESS_RELOAD_REQUIRED', 'The saved access change requires policy reconciliation.')
    const previous: NativeChatConfiguration = { ...configuration,
      revisions: { ...configuration.revisions, access: saved.access },
      access: { owner: saved.owner, allow: Object.keys(saved.grants), deny: [] } }
    applyNativeAccessGrants({ store, host, previous, next: configuration, identity })
    return readMap(store)!.grants
  }
  assert(configuration.access.allow.filter(scope => permitted(configuration, scope)).every(scope => Object.hasOwn(saved.grants, scope))
    && Object.keys(saved.grants).every(scope => permitted(configuration, scope)),
  'NATIVE_CHAT_ACCESS_POLICY_INVALID', 'The access mapping does not match the saved rules.')
  return saved.grants
}

export function applyNativeAccessGrants(options: { store: DurableStore; host: NativeBootstrapHost;
  previous: NativeChatConfiguration; next: NativeChatConfiguration; identity: string }) {
  const { store, host, previous, next, identity } = options
  assert(nativeAuthorizationMode(previous.authorization) === 'whitelist'
    && nativeAuthorizationMode(next.authorization) === 'whitelist'
    && previous.access.owner === next.access.owner && digest(previous.authorization) === digest(next.authorization)
    && previous.revisions.execution === next.revisions.execution,
  'NATIVE_CHAT_ACCESS_RELOAD_REQUIRED', 'This access change requires a controlled reload.')
  const saved = readMap(store)
  assert(saved && samePolicy(saved, previous, identity) && saved.access === previous.revisions.access,
    'NATIVE_CHAT_ACCESS_POLICY_INVALID', 'The active access mapping could not be verified.')
  const grants: Record<string, string> = {}
  const mappingRevision = store.read(namespace, currentKey)!.revision
  for (const scope of next.access.allow) {
    if (!permitted(next, scope)) continue
    if (permitted(previous, scope)) {
      assert(Object.hasOwn(saved.grants, scope), 'NATIVE_CHAT_ACCESS_POLICY_INVALID', 'An existing access mapping is missing.')
      grants[scope] = saved.grants[scope]
      continue
    }
    const capabilities = nativeWhitelistCapabilities(next, scope)
    const id = `native-chat-whitelist:${digest([identity, digest(next.authorization), next.revisions.access,
      next.revisions.execution, scope, mappingRevision, 'live-access'])}`
    grants[scope] = id
    if (!store.read('policy.grants', id)) host.policy.grant({ ...(host.accountScope ? { accountScope: host.accountScope } : {}), id, featureId: 'agent-relay', conversationId: scope,
      capabilities: [...capabilities], maxUses: Object.fromEntries(capabilities.map(capability => [capability, null])), expiresAt: null })
  }
  for (const [scope, id] of Object.entries(saved.grants)) if (!permitted(next, scope)) host.policy.revoke(id)
  rememberNativeAccessGrants(store, next, identity, grants)
}
