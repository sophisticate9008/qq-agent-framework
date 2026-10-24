import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDefaultAdapterConfiguration,
  publicAdapterConfiguration,
  updateAdapterConfiguration,
  validateAdapterConfiguration,
  validateAdapterEndpoint,
  validateOneBotWebSocketEndpoint
} from '../src/host/adapter-configuration.ts'

test('native adapter defaults are disabled and copied into frozen configuration values', () => {
  const defaults = createDefaultAdapterConfiguration()
  assert.deepEqual(Object.keys(defaults), ['onebotHttp', 'onebotWs', 'dshAgent', 'onebotWebhook'])
  for (const adapter of Object.values(defaults)) assert.equal(adapter.enabled, false)
  assert.deepEqual(validateAdapterConfiguration(defaults), defaults)
  assert(Object.isFrozen(defaults))
  assert(Object.isFrozen(defaults.onebotWebhook))
  assert.deepEqual(publicAdapterConfiguration(defaults), {
    onebotHttp: { enabled: false, endpoint: '', secretConfigured: false },
    onebotWs: { enabled: false, endpoint: '', secretConfigured: false },
    dshAgent: { enabled: false, endpoint: '', authConfigured: false },
    onebotWebhook: { enabled: false, host: '127.0.0.1', port: 0, selfId: '', hmacConfigured: false }
  })
})

test('legacy adapter documents normalize missing WS without changing configured HTTP or input', () => {
  const defaults = createDefaultAdapterConfiguration()
  const { onebotWs: omitted, ...legacy } = defaults
  void omitted
  const value = { ...legacy, onebotHttp: { enabled: true, endpoint: 'https://onebot.example.test', secret: 'http-secret' } }
  const before = JSON.stringify(value)
  const normalized = validateAdapterConfiguration(value)
  assert.deepEqual(normalized.onebotWs, { enabled: false, endpoint: '', secret: '' })
  assert.deepEqual(normalized.onebotHttp, value.onebotHttp)
  assert.equal(JSON.stringify(value), before)
})

test('WS endpoints allow secure remote or literal loopback connections and reject ambiguous addresses', () => {
  for (const endpoint of ['', 'ws://localhost:3001', 'ws://127.0.0.1:3001/ws', 'ws://[::1]:3001', 'wss://gateway.example.test/onebot']) {
    assert.equal(validateOneBotWebSocketEndpoint(endpoint), endpoint)
  }
  for (const endpoint of [
    'https://example.test', 'ws://remote.example.test', 'ws://localhost.example.test', 'ws://0.0.0.0',
    'ws://127.1', 'ws://2130706433', 'ws://127.0.0.01', 'ws://[::]', 'ws://localhost.',
    'wss://user:secret@example.test', 'wss://@example.test', 'wss://example.test?token=secret',
    'wss://example.test#', 'wss://example.test?', 'wss://example.test\\private', 'wss://example.test/\n'
  ]) assert.throws(() => validateOneBotWebSocketEndpoint(endpoint), { message: 'Invalid adapter configuration' })
})

test('WS credentials retain, replace and explicitly clear while WS and webhook ingress cannot both enable', () => {
  const defaults = createDefaultAdapterConfiguration()
  const first = updateAdapterConfiguration(defaults, {
    onebotHttp: { enabled: true, endpoint: 'https://http.example.test', secret: 'http-secret' },
    onebotWs: { enabled: true, endpoint: 'ws://127.0.0.1:3001', secret: 'ws-secret' }
  })
  for (const patch of [
    { enabled: true, endpoint: 'wss://gateway.example.test' },
    { enabled: true, endpoint: 'wss://gateway.example.test', secret: '' }
  ]) {
    const retained = updateAdapterConfiguration(first, { onebotWs: patch })
    assert.equal(retained.onebotWs.secret, 'ws-secret')
    assert.deepEqual(retained.onebotHttp, first.onebotHttp)
    assert.equal(publicAdapterConfiguration(retained).onebotWs.secretConfigured, true)
  }
  assert.equal(updateAdapterConfiguration(first, { onebotWs: {
    enabled: false, endpoint: '', clearSecret: true
  } }).onebotWs.secret, '')
  for (const patch of [
    { onebotWs: { enabled: true, endpoint: '' } },
    { onebotWs: { enabled: false, endpoint: '', secret: 'ws-secret', clearSecret: true } },
    { onebotWs: { enabled: false, endpoint: '', secretConfigured: true } },
    { onebotWebhook: { enabled: true, host: '127.0.0.1', port: 3211, selfId: '123', hmac: 'test-hmac' } }
  ]) assert.throws(() => updateAdapterConfiguration(first, patch), /Invalid adapter configuration/)
})

test('adapter endpoints require explicit loopback HTTP or HTTPS without URL credentials or suffixes', () => {
  for (const endpoint of [
    '', 'http://localhost:3000', 'http://127.0.0.1:3001/v1', 'http://127.5.6.7:3002/',
    'http://[::1]:3003/api', 'https://agent.example.test/v1', 'https://192.0.2.1:8443'
  ]) assert.equal(validateAdapterEndpoint(endpoint), endpoint)
  for (const endpoint of [
    'http://192.168.1.1', 'http://0.0.0.0', 'http://[::]', 'http://agent.example.test',
    'http://localhost.example.test', 'http://localhost.', 'http://2130706433', 'http://127.1',
    'http://0x7f000001', 'http://127.0.0.01', 'https://user:password@example.test', 'https://@example.test',
    'https://example.test?token=x', 'https://example.test?', 'https://example.test#',
    'https://example.test/#fragment', 'https://example.test\\@elsewhere.test',
    'https://example.test\n', ' https://example.test', 'file:///tmp/agent', '/tmp/agent',
    'node:child_process', 'javascript:alert(1)', 'https://example.test/' + 'a'.repeat(2_048)
  ]) assert.throws(() => validateAdapterEndpoint(endpoint), { message: 'Invalid adapter configuration' })
})

