import assert from 'node:assert/strict'
import test from 'node:test'
import { modelProviderApi } from '../src/host/model-provider-protocols.ts'

import {
  publicModelProviders,
  updateModelProviders,
  validateModelProviders
} from '../src/host/model-providers.ts'

const provider = {
  id: 'primary', name: 'Primary', type: 'openai', baseUrl: 'https://models.example.test/v1',
  enabled: true, apiKey: 'test-private-key', models: [{ id: 'vendor/chat-v1', name: 'Chat V1' }]
} as const

test('DSH api identifiers are preserved without a framework provider-family whitelist', () => {
  const { type: ignoredType, ...fields } = provider
  void ignoredType
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'operator-custom-api']) {
    const catalog = validateModelProviders([{ ...fields, api }])
    assert.equal(catalog[0].api, api)
    assert.equal(modelProviderApi(catalog[0]), api)
    assert.equal(Object.hasOwn(catalog[0], 'type'), false)
    assert.equal(publicModelProviders(catalog)[0].api, api)
    assert.equal(updateModelProviders(catalog, [{ ...fields, api, apiKey: '' }])[0].apiKey, fields.apiKey)
  }
  assert.equal(modelProviderApi(provider), 'openai-completions')
  assert.equal(modelProviderApi({ type: 'anthropic' }), 'anthropic-messages')
  for (const api of ['', 'api key', '../api', 'api\nvalue', 'x'.repeat(129), undefined, 123]) {
    assert.throws(() => validateModelProviders([{ ...fields, api }]), /Invalid model providers/)
  }
  assert.throws(() => validateModelProviders([fields]), /Invalid model providers/)
})

test('remote HTTP is only retained with explicit provider-local consent, without rewriting the endpoint', () => {
  const baseUrl = 'http://gateway.example.test:8080/v1'
  for (const allowInsecureHttp of [false, undefined, 'yes']) {
    assert.throws(() => validateModelProviders([{ ...provider, baseUrl, allowInsecureHttp }]), /Invalid model providers/)
  }
  const catalog = validateModelProviders([{ ...provider, baseUrl, allowInsecureHttp: true }])
  assert.equal(catalog[0].baseUrl, baseUrl)
  assert.equal(publicModelProviders(catalog)[0].allowInsecureHttp, true)
  assert.equal(updateModelProviders(catalog, [catalog[0]])[0].allowInsecureHttp, true)
  for (const invalidUrl of ['http://secret@remote.test', 'http://remote.test?secret=value', 'http://remote.test#fragment', 'http://remote.test\\path']) {
    assert.throws(() => validateModelProviders([{ ...provider, baseUrl: invalidUrl, allowInsecureHttp: true }]), /Invalid model providers/)
  }
})

test('provider validation freezes independent named catalogs and public output never includes keys', () => {
  const models = [{ id: 'claude', name: 'Claude' }]
  const catalog = validateModelProviders([provider, {
    ...provider, id: 'alternate', name: 'Alternate', type: 'anthropic', models, apiKey: ''
  }])
  models[0].name = 'Changed'
  assert.equal(catalog[1].models[0].name, 'Claude')
  assert(Object.isFrozen(catalog))
  assert(Object.isFrozen(catalog[0]))
  assert(Object.isFrozen(catalog[0].models))
  assert(Object.isFrozen(catalog[0].models[0]))
  const exposed = publicModelProviders(catalog)
  assert.deepEqual(exposed, catalog.map(({ apiKey, ...entry }) => ({ ...entry, apiKeyConfigured: apiKey !== '' })))
  assert(!JSON.stringify(exposed).includes(provider.apiKey))
  assert.equal(Object.hasOwn(exposed[0], 'apiKey'), false)
})

