import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { parseDocument } from 'yaml'
import { createNativeDshDeploymentRuntime } from '../src/adapters/dsh-profile-deployment.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import type { ChatCapabilityApprovalRequest, ChatCapabilityCompositionApproval } from '../src/host/chat-capabilities.ts'
import { DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-profile-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, '.credentials.yaml')
  const basePath = join(directory, 'base.patch.yml')
  const base = [
    '- insert:', '    - id: llm-pi-ai', "      name: '@deepseek-ai/dsh-llm-pi-ai'", '      config:', '        providers:',
    '          unrelated:', '            apiKeyEnv: UNRELATED_KEY', '    - id: unrelated-runtime', '      name: unrelated-plugin',
    '      disabled: !!js process.platform === "win32"', '',
    '    - id: credentials-local', "      name: '@deepseek-ai/dsh-credentials-local'", '      config:', `        path: ${credentialsPath}`, '',
  ].join('\n')
  await writeFile(basePath, base, { mode: 0o600 })
  await writeFile(profilePath, '# operator comment\n[]\n', { mode: 0o600 })
  await writeFile(credentialsPath, 'version: 1\nrefs:\n  UNRELATED_KEY: private-unrelated-key\nrecords: {}\nforeign: keep-me\n', { mode: 0o600 })
  await writeFile(join(directory, 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}\n', { mode: 0o600 })
  const calls: string[] = []
  const capabilityDocuments = new Map<string, string>()
  let capabilityReadFailure = false
  let tamperPlugins = false
  let loaded = true
  let tamper = false
  let credentialSource: string | null = 'file'
  let credentialPath = credentialsPath
  let credentialMissing = false
  let inMemoryCredentialValue: string | null = 'stale-fixture-value-never-returned'
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.cookie, 'operator=fixture')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const wire = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const method = String(wire.method)
      calls.push(method)
      const args = object(object(wire.payload).args)
      const patches = parseDocument(await readFile(profilePath, 'utf8')).toJS() as unknown
      assert(Array.isArray(patches))
      const providerPatch = patches.map(object).filter(row => row.id === 'llm-pi-ai').at(-1)
      const presets = patches.flatMap(value => {
        const row = object(value)
        return Array.isArray(row.insert) ? row.insert.map(object).filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset').map(entry => object(entry.config)) : []
      })
      let value: unknown
      if (method === 'settings/describe') {
        assert.deepEqual(args, {})
        value = { writable: true, hasDocument: true, namespaces: loaded && providerPatch ? [{
          ns: 'llm-pi-ai', value: tamper ? { providers: {} } : providerPatch.config,
        }, { ns: 'credentials-local', value: { path: credentialPath, watch: true } }] : [] }
      } else if (method === 'agentPresets/list') {
        assert.deepEqual(args, {})
        value = { presets: [...(loaded ? presets.map(config => ({ id: config.id, isDefault: false })) : []),
          ...[...capabilityDocuments.keys()].map(id => ({ id, isDefault: false }))] }
      } else if (method === 'agentPresets/read') {
        const config = presets.find(preset => preset.id === args.agentPreset)
        if (capabilityDocuments.has(String(args.agentPreset))) {
          if (capabilityReadFailure) throw new Error('Source unavailable')
          value = { agentPreset: args.agentPreset, content: capabilityDocuments.get(String(args.agentPreset)) }
        } else value = { agentPreset: args.agentPreset, content: JSON.stringify(tamperPlugins ? [] : config?.plugins ?? []) }
      } else if (method === 'credentials/describe') {
        assert(Array.isArray(args.refs))
        value = credentialMissing ? {} : Object.fromEntries(args.refs.map(ref => [ref, {
          configured: loaded && inMemoryCredentialValue !== null, writable: true, ...(credentialSource === null ? {} : { source: credentialSource }),
        }]))
      } else throw new Error('Unexpected model or session operation')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: wire.rpcId, result: { ok: true, value } }))
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const configuration: NativeChatConfiguration = {
    execution: DEFAULT_NATIVE_EXECUTION_POLICY,
    revisions: { deployment: 'd1', plans: 'p1' },
    catalog: { activePlanId: 'chat', plans: [{ id: 'chat', name: 'Chat', description: '', instructions: 'Concise helpful replies.',
      personaId: 'friend', provider: 'native-provider', model: 'model-1', reasoningEffort: 'off', contextLimits: { group: 128_000, private: 384_000 } }] },
    personas: [{ id: 'friend', name: 'Friend', identity: 'Friendly identity.', style: 'Warm style.' }],
    providers: [{ id: 'native-provider', name: 'Models', type: 'openai', baseUrl: 'https://models.example.test/v1', enabled: true,
      apiKey: 'private-model-fixture-key', models: [{ id: 'model-1', name: 'Model' }] }],
    deployment: { target: { profilePath, credentialsPath, layerPaths: [basePath], schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 512_000, maxTokens: 4096, reasoningEfforts: false }, namespace: 'qqbf' },
    adapters: {
      dshAgent: { enabled: true, endpoint: `http://127.0.0.1:${address.port}`, auth: 'cookie:operator=fixture' },
      onebotHttp: { enabled: false, endpoint: '', secret: '' }, onebotWs: { enabled: false, endpoint: '', secret: '' },
      onebotWebhook: { enabled: false, host: '127.0.0.1', port: 0, selfId: '', hmac: '' },
    },
    access: { allow: [], deny: [], owner: null }, authorization: { version: '1', grants: [] },
  }
  return { directory, configuration, profilePath, credentialsPath, basePath, calls, capabilityDocuments,
    capabilityReadFailure(value: boolean) { capabilityReadFailure = value }, tamperPlugins(value: boolean) { tamperPlugins = value },
    loaded(value: boolean) { loaded = value }, tamper(value: boolean) { tamper = value },
    source(value: string | null) { credentialSource = value }, credentialPath(value: string) { credentialPath = value },
    missingRef(value: boolean) { credentialMissing = value },
    memoryPresent(value: boolean) { inMemoryCredentialValue = value ? 'stale-fixture-value-never-returned' : null },
    memoryValue(value: string) { inMemoryCredentialValue = value } }
}

