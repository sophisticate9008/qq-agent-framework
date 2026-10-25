import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { composeStaticDshLayers, readStaticDshProfile, staticDshProfileValues } from '../src/adapters/dsh-static-profile.ts'
import { createNativeDshDeploymentRuntime } from '../src/adapters/dsh-profile-deployment.ts'
import { resolveLocalDshModelSettings, readLocalDshModelCapabilities } from '../src/host/local-dsh-model-settings.ts'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import { discoverLocalDshDeployment } from '../src/host/local-dsh-deployment.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'

function value(text: string) { return staticDshProfileValues(readStaticDshProfile(text)) }

test('static profile composition preserves AST, clones layers and represents expressions without evaluating them', () => {
  const source = '# retained comment\n- insert:\n  - id: group\n    name: group\n    group: true\n    config:\n      - id: nested\n        name: plugin\n        disabled: !!js (() => { throw new Error("must-not-run") })()\n        config: { original: true }\n'
  const document = readStaticDshProfile(source)
  const base = staticDshProfileValues(document)
  const before = JSON.stringify(base)
  const rows = composeStaticDshLayers([base, value('- id: nested\n  config: { patched: true }\n'),
    value('- id: group\n  insert:\n    - { id: appended, name: plugin, config: {} }\n')])
  assert.deepEqual(rows.map(row => row.id), ['group', 'nested', 'appended'])
  assert.deepEqual(rows[1]?.config, { patched: true })
  assert.deepEqual(rows[1]?.disabled, { __jsExpr: '(() => { throw new Error("must-not-run") })()' })
  assert.equal((rows[0]?.config as unknown[]).length, 2)
  assert.equal(JSON.stringify(base), before)
  assert.equal(document.toString(), readStaticDshProfile(source).toString())
  assert.match(document.toString(), /retained comment/)
  assert.match(document.toString(), /!!js/)
})

test('all static consumers reject aliases, duplicate/unsafe keys, unknown tags and nonfinite values', () => {
  for (const source of ['- &ref { id: one, name: plugin }\n- *ref\n', '{ key: 1, key: 2 }',
    '{ __proto__: value }', '{ constructor: value }', '{ <<: value }', '!unknown value', '{ value: .inf }']) {
    assert.throws(() => value(source), { name: 'Error' }, source)
  }
  assert.throws(() => readStaticDshProfile('x'.repeat(1_048_577)), { code: 'dsh_document_too_large' })
})

test('shared layer composition rejects duplicate rows, nonexistent targets, renames and implicit group replacement', () => {
  const base = value('- insert:\n  - { id: group, name: group, group: true, config: [{ id: nested, name: plugin }] }\n')
  for (const source of ['- insert: [{ id: nested, name: duplicate }]', '- { id: missing, config: {} }',
    '- { id: nested, name: renamed }', '- { id: group, config: [] }', '- { id: nested, insert: [] }'])
    assert.throws(() => composeStaticDshLayers([base, value(source)]))
  assert.throws(() => composeStaticDshLayers([JSON.parse('[{"insert":[{"id":"unsafe","name":"plugin","__proto__":{"polluted":true}}]}]') as unknown]),
    { code: 'dsh_yaml_key_unsupported' })
})

