import assert from 'node:assert/strict'
import test from 'node:test'
import { drainNativeRun, type NativePreparedRunResources } from '../src/host/native-run-resources.ts'

test('preparation cleanup drains every owned phase even if a producer or synchronous disposer fails', async () => {
  const calls: string[] = []
  const lifetime = new AbortController()
  const expected = new Error('producer failed')
  const resources: NativePreparedRunResources = { lifetime, host: undefined, dsh: undefined, work: undefined,
    claims: undefined, executions: undefined, bootstrap: undefined, tools: undefined, packages: undefined,
    inbox: undefined, quotedContext: undefined, claimTimer: undefined,
    reminders: { async stop() { assert(lifetime.signal.aborted); calls.push('reminders'); throw expected } },
    memory: { stop() { calls.push('memory') } },
    releaseInteractions() { calls.push('release'); throw new Error('disposer failed') },
    async closeInteractions() { calls.push('interactions') }, clearIngress() { calls.push('ingress') },
    async drainConfiguration() { calls.push('configuration') }, async drainPolicy() { calls.push('policy') } }
  const result = await drainNativeRun(resources)
  assert.equal(result.errors.length, 2)
  assert.equal(result.errors[0], expected)
  assert.deepEqual(new Set(calls), new Set(['reminders', 'memory', 'release', 'interactions', 'ingress', 'configuration', 'policy']))
  assert(calls.indexOf('interactions') > calls.indexOf('ingress'))
  assert(calls.indexOf('configuration') > calls.indexOf('interactions'))
  assert.equal(result.packageUnknown, false)
})