function runtime() {
  return createNativeDshDeploymentRuntime({ verificationTimeoutMs: 1_000, pollIntervalMs: 10 })
}

test('real profile callback previews, applies CAS backups and independently verifies live read-only APIs', async context => {
  const data = await fixture(context)
  const deployment = runtime()
  const before = await readFile(data.profilePath, 'utf8')
  const prepared = object(await deployment.prepare(data.configuration))
  assert.equal(prepared.state, 'prepared')
  assert.equal(await readFile(data.profilePath, 'utf8'), before)
  assert.equal(data.calls.length, 0)
  assert(!JSON.stringify(prepared).includes('private-model-fixture-key'))
  assert(!JSON.stringify(prepared).includes('private-unrelated-key'))
  const result = object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision)))
  assert.equal(result.state, 'verified')
  assert.equal(result.credentialValueIdentityVerified, false)
  assert.deepEqual(result.unverified, ['credential_loaded_value_identity'])
  const reconciled = await deployment.reconcile(data.configuration)
  assert.deepEqual(reconciled.missingReasons, [])
  assert.equal(reconciled.presetBindings.length, 2)
  assert.deepEqual(reconciled.presetBindings.map(binding => binding.conversationKind), ['group', 'private'])
  const profile = await readFile(data.profilePath, 'utf8')
  assert(profile.includes('# operator comment'))
  assert(!profile.includes('private-model-fixture-key'))
  assert((await readFile(data.basePath, 'utf8')).includes('!!js process.platform'))
  const credentials = object(parseDocument(await readFile(data.credentialsPath, 'utf8')).toJS() as unknown)
  assert.equal(object(credentials.refs).UNRELATED_KEY, 'private-unrelated-key')
  assert.equal(credentials.foreign, 'keep-me')
  const files = await readdir(data.directory)
  const backups = files.filter(file => file.includes('.qqbf-backup-'))
  assert.equal(backups.length, 2)
  for (const file of backups) assert.equal((await stat(join(data.directory, file))).mode & 0o777, 0o600)
  assert(!files.some(file => file.endsWith('.lock')))
  assert(data.calls.every(method => ['settings/describe', 'agentPresets/list', 'agentPresets/read', 'credentials/describe'].includes(method)))
  assert.equal(object(await deployment.apply(data.configuration, new AbortController().signal)).state, 'blocked')
})

