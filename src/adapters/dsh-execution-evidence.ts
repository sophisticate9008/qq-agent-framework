import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidence, type DshExecutionEvidenceRequest } from '../contracts/dsh-execution-evidence.ts'
import { validIdentifier } from '../contracts/dsh-bridge.ts'
import { isRecord, snapshot } from '../core/values.ts'
import { DshAdapterError } from './dsh.ts'

export async function readDshExecutionEvidence(request: DshExecutionEvidenceRequest, issuerEpoch: string, signal: AbortSignal,
  invoke: (request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>): Promise<DshExecutionEvidence> {
  const invalid = (): never => { throw new DshAdapterError('DSH_EXECUTION_EVIDENCE_INVALID', 'The execution checkpoint evidence could not be verified.') }
  if (!request || Object.keys(request).some(key => !['sessionId','requestId','userMessageId','turn'].includes(key))
    || !validIdentifier(request.sessionId) || !validIdentifier(request.requestId) || !validIdentifier(issuerEpoch)
    || request.userMessageId !== undefined && !validIdentifier(request.userMessageId)
    || request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 1)) return invalid()
  signal.throwIfAborted()
  const value = snapshot(await invoke({ ...request }, signal))
  signal.throwIfAborted()
  const fields=['sessionId','requestId',...(request.userMessageId===undefined?[]:['userMessageId']),...(request.turn===undefined?[]:['turn']),
    'schema','protocol','issuerEpoch','state','matchedUserMessageId','matchedTurn','outcome','userSequence','terminalSequence','checkpointSequence','checkpointHash','quiescent','missingReasons']
  if (!isRecord(value) || Object.keys(value).length!==fields.length || !fields.every(key=>Object.hasOwn(value,key))
    || value.schema!==1 || value.protocol!==DSH_EXECUTION_EVIDENCE_PROTOCOL || value.issuerEpoch!==issuerEpoch
    || Object.entries(request).some(([key,expected])=>value[key]!==expected)
    || !['settled','pending','not-observed','unavailable'].includes(String(value.state)) || typeof value.quiescent!=='boolean'
    || value.matchedUserMessageId!==null&&!validIdentifier(value.matchedUserMessageId)
    || value.matchedTurn!==null&&(!Number.isSafeInteger(value.matchedTurn)||Number(value.matchedTurn)<1)
    || ![null,'completed','failed','cancelled'].includes(value.outcome as string|null)
    || ['userSequence','terminalSequence','checkpointSequence'].some(key=>value[key]!==null&&(!Number.isSafeInteger(value[key])||Number(value[key])<0))
    || value.checkpointHash!==null&&(typeof value.checkpointHash!=='string'||!/^[a-f0-9]{64}$/.test(value.checkpointHash))
    || !Array.isArray(value.missingReasons)||value.missingReasons.length>16||value.missingReasons.some(reason=>typeof reason!=='string'||!/^execution_[a-z_]{1,79}$/.test(reason))) return invalid()
  if (value.state==='settled' ? !value.quiescent || value.outcome===null || value.matchedUserMessageId===null || value.matchedTurn===null
    || value.userSequence===null || value.terminalSequence===null || value.checkpointSequence===null || value.checkpointHash===null
    || Number(value.userSequence)>=Number(value.terminalSequence)||Number(value.terminalSequence)>Number(value.checkpointSequence)||value.missingReasons.length!==0
    : value.outcome!==null||value.checkpointHash!==null||value.terminalSequence!==null||value.checkpointSequence!==null||value.missingReasons.length===0) return invalid()
  if (value.state==='settled' && (request.userMessageId!==undefined&&value.matchedUserMessageId!==request.userMessageId
    || request.turn!==undefined&&value.matchedTurn!==request.turn)) return invalid()
  return value as unknown as DshExecutionEvidence
}
