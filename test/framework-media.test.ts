import test from 'node:test'
import assert from 'node:assert/strict'
import { FRAMEWORK_MEDIA_IMAGE_BYTES, FRAMEWORK_MEDIA_PROTOCOL, parseNativeMediaReadEnvelope } from '../src/contracts/framework-media.ts'
import { makeFrameworkMediaResultProjector } from '../src/host/framework-media.ts'
import { createFrameworkToolRegistry } from '../src/host/framework-tools.ts'
import type { FrameworkToolDefinition } from '../src/contracts/framework-tools.ts'

const definition: FrameworkToolDefinition={name:'qaf_media_read',description:'Read scoped media',featureId:'media',capability:'native.media.read',timeoutMs:1000,
  parameters:{type:'object',properties:{},additionalProperties:false}}
const envelope={schema:FRAMEWORK_MEDIA_PROTOCOL,contentRead:true as const,kind:'image' as const,mediaType:'image/png' as const,data:'AQIDBA=='}

test('only trusted media capability projection creates structured content and removes encoded bytes from canonical text',()=>{
  const project=makeFrameworkMediaResultProjector()
  const result=project(definition,envelope)
  assert.deepEqual(result.content,[{type:'image',mediaType:'image/png',data:'AQIDBA=='}])
  assert(!JSON.stringify(result.value).includes('AQIDBA'))
  assert.deepEqual(project({...definition,capability:'some.other'},envelope),{value:envelope})
  assert.equal(parseNativeMediaReadEnvelope({...envelope,data:Buffer.alloc(FRAMEWORK_MEDIA_IMAGE_BYTES+1).toString('base64')}),null)
  assert.equal(parseNativeMediaReadEnvelope({...envelope,url:'https://untrusted.invalid'}),null)
  assert.deepEqual(project(definition,{schema:FRAMEWORK_MEDIA_PROTOCOL,contentRead:false,kind:'audio',reason:'transcription_unavailable'}),
    {value:{schema:FRAMEWORK_MEDIA_PROTOCOL,contentRead:false,kind:'audio',reason:'transcription_unavailable'}})
})

test('registry invokes fixed policy capability before projecting explicitly registered media results',async()=>{
  const order:string[]=[]
  const project=makeFrameworkMediaResultProjector()
  const registry=createFrameworkToolRegistry({async resolveScope(call){return{eventId:'trusted-qq',conversationId:'group:123',sessionId:call.sessionId,generation:call.generation,featureId:'media',version:'1'}},
    async invoke(capability){order.push(capability);return envelope},projectResult(definition,value){order.push('project');return project(definition,value)}})
  registry.register(definition,value=>value)
  const result=await registry.execute({id:'call',sessionId:'session',generation:3,requestId:'request',userMessageId:'user-message',turn:1,name:definition.name,input:{},expiresAt:Date.now()+1000},new AbortController().signal)
  assert.equal(result.status,'confirmed')
  if(result.status==='confirmed'){assert.equal(result.content?.[0]?.type,'image');assert(!JSON.stringify(result.value).includes('AQIDBA'))}
  assert.deepEqual(order,['native.media.read','project'])
  registry.close()
})