test('profile application without loaded DSH state remains pending_reload and later reconciles without replay', async context => {
  const data = await fixture(context)
  data.loaded(false)
  const deployment = runtime()
  const prepared = object(await deployment.prepare(data.configuration))
  const result = object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision)))
  assert.equal(result.state, 'pending_reload')
  assert.equal(typeof result.backupId, 'string')
  const bytes = await readFile(data.profilePath, 'utf8')
  assert((await deployment.reconcile(data.configuration)).missingReasons.length > 0)
  data.loaded(true)
  assert.deepEqual((await deployment.reconcile(data.configuration)).missingReasons, [])
  assert.equal(await readFile(data.profilePath, 'utf8'), bytes)
  data.tamper(true)
  assert((await deployment.reconcile(data.configuration)).missingReasons.length > 0)
})

test('profile CAS includes both files and explicit layers and refuses stale previews without overwriting', async context => {
  const data = await fixture(context)
  for (const path of [data.profilePath, data.credentialsPath, data.basePath]) {
    const deployment = runtime()
    const prepared = object(await deployment.prepare(data.configuration))
    assert.equal(prepared.state, 'prepared')
    const before = await readFile(path, 'utf8')
    await writeFile(path, `${before}\n# independent edit\n`, { mode: 0o600 })
    assert.equal(object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision))).state, 'conflict')
    assert((await readFile(path, 'utf8')).endsWith('# independent edit\n'))
    assert(!(await readdir(data.directory)).some(file => file.includes('.qqbf-backup-')))
  }
})

test('profile callbacks preserve opaque expressions but never execute or overwrite unsafe YAML', async context => {
  const data = await fixture(context)
  await writeFile(data.profilePath, '- insert:\n    - id: operator-expression\n      name: arbitrary-plugin\n      disabled: !!js "throw new Error(\'never run\')"\n', { mode: 0o600 })
  const deployment = runtime()
  const prepared = object(await deployment.prepare(data.configuration))
  assert.equal(prepared.state, 'prepared')
  assert.equal(object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision))).state, 'verified')
  assert((await readFile(data.profilePath, 'utf8')).includes('!!js'))
  for (const text of [
    '- id: a\n  id: b\n', '- id: a\n  config: &anchor {a: 1}\n- id: b\n  config: *anchor\n',
    '- id: a\n  config: !exec malicious-private-value\n', '- id: llm-pi-ai\n  config: !!js process.env\n',
  ]) {
    await writeFile(data.profilePath, text, { mode: 0o600 })
    const result = object(await runtime().prepare(data.configuration))
    assert.equal(result.state, 'blocked')
    assert(!JSON.stringify(result).includes('malicious-private-value'))
    assert.equal(await readFile(data.profilePath, 'utf8'), text)
  }
})

test('explicit callback paths reject symlinks, unversioned keys, contention and changed native configuration', async context => {
  const data = await fixture(context)
  const deployment = runtime()
  const prepared = object(await deployment.prepare(data.configuration))
  await writeFile(join(data.directory, 'package.json.lock'), `${process.pid}\n`, { mode: 0o600 })
  assert.equal(object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision))).state, 'conflict')
  await rm(join(data.directory, 'package.json.lock'))
  await deployment.prepare(data.configuration)
  assert.equal(object(await deployment.apply({ ...data.configuration, revisions: { deployment: 'changed' } }, new AbortController().signal)).state, 'blocked')
  await writeFile(data.credentialsPath, 'OLD_PRIVATE_KEY: private-old-fixture-key\n', { mode: 0o600 })
  assert.equal(object(await runtime().prepare(data.configuration)).state, 'blocked')
  await rm(data.credentialsPath)
  const external = join(data.directory, 'other-credentials.yaml')
  await writeFile(external, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  await symlink(external, data.credentialsPath)
  assert.equal(object(await runtime().prepare(data.configuration)).state, 'blocked')
  assert.equal(await readFile(external, 'utf8'), 'version: 1\nrefs: {}\n')
})

