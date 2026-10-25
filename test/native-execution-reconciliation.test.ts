import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createSqliteStore} from '../src/storage/sqlite.ts'
import {createNativeExecutionController,DEFAULT_NATIVE_EXECUTION_POLICY} from '../src/host/native-execution.ts'
import {createNativeExecutionReconciliation} from '../src/host/native-execution-reconciliation.ts'
import {DSH_EXECUTION_EVIDENCE_PROTOCOL,type DshExecutionEvidence} from '../src/contracts/dsh-execution-evidence.ts'
import type {DshBridgePluginPort} from '../src/adapters/dsh-tool-scope.ts'
import {awaitCondition} from './fixtures/await-condition.ts'

const binding={conversationId:'group:123',sessionId:'session-1',generation:3}
const signal=new AbortController().signal
function fixture(context:TestContext,cancel?:'accepted'|'unknown'){
  const store=createSqliteStore({filename:':memory:'})
  let clock=100000
  let cancelled=0
  let inspected=0
  let current=true
  const controller=createNativeExecutionController({store,clock:()=>clock,policy:{...DEFAULT_NATIVE_EXECUTION_POLICY,turnTimeoutMs:1000,noticeEnabled:false},
    ...(cancel?{async cancel(){cancelled++;return{status:cancel}}}:{})})
  controller.start()
  context.after(async()=>{await controller.stop();store.close()})
  const record=controller.admit({binding,requestId:'request-1',policyRevision:'a'.repeat(64)})
  let evidence:DshExecutionEvidence={schema:1,protocol:DSH_EXECUTION_EVIDENCE_PROTOCOL,issuerEpoch:'new-epoch',sessionId:binding.sessionId,requestId:record.requestId,
    state:'settled',matchedUserMessageId:'actual-message',matchedTurn:5,outcome:'completed',userSequence:2,terminalSequence:7,checkpointSequence:7,
    checkpointHash:'b'.repeat(64),quiescent:true,missingReasons:[]}
  const port:DshBridgePluginPort={async describe(){throw Error('Unused')},async claimReceipts(){throw Error('Unused')},async inspectScope(){throw Error('Unused')},
    async inspectExecution(){inspected++;return evidence}}
  const recovery=createNativeExecutionReconciliation({store,port,issuerEpoch:'new-epoch',executions:controller,signal,isCurrentBinding:value=>current&&value.generation===3&&value.sessionId===binding.sessionId})
  return{controller,recovery,record,store,async unknown(){await controller.submit(record.id,async()=>({status:'unknown'}));return controller.get(record.id)!},
    expire(){clock+=2000;controller.tick()},cancelled:()=>cancelled,inspected:()=>inspected,current(value:boolean){current=value},evidence(value:Partial<DshExecutionEvidence>){evidence={...evidence,...value}}}
}

test('positive durable checkpoint recovers an unknown execution without replaying submission or delivering an old result',async context=>{
  const f=fixture(context)
  await f.unknown()
  const result=await f.recovery.reconcile(f.record.id)
  assert.equal(result.state,'released')
  assert.equal(result.execution.status,'completed')
  assert.equal(result.execution.isolated,false)
  assert.equal(result.execution.userMessage?.messageId,'actual-message')
  assert.equal(result.execution.turn?.id,'5')
  assert.equal(f.controller.forConversation(binding.conversationId),null)
  assert.equal(f.recovery.observations(f.record.id).length,1)
  assert.equal((await f.recovery.reconcile(f.record.id)).state,'released')
  assert.equal(f.inspected(),1)
  assert.equal(f.cancelled(),0)
  assert.doesNotThrow(()=>f.controller.admit({binding,requestId:'fresh-request',policyRevision:'a'.repeat(64)}))
})

test('absence, stale binding and conflicting user identity remain isolated with a concrete reason',async context=>{
  const f=fixture(context)
  await f.unknown()
  f.evidence({state:'not-observed',matchedUserMessageId:null,matchedTurn:null,outcome:null,userSequence:null,terminalSequence:null,checkpointSequence:null,checkpointHash:null,
    missingReasons:['execution_request_not_observed']})
  assert.deepEqual((await f.recovery.reconcile(f.record.id)).missingReasons,['execution_request_not_observed'])
  f.current(false)
  assert.deepEqual((await f.recovery.reconcile(f.record.id)).missingReasons,['execution_binding_changed'])
  assert.equal(f.inspected(),1)
  assert.equal(f.controller.get(f.record.id)?.isolated,true)
  f.current(true)
  f.controller.userMessage(f.record.id,{eventId:'trusted-receipt',messageId:'accepted-message',source:{kind:'user',rpcId:'request-1'}})
  f.evidence({state:'settled',matchedUserMessageId:'different-message',matchedTurn:5,outcome:'completed',userSequence:2,
    terminalSequence:7,checkpointSequence:7,checkpointHash:'b'.repeat(64),quiescent:true,missingReasons:[]})
  assert.deepEqual((await f.recovery.reconcile(f.record.id)).missingReasons,['execution_correlation_conflict'])
  assert.equal(f.controller.get(f.record.id)?.userMessage?.messageId,'accepted-message')
  assert.equal(f.controller.get(f.record.id)?.isolated,true)
})

test('uncertain cancellation cannot be cleared by old-turn completion, while an accepted cancellation plus durable abort can settle',async context=>{
  const unknown=fixture(context,'unknown')
  await unknown.unknown();unknown.expire()
  await awaitCondition(()=>unknown.controller.get(unknown.record.id)?.cancelStatus==='unknown',{timeoutMs:1000,message:'cancel outcome recorded'})
  const blocked=await unknown.recovery.reconcile(unknown.record.id)
  assert.equal(blocked.state,'blocked')
  assert.deepEqual(blocked.missingReasons,['execution_cancel_evidence_unknown'])
  assert.equal(blocked.execution.isolated,true)
  assert.equal(unknown.cancelled(),1)
  const accepted=fixture(context,'accepted')
  await accepted.unknown();accepted.expire()
  await awaitCondition(()=>accepted.controller.get(accepted.record.id)?.cancelStatus==='accepted',{timeoutMs:1000,message:'cancel acknowledgement recorded'})
  accepted.evidence({outcome:'cancelled'})
  const settled=await accepted.recovery.reconcile(accepted.record.id)
  assert.equal(settled.state,'released')
  assert.equal(settled.execution.cancelStatus,'confirmed')
  assert.equal(settled.execution.externalStatus,'cancelled')
  assert.equal(accepted.cancelled(),1)
})
