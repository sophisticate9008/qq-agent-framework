import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshToolScopeReader } from '../src/adapters/dsh-tool-scope.ts'

test('scope reader queries the actual live agent and its effective schemas, not global tools or preset declarations', () => {
  const agent = { id: 'session-1', session: { id: 'session-1' }, ctx: {} }
  let observed: object | undefined
  const reader = createDshToolScopeReader({ sessionId: value => value,
    agents: { get: id => id === agent.id ? agent : undefined },
    agentPresets: { composedPreset: context => context === agent.ctx ? 'selected-preset' : undefined },
    tools: { schemas(scope) { observed = scope; return [{ name: 'scoped-tool', parameters: { type: 'object' } }, { name: 'inherited-tool' }] } },
  })
  const result = reader.inspect({ sessionId: 'session-1', expectedPreset: 'selected-preset', expectedNames: ['inherited-tool', 'scoped-tool'] })
  assert.equal(observed, agent)
  assert.equal(result.state, 'verified-scope')
  if (result.state !== 'verified-scope') throw new Error('Missing scope')
  assert.equal(result.effectiveToolScopeVerified, true)
  assert.equal(result.externalToolAuthorizationVerified, false)
  assert.equal(result.declarationRevisionVerified, false)
  assert.deepEqual(result.names, ['inherited-tool', 'scoped-tool'])
  assert.equal(reader.inspect({ sessionId: 'session-1', expectedPreset: 'selected-preset', expectedNames: ['scoped-tool'] }).state, 'unverified')
})

test('scope reader fails closed for cold sessions, wrong preset, disappearing agents or invalid private tool data', () => {
  const agent = { id: 'session-1', session: { id: 'session-1' }, ctx: {} }
  let current: typeof agent | undefined = agent
  let invalid = false
  const reader = createDshToolScopeReader({ sessionId: value => value,
    agents: { get: () => current }, agentPresets: { composedPreset: () => 'selected' },
    tools: { schemas() {
      if (invalid) throw new Error('private-runtime-value')
      current = undefined
      return [{ name: 'tool' }]
    } },
  })
  assert.equal(reader.inspect({ sessionId: 'session-1', expectedPreset: 'other' }).state, 'unverified')
  assert.equal(reader.inspect({ sessionId: 'session-1', expectedPreset: 'selected' }).state, 'unverified')
  current = agent
  invalid = true
  assert(!JSON.stringify(reader.inspect({ sessionId: 'session-1', expectedPreset: 'selected' })).includes('private-runtime-value'))
})