test('an explicitly selected fresh profile creates missing files only on apply and records absence in backups', async context => {
  const data = await fixture(context)
  await rm(data.profilePath)
  await rm(data.credentialsPath)
  const deployment = runtime()
  const prepared = object(await deployment.prepare(data.configuration))
  assert.equal(prepared.state, 'prepared')
  assert(!(await readdir(data.directory)).includes('.credentials.yaml'))
  const applied = object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision)))
  assert.equal(applied.state, 'verified')
  assert.equal((await stat(data.credentialsPath)).mode & 0o777, 0o600)
  assert.equal(object(parseDocument(await readFile(data.credentialsPath, 'utf8')).toJS() as unknown).version, 1)
  assert.equal((await readdir(data.directory)).filter(file => file.endsWith('.absent')).length, 2)
})

test('file application requires the exact approved target revision even when another preview has identical native config', async context => {
  const data = await fixture(context)
  const deployment = runtime()
  const first = object(await deployment.prepare(data.configuration))
  await writeFile(data.profilePath, '# independent operator edit\n[]\n', { mode: 0o600 })
  const second = object(await deployment.prepare(data.configuration))
  assert.notEqual(first.targetRevision, second.targetRevision)
  const result = object(await deployment.apply(data.configuration, new AbortController().signal, String(first.targetRevision)))
  assert.equal(result.state, 'conflict')
  assert(!(await readdir(data.directory)).some(file => file.includes('.qqbf-backup-')))
  await deployment.prepare(data.configuration)
  assert.equal(object(await deployment.apply(data.configuration, new AbortController().signal)).state, 'conflict')
})

test('credential provenance accepts only the official managed file source and exact live target, never environment fallbacks', async context => {
  const data = await fixture(context)
  const deployment = runtime()
  const prepared = object(await deployment.prepare(data.configuration))
  const applied = object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision)))
  assert.equal(applied.state, 'verified')
  for (const source of ['env', 'project-env', 'user-env', 'local-file', null]) {
    data.source(source)
    const result = await deployment.reconcile(data.configuration)
    assert.deepEqual(result.presetBindings, [])
    assert(result.missingReasons.includes('dsh_credential_file_source_unverified'))
  }
  data.source('file')
  data.missingRef(true)
  assert((await deployment.reconcile(data.configuration)).missingReasons.includes('dsh_credential_file_source_unverified'))
  data.missingRef(false)
  data.credentialPath(join(data.directory, 'different-credentials.yaml'))
  assert((await deployment.reconcile(data.configuration)).missingReasons.includes('dsh_credential_target_unverified'))
  data.credentialPath(data.credentialsPath)
  data.memoryPresent(false)
  assert((await deployment.reconcile(data.configuration)).missingReasons.includes('dsh_credential_file_source_unverified'))
})

test('delayed credential watcher provenance stays pending until file source, and stale value identity always remains unverified', async context => {
  const data = await fixture(context)
  data.source('env')
  const deployment = runtime()
  const prepared = object(await deployment.prepare(data.configuration))
  const applied = object(await deployment.apply(data.configuration, new AbortController().signal, String(prepared.targetRevision)))
  assert.equal(applied.state, 'pending_reload')
  data.source('file')
  data.memoryValue('different-stale-memory-fixture-key')
  const reconciled = object(await deployment.reconcile(data.configuration))
  assert.deepEqual(reconciled.missingReasons, [])
  assert.equal(reconciled.verificationScope, 'provider-preset-and-managed-file-provenance')
  assert.equal(reconciled.credentialValueIdentityVerified, false)
  assert.deepEqual(reconciled.unverified, ['credential_loaded_value_identity'])
  assert(!JSON.stringify(reconciled).includes('private-model-fixture-key'))
  assert(!JSON.stringify(reconciled).includes('different-stale-memory-fixture-key'))
})

