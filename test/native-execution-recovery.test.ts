import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeExecutionController, DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'
import { createNativeExecutionRecovery } from '../src/host/native-execution-recovery.ts'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidence } from '../src/contracts/dsh-execution-evidence.ts'
import type { DshBridgePluginPort } from '../src/adapters/dsh-tool-scope.ts'
import type { DshSessionMigrationPort, DshSessionMigrationReceipt } from '../src/adapters/dsh-session-migration.ts'
import type { DurableStore, SessionBinding } from '../src/host/types.ts'
import { awaitCondition } from './fixtures/await-condition.ts'
import { digest, object } from '../src/host/data.ts'
import { reserveSessionId } from '../src/host/sessions.ts'

async function fixture(context: TestContext, options: { lostFork?: boolean; retirementCrash?: boolean } = {}) {
  const sqlite = createSqliteStore({filename:':memory:'})
  let failDelete = options.retirementCrash === true
  const store: DurableStore = {...sqlite,delete(namespace,key,revision) {
    if (namespace === 'host.execution-conversations' && failDelete) { failDelete=false;throw Error('simulated retirement checkpoint interruption') }
    return sqlite.delete(namespace,key,revision)
  }}
  let clock = 100000
  let cancelled = 0
  let forked = 0
  let inspected = 0
  const binding = {conversationId:'private:123',sessionId:'old-session',generation:4}
  store.write('host.sessions',binding.conversationId,{schema:1,state:'ready',generation:4,sessionId:binding.sessionId,requestId:'original',updatedAt:clock},{expectedRevision:null})
  const makeController = () => createNativeExecutionController({store,clock:()=>clock,
    policy:{...DEFAULT_NATIVE_EXECUTION_POLICY,turnTimeoutMs:1000},async cancel(){cancelled++;return {status:'unknown'}}})
  let controller = makeController(); controller.start()
  context.after(async()=>{await controller.stop();sqlite.close()})
  const execution = controller.admit({binding,requestId:'original-request',policyRevision:'a'.repeat(64)})
  await controller.submit(execution.id,async()=>({status:'unknown'}))
  clock+=2000;controller.tick()
  await awaitCondition(()=>controller.get(execution.id)?.cancelStatus==='unknown',{timeoutMs:1000,message:'unknown cancellation checkpoint'})
  const evidence:DshExecutionEvidence={schema:1,protocol:DSH_EXECUTION_EVIDENCE_PROTOCOL,issuerEpoch:'fresh-epoch',sessionId:binding.sessionId,
    requestId:execution.requestId,state:'settled',matchedUserMessageId:'real-user',matchedTurn:1,outcome:'completed',userSequence:2,
    terminalSequence:7,checkpointSequence:7,checkpointHash:'b'.repeat(64),quiescent:true,missingReasons:[]}
  const evidencePort:DshBridgePluginPort={async describe(){throw Error('unused')},async claimReceipts(){throw Error('unused')},async inspectScope(){throw Error('unused')},async inspectExecution(){return evidence}}
  let receipt:DshSessionMigrationReceipt|undefined
  const migrationPort:DshSessionMigrationPort={
    async forkPreview(request){return {...request,migrationProtocol:'qbf-session-migration/1',issuerEpoch:'fresh-epoch',state:'available',sourceCursor:7,
      sourceDigest:'c'.repeat(64),targetRevision:'d'.repeat(64),missingReasons:[]}},
    async forkWithPreset(request){forked++;receipt={...request,migrationProtocol:'qbf-session-migration/1',state:'completed',childSessionId:'new-session',idempotency:'created',missingReasons:[]}
      if(options.lostFork)throw Error('lost receipt');return receipt},
    async inspectMigration(){inspected++;assert(receipt);return {...receipt,idempotency:'replayed'}}}
  function service(){return createNativeExecutionRecovery({store,evidencePort,migrationPort,issuerEpoch:'fresh-epoch',executions:controller,
    signal:new AbortController().signal,async resolvePreset(){return 'verified-original'},async recheck(current:SessionBinding){
      const row=store.read('host.sessions',current.conversationId)!
      assert.equal(object(row.value).sessionId,current.sessionId);assert.equal(object(row.value).generation,current.generation)
    }})}
  return {store,binding,execution,evidence,service:()=>service(),controller:()=>controller,cancelled:()=>cancelled,forked:()=>forked,inspected:()=>inspected,
    async restartController(){await controller.stop();controller=makeController();controller.start()}}
}