test('actual model discovery and deployment use identical layered static data without rewriting unmanaged content', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-static-profile-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const basePath = join(directory, 'base.patch.yml')
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, '.credentials.yaml')
  const route = { api: 'openai-completions', baseURL: 'https://models.example.test/v1',
    models: [{ id: 'model', contextWindow: 128_000, maxTokens: 4096, reasoningEfforts: false }] }
  const base = '- insert:\n' + JSON.stringify([{ id: 'group', name: 'group', group: true, config: [
    { id: 'provider', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { observed: route } } }] }])
    .split('\n').map(line => `    ${line}`).join('\n') + '\n'
  const profile = '# unmanaged profile comment\n- insert:\n  - id: foreign\n    name: foreign-plugin\n    disabled: !!js (() => { throw new Error("never evaluate") })()\n'
  await writeFile(basePath, base, { mode: 0o600 })
  await writeFile(profilePath, profile, { mode: 0o600 })
  await writeFile(credentialsPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const defaults = await new NativeConfigurationRepository(directory).read()
  const provider = { id: 'selected', name: 'Selected', enabled: true, type: 'openai' as const,
    baseUrl: route.baseURL, apiKey: 'synthetic-key', models: [{ id: 'model', name: 'Model' }] }
  const target = { profilePath, credentialsPath, layerPaths: [basePath], schemaVersion: '0.2.1-rc.2' as const }
  const configuration: NativeChatConfiguration = { ...defaults, providers: [provider],
    personas: [{ id: 'persona', name: 'Persona', identity: 'Test identity.', style: 'Concise.' }],
    catalog: { activePlanId: 'plan', plans: [{ id: 'plan', name: 'Plan', description: '', instructions: 'Be concise.',
      personaId: 'persona', provider: provider.id, model: 'model', reasoningEffort: 'off',
      contextLimits: { group: 64_000, private: 96_000 } }] },
    deployment: { ...defaults.deployment, target, modelSettings: null } }
  const settings = await resolveLocalDshModelSettings(configuration, target)
  assert.deepEqual(settings.modelSettings, { contextWindow: 128_000, maxTokens: 4096, reasoningEfforts: false })
  const observed = await readLocalDshModelCapabilities(provider, 'model', target)
  assert.deepEqual(observed.reasoningEfforts, ['off'])
  assert.deepEqual(observed.capacity?.recommended, { group: 96000, private: 128000 })
  assert.equal(observed.capacity?.maxTokens, 4096)
  assert.equal(observed.capacity?.compaction.groupHeadroomTokens, Math.floor((96000 - 4096) * 0.05))
  const deployment = createNativeDshDeploymentRuntime()
  const prepared = await deployment.prepare({ ...configuration, deployment: { ...configuration.deployment, modelSettings: settings.modelSettings } })
  assert.equal(prepared.state, 'prepared', JSON.stringify(prepared))
  assert.equal(await readFile(profilePath, 'utf8'), profile)
  const generated = 'qqaf-' + 'a'.repeat(24) + '-group'
  await writeFile(profilePath, profile + '- id: provider\n  config: ' + JSON.stringify({ providers: { observed: route,
    [generated]: { ...route, models: [{ ...route.models[0], contextWindow: 64000 }] } } }) + '\n- insert: ' + JSON.stringify([
      { id: 'qqaf-preset-' + 'a'.repeat(24) + '-group', name: '@deepseek-ai/dsh-agent-preset', config: { id: generated, name: 'Native chat (group)', plugins: [] } }
    ]) + '\n', { mode: 0o600 })
  assert.equal((await readLocalDshModelCapabilities(provider, 'model', target)).capacity?.contextWindow, 128000,
    'Generated per-conversation limits are not observations of the model capacity')
  assert.equal((await resolveLocalDshModelSettings(configuration, target)).modelSettings.contextWindow, 128000)
  await writeFile(profilePath, profile + '- id: does-not-exist\n  config: {}\n', { mode: 0o600 })
  await assert.rejects(resolveLocalDshModelSettings(configuration, target), { code: 'LOCAL_DSH_MODEL_SETTINGS_MISSING' })
  const blocked = await deployment.prepare(configuration)
  assert.equal(blocked.state, 'blocked')
  assert('missingReasons' in blocked && blocked.missingReasons.includes('dsh_explicit_layers_required'))
})

test('actual local process discovery validates composed layers before returning a writable target', { skip: process.platform !== 'linux', timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-static-discovery-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const profileDirectory = join(home, 'profiles', 'web')
  const dsh = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  const bundle = join(directory, 'node_modules', 'fixture-bundle')
  await Promise.all([mkdir(profileDirectory, { recursive: true, mode: 0o700 }), mkdir(join(dsh, 'lib'), { recursive: true, mode: 0o700 }),
    mkdir(bundle, { recursive: true, mode: 0o700 })])
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', type: 'module' }), { mode: 0o600 })
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', dsh: { bundle: { patch: 'base.patch.yml' } } }), { mode: 0o600 })
  await writeFile(join(bundle, 'base.patch.yml'), '- insert: [{ id: provider, name: plugin, config: { original: true } }]\n', { mode: 0o600 })
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }), { mode: 0o600 })
  const profilePath = join(profileDirectory, 'cordis.patch.yml')
  const credentialsPath = join(home, '.credentials.yaml')
  await writeFile(profilePath, '- id: provider\n  config: { patched: true }\n', { mode: 0o600 })
  await writeFile(credentialsPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const launcher = join(dsh, 'lib', 'bin.js')
  await writeFile(launcher, "import { createServer } from 'node:net'; const server = createServer(); server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port })); process.once('message', () => server.close(() => process.exit(0)));\n", { mode: 0o600 })
  const child = fork(launcher, ['--profile', 'web'], { cwd: directory, env: { ...process.env, DSH_HOME: home }, silent: true })
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  })
  const [message] = await once(child, 'message') as [unknown]
  assert(message && typeof message === 'object' && 'port' in message && typeof message.port === 'number')
  const request = { endpoint: `http://127.0.0.1:${message.port}`, localCredentialsPath: credentialsPath, signal: new AbortController().signal }
  assert.deepEqual(await discoverLocalDshDeployment(request), { profilePath, credentialsPath,
    layerPaths: [join(bundle, 'base.patch.yml')], schemaVersion: '0.2.1-rc.2' })
  await writeFile(profilePath, '- id: not-in-base\n  config: {}\n', { mode: 0o600 })
  await assert.rejects(discoverLocalDshDeployment(request), { code: 'LOCAL_DSH_DEPLOYMENT_PATCH_INVALID' })
})