async function capabilityFixture(context: TestContext) {
  const data = await fixture(context)
  const content = JSON.stringify([{ id: 'operator-work', name: '@operator/mature-work', config: { mode: 'approved-declaration' } }])
  const capabilitySelection = { schema: 1 as const, presetId: 'operator-work',
    revision: createHash('sha256').update(JSON.stringify({ id: 'operator-work', content })).digest('hex') }
  data.capabilityDocuments.set('operator-work', content)
  const configuration: NativeChatConfiguration = { ...data.configuration,
    catalog: { ...data.configuration.catalog, plans: data.configuration.catalog.plans.map(plan => ({ ...plan, capabilitySelection })) } }
  let approval: ChatCapabilityCompositionApproval | null = null
  const requests: ChatCapabilityApprovalRequest[] = []
  const deployment = createNativeDshDeploymentRuntime({ verificationTimeoutMs: 1_000, pollIntervalMs: 10,
    async resolveCapabilityApproval(request) { requests.push(request); return approval } })
  const prepared = object(await deployment.prepare(configuration))
  assert.equal(prepared.state, 'prepared')
  const request = prepared.capabilityApprovalRequest as ChatCapabilityApprovalRequest
  assert.equal(request.schema, 1)
  assert.deepEqual(request.source, capabilitySelection)
  assert.deepEqual(request.target, { profilePath: data.profilePath, credentialsPath: data.credentialsPath,
    layerPaths: [data.basePath], schemaVersion: '0.2.1-rc.2' })
  assert.equal(requests.length, 0)
  return { ...data, configuration, deployment, prepared, request, requests,
    approve(change: Partial<ChatCapabilityCompositionApproval> = {}) {
      approval = { ...request, approvalId: 'operator-confirmed', authority: 'owner',
        externalTools: 'separate-runtime-authorization-required', ...change }
    },
    revoke() { approval = null },
  }
}

test('capability approved composition survives actual profile CAS, backups and live readback through the default deployment factory', async context => {
  const data = await capabilityFixture(context)
  const before = await readFile(data.profilePath, 'utf8')
  const preview = object(data.prepared.preview)
  const presets = preview.presets
  assert(Array.isArray(presets))
  assert(presets.every(preset => JSON.stringify(preset).includes('@operator/mature-work')))
  assert.equal(await readFile(data.profilePath, 'utf8'), before)
  data.approve()
  const result = object(await data.deployment.apply(data.configuration, new AbortController().signal, String(data.prepared.targetRevision)))
  assert.equal(result.state, 'verified')
  const reconciled = await data.deployment.reconcile(data.configuration)
  assert.deepEqual(reconciled.missingReasons, [])
  assert.equal(reconciled.presetBindings.length, 2)
  for (const binding of reconciled.presetBindings) assert.deepEqual(binding.definition.capabilitySelection, data.request.source)
  const again = object(await data.deployment.prepare(data.configuration))
  assert.deepEqual(again.capabilityApprovalRequest, data.request)
  assert.notEqual(again.targetRevision, data.prepared.targetRevision)
  assert.deepEqual(object(again.preview).presets, presets)
  const files = await readdir(data.directory)
  assert.equal(files.filter(filename => filename.includes('.qqbf-backup-')).length, 2)
  assert.equal(data.requests.length, 0)
  assert(data.calls.every(method => ['settings/describe', 'agentPresets/list', 'agentPresets/read', 'credentials/describe'].includes(method)))
  assert(!JSON.stringify(result).includes('private-model-fixture-key'))
  const written = await readFile(data.profilePath, 'utf8')
  data.tamperPlugins(true)
  assert.equal((await data.deployment.reconcile(data.configuration)).presetBindings.length, 0)
  data.tamperPlugins(false)
  data.revoke()
  assert.deepEqual((await data.deployment.reconcile(data.configuration)).missingReasons, [])
  assert.equal(await readFile(data.profilePath, 'utf8'), written)
})


test('capability source drift or unreadable metadata between preview and apply never writes or falls back to the base preset', async context => {
  for (const failure of ['drift', 'read', 'missing', 'ambiguous']) {
    const data = await capabilityFixture(context)
    data.approve()
    if (failure === 'drift') data.capabilityDocuments.set('operator-work', '[]')
    if (failure === 'read') data.capabilityReadFailure(true)
    if (failure === 'missing') data.capabilityDocuments.delete('operator-work')
    if (failure === 'ambiguous') data.capabilityDocuments.set('operator-work', '- id: a\n  id: b\n')
    const before = await readFile(data.profilePath, 'utf8')
    const result = object(await data.deployment.apply(data.configuration, new AbortController().signal, String(data.prepared.targetRevision)))
    assert.equal(result.state, 'blocked')
    assert.equal(await readFile(data.profilePath, 'utf8'), before)
    assert(!(await readdir(data.directory)).some(filename => filename.includes('.qqbf-backup-')))
    const reconciled = await data.deployment.reconcile(data.configuration)
    assert.equal(reconciled.presetBindings.length, 0)
  }
})