test('unknown cancellation recovers only to a distinct durable fork and keeps the old address isolated',async context=>{
  const f=await fixture(context)
  const recovery=f.service()
  const plan=await recovery.preview(f.execution.id)
  assert.equal(plan.state,'available');assert.equal(f.forked(),0)
  const completed=await recovery.commit(f.execution.id,plan.revision)
  assert.equal(completed.state,'completed');assert.equal(completed.restartRequired,true)
  assert.equal(f.forked(),1);assert.equal(f.cancelled(),1)
  assert.equal(f.controller().get(f.execution.id)?.cancelStatus,'unknown')
  assert.equal(f.controller().get(f.execution.id)?.isolated,true)
  assert.equal(f.controller().forConversation(f.binding.conversationId),null)
  assert.equal(object(f.store.read('host.execution-sessions',digest(f.binding.sessionId))?.value).executionId,f.execution.id)
  assert.throws(()=>f.controller().admit({binding:f.binding,requestId:'unsafe-old-address',policyRevision:'a'.repeat(64)}),{code:'EXECUTION_SESSION_ISOLATED'})
  assert.throws(()=>reserveSessionId(f.store,'private:other',f.binding.sessionId,1),{code:'SESSION_ID_REUSED'})
  const successor={...f.binding,sessionId:'new-session',generation:5}
  assert.doesNotThrow(()=>f.controller().admit({binding:successor,requestId:'new-user-request',policyRevision:'a'.repeat(64)}))
  await recovery.commit(f.execution.id,plan.revision)
  assert.equal(f.forked(),1)
})

test('lost fork response is inspected by the same durable plan and never starts another fork after restart',async context=>{
  const f=await fixture(context,{lostFork:true})
  const plan=await f.service().preview(f.execution.id)
  const unknown=await f.service().commit(f.execution.id,plan.revision)
  assert.equal(unknown.state,'unknown');assert.equal(object(f.store.read('host.sessions',f.binding.conversationId)?.value).sessionId,'old-session')
  await f.restartController()
  const recovered=await f.service().commit(f.execution.id,plan.revision)
  assert.equal(recovered.state,'completed');assert.equal(f.forked(),1);assert.equal(f.inspected(),1);assert.equal(f.cancelled(),1)
})

test('a crash after successor CAS recovers retirement without releasing the old external session claim',async context=>{
  const f=await fixture(context,{retirementCrash:true})
  const plan=await f.service().preview(f.execution.id)
  await assert.rejects(f.service().commit(f.execution.id,plan.revision),/simulated retirement checkpoint interruption/)
  assert.equal(object(f.store.read('host.sessions',f.binding.conversationId)?.value).sessionId,'new-session')
  await f.restartController()
  assert.equal(f.controller().forConversation(f.binding.conversationId),null)
  assert.equal((await f.service().commit(f.execution.id,plan.revision)).state,'completed')
  assert(f.store.read('host.execution-sessions',digest(f.binding.sessionId)))
  assert.equal(f.forked(),1);assert.equal(f.cancelled(),1)
})

test('pending inbox, unresolved child output and a changed source generation cannot silently migrate',async context=>{
  const f=await fixture(context)
  const row=f.store.write('native-chat.inbox','pending',{conversationId:f.binding.conversationId,entries:[{id:'queued'}]},{expectedRevision:null})
  await assert.rejects(f.service().preview(f.execution.id),{code:'EXECUTION_RECOVERY_UNSETTLED'})
  f.store.delete(row.namespace,row.key,row.revision)
  const work=f.store.write('native-work.executions','child',{parentSessionId:f.binding.sessionId,status:'completed',delivery:'unknown'},{expectedRevision:null})
  await assert.rejects(f.service().preview(f.execution.id),{code:'EXECUTION_RECOVERY_UNSETTLED'})
  f.store.delete(work.namespace,work.key,work.revision)
  const uncertainSend=f.store.write('outbox','uncertain-send',{conversationId:f.binding.conversationId,status:'unknown'},{expectedRevision:null})
  await assert.rejects(f.service().preview(f.execution.id),{code:'EXECUTION_RECOVERY_UNSETTLED'})
  f.store.delete(uncertainSend.namespace,uncertainSend.key,uncertainSend.revision)
  const plan=await f.service().preview(f.execution.id)
  const source=f.store.read('host.sessions',f.binding.conversationId)!
  f.store.write(source.namespace,source.key,{...object(source.value),generation:5},{expectedRevision:source.revision})
  await assert.rejects(f.service().commit(f.execution.id,plan.revision),{code:'EXECUTION_RECOVERY_BINDING_CHANGED'})
  assert.equal(f.forked(),0)
})