test('credential updates preserve omitted and blank values and require explicit clearing', () => {
  const first = updateAdapterConfiguration(createDefaultAdapterConfiguration(), {
    onebotHttp: { enabled: false, endpoint: 'http://127.0.0.1:3000', secret: 'fixture-onebot-secret' },
    dshAgent: { enabled: false, endpoint: 'https://agent.example.test', auth: 'fixture-dsh-auth' },
    onebotWebhook: { enabled: false, host: '::1', port: 3211, selfId: '123', hmac: 'fixture-hmac' }
  })
  const preserved = updateAdapterConfiguration(first, {
    onebotHttp: { enabled: true, endpoint: first.onebotHttp.endpoint, secret: '' },
    dshAgent: { enabled: true, endpoint: first.dshAgent.endpoint, clearAuth: false },
    onebotWebhook: { enabled: true, host: '::1', port: 3211, selfId: '123', hmac: '' }
  })
  assert.equal(preserved.onebotHttp.secret, first.onebotHttp.secret)
  assert.equal(preserved.dshAgent.auth, first.dshAgent.auth)
  assert.equal(preserved.onebotWebhook.hmac, first.onebotWebhook.hmac)
  const serialized = JSON.stringify(publicAdapterConfiguration(preserved))
  assert.doesNotMatch(serialized, /fixture-|"secret":|"auth":|"token":|"hmac":/)
  const cleared = updateAdapterConfiguration(preserved, {
    onebotHttp: { enabled: false, endpoint: '', clearSecret: true },
    dshAgent: { enabled: false, endpoint: '', clearAuth: true },
    onebotWebhook: { enabled: false, host: '127.0.0.1', port: 0, selfId: '', clearHmac: true }
  })
  assert.deepEqual(cleared, createDefaultAdapterConfiguration())
  assert.equal(first.onebotHttp.enabled, false)
  assert.equal(preserved.onebotHttp.enabled, true)
})

test('configuration rejects executable fields, invalid enabled settings and ambiguous credentials', () => {
  const defaults = createDefaultAdapterConfiguration()
  for (const patch of [
    {}, { dynamic: { module: 'child_process' } },
    { onebotHttp: { enabled: false, endpoint: '', module: '/tmp/adapter' } },
    { onebotHttp: { enabled: false, endpoint: '', secretConfigured: true } },
    { onebotHttp: { enabled: true, endpoint: '' } },
    { onebotHttp: { enabled: false, endpoint: '', secret: 'new-secret', clearSecret: true } },
    { onebotHttp: { enabled: false, endpoint: '', secret: null } },
    { dshAgent: { enabled: false, endpoint: '', auth: 'secret\r\nheader' } },
    { dshAgent: { enabled: false, endpoint: '', auth: 'a'.repeat(4_097) } },
    { dshAgent: { enabled: false, endpoint: '', clearAuth: 'yes' } },
    { onebotWebhook: { enabled: true, host: '127.0.0.1', port: 0, selfId: '123', hmac: 'hmac' } },
    { onebotWebhook: { enabled: true, host: '127.0.0.1', port: 3211, selfId: '123' } },
    { onebotWebhook: { enabled: false, host: '0.0.0.0', port: 3211, selfId: '' } },
    { onebotWebhook: { enabled: false, host: '127.0.0.1', port: 65_536, selfId: '' } },
    { onebotWebhook: { enabled: false, host: '127.0.0.1', port: 3211.5, selfId: '' } },
    { onebotWebhook: { enabled: false, host: '127.0.0.1', port: 3211, selfId: '001' } }
  ]) assert.throws(() => updateAdapterConfiguration(defaults, patch), { message: 'Invalid adapter configuration' })
  assert.throws(() => validateAdapterConfiguration({ ...defaults, arbitrary: {} }))
})

test('private imageWorker fields are rejected without stripping existing custom configuration', () => {
  const defaults = createDefaultAdapterConfiguration()
  for (const imageWorker of [
    null,
    {},
    { enabled: false, endpoint: '', token: '' },
    { enabled: true, endpoint: 'https://image.example.test', token: 'private-image-token' },
    { enabled: false, endpoint: '', tokenConfigured: false },
    { enabled: false, endpoint: '', clearToken: true }
  ]) {
    const patch = { imageWorker }
    const custom = { ...defaults, imageWorker }
    const snapshot = JSON.stringify(custom)
    assert.throws(() => updateAdapterConfiguration(defaults, patch), { message: 'Invalid adapter configuration' })
    assert.throws(() => updateAdapterConfiguration(defaults, {
      ...patch, dshAgent: { enabled: false, endpoint: 'https://agent.example.test' }
    }), { message: 'Invalid adapter configuration' })
    assert.throws(() => validateAdapterConfiguration(custom), { message: 'Invalid adapter configuration' })
    assert.throws(() => publicAdapterConfiguration(custom), { message: 'Invalid adapter configuration' })
    assert.throws(() => updateAdapterConfiguration(custom, {
      dshAgent: { enabled: false, endpoint: 'https://agent.example.test' }
    }), { message: 'Invalid adapter configuration' })
    assert.equal(JSON.stringify(custom), snapshot)
  }
  assert.deepEqual(defaults, createDefaultAdapterConfiguration())
})