test('capability unknown write verification is not replayed and later reconciliation requires both approval and live composition', async context => {
  const data = await capabilityFixture(context)
  data.approve()
  data.loaded(false)
  const result = object(await data.deployment.apply(data.configuration, new AbortController().signal, String(data.prepared.targetRevision)))
  assert.equal(result.state, 'pending_reload')
  assert.equal(typeof result.backupId, 'string')
  const written = await readFile(data.profilePath, 'utf8')
  assert.equal(object(await data.deployment.apply(data.configuration, new AbortController().signal, String(data.prepared.targetRevision))).state, 'blocked')
  data.loaded(true)
  assert.deepEqual((await data.deployment.reconcile(data.configuration)).missingReasons, [])
  assert.equal(await readFile(data.profilePath, 'utf8'), written)
  assert.equal((await readdir(data.directory)).filter(filename => filename.includes('.qqbf-backup-')).length, 2)
})


test('whitelist configured selection applies and reconciles real profile without a resolver or fabricated approval', async context => {
  for (const resolver of ['absent', 'throwing', 'legacy'] as const) {
    const data = await capabilityFixture(context)
    const configuration: NativeChatConfiguration = { ...data.configuration,
      authorization: resolver === 'legacy' ? { version: 'legacy-profile', grants: [] } : { version: 'whitelist-profile', mode: 'whitelist', grants: [] } }
    const originalConfiguration = structuredClone(configuration)
    const originalFiles = (await readdir(data.directory)).sort()
    let resolverCalls = 0
    const deployment = createNativeDshDeploymentRuntime({ verificationTimeoutMs: 1_000, pollIntervalMs: 10,
      ...(resolver === 'throwing' ? { async resolveCapabilityApproval() {
        resolverCalls++
        throw new Error('Resolver must not be called for whitelist selection')
      } } : {}) })
    const prepared = object(await deployment.prepare(configuration))
    assert.equal(prepared.state, 'prepared')
    assert.deepEqual(object(prepared.capabilityApprovalRequest).source, data.request.source)
    const result = object(await deployment.apply(configuration, new AbortController().signal, String(prepared.targetRevision)))
    assert.equal(result.state, 'verified')
    assert.equal(result.credentialValueIdentityVerified, false)
    const reconciled = await deployment.reconcile(configuration)
    assert.deepEqual(reconciled.missingReasons, [])
    assert.equal(reconciled.presetBindings.length, 2)
    for (const binding of reconciled.presetBindings) assert.deepEqual(binding.definition.capabilitySelection, data.request.source)
    assert.deepEqual(configuration, originalConfiguration)
    assert(!Object.hasOwn(configuration.deployment, 'capabilityApproval'))
    assert.equal(resolverCalls, 0)
    assert.equal(data.requests.length, 0)
    const files = await readdir(data.directory)
    assert.deepEqual(files.filter(filename => !filename.includes('.qqbf-backup-')).sort(), originalFiles)
    assert.equal(files.filter(filename => filename.includes('.qqbf-backup-')).length, 2)
    const profile = await readFile(data.profilePath, 'utf8')
    assert(profile.includes('@operator/mature-work'))
    for (const key of ['authority:', 'approvalId:', 'capabilityApproval:']) assert(!profile.includes(key))
    assert(data.calls.includes('settings/describe') && data.calls.includes('agentPresets/read') && data.calls.includes('credentials/describe'))
    assert(data.calls.every(method => ['settings/describe', 'agentPresets/list', 'agentPresets/read', 'credentials/describe'].includes(method)))
    data.tamperPlugins(true)
    assert.equal((await deployment.reconcile(configuration)).presetBindings.length, 0)
    data.tamperPlugins(false)
    assert.deepEqual((await deployment.reconcile(configuration)).missingReasons, [])
    assert.equal(await readFile(data.profilePath, 'utf8'), profile)
    assert.equal(resolverCalls, 0)
  }
})

