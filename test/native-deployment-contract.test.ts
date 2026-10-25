import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNativeDeploymentPreparationResult, parseNativeDeploymentApplyResult,
  parseNativeDeploymentReconciliationResult } from '../src/contracts/native-deployment.ts'
import { checkedNativeDeploymentRuntime } from '../src/host/native-deployment-runtime.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'

const revision = 'a'.repeat(64)
const prepared = { state: 'prepared', targetRevision: revision, summary: { ready: true, missingReasons: [] },
  preview: { capabilityComposition: null }, capabilityApprovalRequest: null }

test('deployment boundary validates actual discriminated states and normalizes legacy version only once', () => {
  const result = parseNativeDeploymentPreparationResult({ ...prepared, privateDiagnostic: 'excluded' })
  assert(result?.state === 'prepared')
  assert.equal(result.schema, 1)
  assert.equal(result.summary.ready, true)
  assert.equal(Object.hasOwn(result, 'privateDiagnostic'), false)
  assert.equal(parseNativeDeploymentPreparationResult({ ...prepared, schema: 2 }), null)
  assert.equal(parseNativeDeploymentPreparationResult({ ...prepared, targetRevision: 'stale' }), null)
  assert.equal(parseNativeDeploymentPreparationResult({ ...prepared, summary: { ready: false, missingReasons: [] } }), null)
  assert.equal(parseNativeDeploymentPreparationResult({ ...prepared, preview: { capabilityComposition: { externalToolAuthorizationVerified: true } } }), null)
  assert.deepEqual(parseNativeDeploymentPreparationResult({ state: 'blocked', missingReasons: ['deployment_busy'] }),
    { schema: 1, state: 'blocked', missingReasons: ['deployment_busy'] })
})

test('deployment result decoder never upgrades unknown or pending writes into verified outcomes', () => {
  assert.equal(parseNativeDeploymentApplyResult({ state: 'verified', missingReasons: [] }), null)
  assert.equal(parseNativeDeploymentApplyResult({ state: 'verified', backupId: 'backup', missingReasons: ['pending_reload'] }), null)
  assert.equal(parseNativeDeploymentApplyResult({ state: 'pending_reload', missingReasons: ['pending_reload'] }), null)
  for (const state of ['blocked', 'conflict', 'unknown', 'pending_reload', 'verified']) {
    const missingReasons = state === 'verified' ? [] : ['synthetic_reason']
    const result = parseNativeDeploymentApplyResult({ state, backupId: 'backup', missingReasons })
    assert.equal(result?.state, state)
  }
  assert.equal(parseNativeDeploymentReconciliationResult({ missingReasons: [], presetBindings: [{ agentPreset: 'unknown', definition: {} }] }), null)
  assert.equal(parseNativeDeploymentReconciliationResult({ missingReasons: [], presetBindings: [], credentialValueIdentityVerified: true }), null)
})

test('checked deployment integration decodes every response without retrying an unknown external application', async () => {
  let applications = 0
  const configuration = {} as NativeChatConfiguration
  const source = {
    async prepare() { return prepared },
    async reconcile() { return { missingReasons: [], presetBindings: [] } },
    async apply() { applications++; return { state: 'unknown', missingReasons: ['lost_response'] } }
  }
  const runtime = checkedNativeDeploymentRuntime(source)
  assert.equal(checkedNativeDeploymentRuntime(source), runtime)
  assert.equal(checkedNativeDeploymentRuntime(runtime), runtime)
  assert.equal((await runtime.prepare(configuration)).schema, 1)
  assert.equal((await runtime.apply(configuration, new AbortController().signal)).state, 'unknown')
  assert.equal(applications, 1)
  assert.deepEqual((await runtime.reconcile(configuration)).missingReasons, [])
  const broken = checkedNativeDeploymentRuntime({ ...source, async apply() { return { state: 'completed' } } })
  await assert.rejects(broken.apply(configuration, new AbortController().signal), { code: 'NATIVE_DEPLOYMENT_APPLICATION_INVALID' })
  assert.equal(applications, 1)
})