test('provider keys retain only by matching id and require explicit clearing', () => {
  const { apiKey: ignoredKey, ...publicFields } = provider
  void ignoredKey
  for (const patch of [publicFields, { ...publicFields, apiKey: '' }]) {
    assert.equal(updateModelProviders([provider], [patch])[0].apiKey, provider.apiKey)
  }
  assert.equal(updateModelProviders([provider], [{ ...publicFields, id: 'other' }])[0].apiKey, '')
  assert.equal(updateModelProviders([provider], [{ ...publicFields, clearApiKey: true }])[0].apiKey, '')
  assert.equal(updateModelProviders([provider], [{ ...publicFields, apiKey: 'replacement' }])[0].apiKey, 'replacement')
  for (const patch of [
    { ...provider, clearApiKey: true }, { ...publicFields, clearApiKey: 'yes' },
    { ...publicFields, apiKeyConfigured: true }, { ...publicFields, apiKey: undefined },
    { ...publicFields, apiKey: '\nprivate-key' }, { ...publicFields, apiKey: '密钥' },
    { ...publicFields, apiKey: 'x'.repeat(4097) }
  ]) assert.throws(() => updateModelProviders([provider], [patch]), /^TypeError: Invalid model providers$/)
  assert.equal(updateModelProviders([], [{ ...publicFields, apiKey: ' '.repeat(4096) }])[0].apiKey.length, 4096)
})

test('provider URLs require explicit HTTPS or literal loopback HTTP without credentials or query', () => {
  for (const baseUrl of [
    'https://models.example.test/v1', 'http://localhost:8000/v1',
    'http://127.0.0.1:8000', 'http://127.9.8.7', 'http://[::1]:8000'
  ]) assert.equal(validateModelProviders([{ ...provider, baseUrl }])[0].baseUrl, baseUrl)
  for (const baseUrl of [
    '', 'models.example.test', '//models.example.test', 'http://remote.example.test',
    'https://user:private@models.example.test', 'https://@models.example.test',
    'https://models.example.test?apiKey=private', 'https://models.example.test#private',
    'https://models.example.test?', 'https://models.example.test#',
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://localhost.example.test',
    'ftp://models.example.test', 'https://models.example.test\\private',
    'https://models.example.test/\nprivate', `https://${'a'.repeat(2048)}.test`
  ]) assert.throws(() => validateModelProviders([{ ...provider, baseUrl }]), /Invalid model providers/)
})

test('provider catalogs reject unlisted fields and enforce bounded unique names, ids and models', () => {
  for (const entry of [
    null, { ...provider, type: 'custom' }, { ...provider, id: '../private' },
    { ...provider, enabled: 'yes' }, { ...provider, name: '' }, { ...provider, name: 'x'.repeat(129) },
    { ...provider, apiKey: 'test\x7fkey' }, { ...provider, apiKey: 'test\tkey' },
    { ...provider, models: [{ id: '../private', name: 'Private' }] },
    { ...provider, models: [{ id: 'chat', name: 'Chat', apiKey: 'private' }] },
    { ...provider, models: [{ id: 'chat', name: 'One' }, { id: 'chat', name: 'Two' }] },
    { ...provider, models: [{ id: 'one', name: 'Same' }, { id: 'two', name: 'Same' }] },
    { ...provider, endpoint: 'https://other.example.test' }
  ]) assert.throws(() => validateModelProviders([entry]), /Invalid model providers/)
  assert.throws(() => validateModelProviders([provider, provider]), /Invalid model providers/)
  assert.throws(() => validateModelProviders([provider, { ...provider, id: 'other' }]), /Invalid model providers/)
  const models = Array.from({ length: 128 }, (_entry, index) => ({ id: `model-${index}`, name: `Model ${index}` }))
  const providers = Array.from({ length: 128 }, (_entry, index) => ({ ...provider, id: `p-${index}`, name: `Provider ${index}` }))
  assert.equal(validateModelProviders(providers).length, 128)
  assert.equal(validateModelProviders([{ ...provider, models }])[0].models.length, 128)
  assert.throws(() => validateModelProviders([...providers, { ...provider, id: 'overflow' }]))
  assert.throws(() => validateModelProviders([{ ...provider, models: [...models, { id: 'overflow', name: 'Overflow' }] }]))
  assert.deepEqual(validateModelProviders([]), [])
})