test('whitelist configured selection still rejects source drift or unreadable source before any profile write', async context => {
  for (const failure of ['drift', 'read', 'missing', 'ambiguous'] as const) {
    const data = await capabilityFixture(context)
    const configuration: NativeChatConfiguration = { ...data.configuration,
      authorization: { version: 'whitelist-profile', mode: 'whitelist', grants: [] } }
    const deployment = runtime()
    const prepared = object(await deployment.prepare(configuration))
    assert.equal(prepared.state, 'prepared')
    const profile = await readFile(data.profilePath, 'utf8')
    const credentials = await readFile(data.credentialsPath, 'utf8')
    if (failure === 'drift') data.capabilityDocuments.set('operator-work', '[]')
    if (failure === 'read') data.capabilityReadFailure(true)
    if (failure === 'missing') data.capabilityDocuments.delete('operator-work')
    if (failure === 'ambiguous') data.capabilityDocuments.set('operator-work', '- id: a\n  id: b\n')
    const result = object(await deployment.apply(configuration, new AbortController().signal, String(prepared.targetRevision)))
    assert.equal(result.state, 'blocked')
    assert.deepEqual(result.missingReasons, ['capability_source_unverified'])
    assert.equal(await readFile(data.profilePath, 'utf8'), profile)
    assert.equal(await readFile(data.credentialsPath, 'utf8'), credentials)
    assert(!(await readdir(data.directory)).some(filename => filename.includes('.qqbf-backup-')))
    assert.equal((await deployment.reconcile(configuration)).presetBindings.length, 0)
  }
})

test('whitelist configured selection preserves exact target CAS and native configuration identity', async context => {
  for (const changed of ['revision', 'profile', 'credentials', 'layer', 'configuration'] as const) {
    const data = await capabilityFixture(context)
    const configuration: NativeChatConfiguration = { ...data.configuration,
      authorization: { version: 'whitelist-profile', mode: 'whitelist', grants: [] } }
    const deployment = runtime()
    const prepared = object(await deployment.prepare(configuration))
    assert.equal(prepared.state, 'prepared')
    if (changed === 'profile') await writeFile(data.profilePath, `${await readFile(data.profilePath, 'utf8')}# external profile change\n`)
    if (changed === 'credentials') await writeFile(data.credentialsPath, `${await readFile(data.credentialsPath, 'utf8')}# external credentials change\n`)
    if (changed === 'layer') await writeFile(data.basePath, `${await readFile(data.basePath, 'utf8')}# external layer change\n`)
    const profile = await readFile(data.profilePath, 'utf8')
    const credentials = await readFile(data.credentialsPath, 'utf8')
    const result = object(await deployment.apply(changed === 'configuration' ? { ...configuration,
      revisions: { ...configuration.revisions, plans: 'changed' } } : configuration,
    new AbortController().signal, changed === 'revision' ? '0'.repeat(64) : String(prepared.targetRevision)))
    assert.equal(result.state, changed === 'configuration' ? 'blocked' : 'conflict')
    assert.deepEqual(result.missingReasons, [changed === 'configuration' ? 'deployment_preview_required'
      : changed === 'revision' ? 'deployment_preview_revision_conflict' : 'deployment_revision_conflict'])
    assert.equal(await readFile(data.profilePath, 'utf8'), profile)
    assert.equal(await readFile(data.credentialsPath, 'utf8'), credentials)
    assert(!(await readdir(data.directory)).some(filename => filename.includes('.qqbf-backup-')))
  }
})

test('whitelist configured selection keeps pending live verification non-replayed and rejects later source drift', async context => {
  const data = await capabilityFixture(context)
  const configuration: NativeChatConfiguration = { ...data.configuration,
    authorization: { version: 'whitelist-profile', mode: 'whitelist', grants: [] } }
  const deployment = runtime()
  const prepared = object(await deployment.prepare(configuration))
  data.loaded(false)
  const result = object(await deployment.apply(configuration, new AbortController().signal, String(prepared.targetRevision)))
  assert.equal(result.state, 'pending_reload')
  assert.equal(typeof result.backupId, 'string')
  const written = await readFile(data.profilePath, 'utf8')
  assert.equal(object(await deployment.apply(configuration, new AbortController().signal, String(prepared.targetRevision))).state, 'blocked')
  data.loaded(true)
  assert.deepEqual((await deployment.reconcile(configuration)).missingReasons, [])
  data.capabilityDocuments.set('operator-work', '[]')
  assert.equal((await deployment.reconcile(configuration)).presetBindings.length, 0)
  assert.equal(await readFile(data.profilePath, 'utf8'), written)
  assert.equal((await readdir(data.directory)).filter(filename => filename.includes('.qqbf-backup-')).length, 2)
})
