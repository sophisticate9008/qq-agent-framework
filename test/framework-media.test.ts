import test from 'node:test'
import assert from 'node:assert/strict'
import { FRAMEWORK_MEDIA_IMAGE_BYTES, FRAMEWORK_MEDIA_PROTOCOL, parseNativeMediaReadEnvelope } from '../src/contracts/framework-media.ts'
import { makeFrameworkMediaResultProjector } from '../src/host/framework-media.ts'
import { createFrameworkToolRegistry } from '../src/host/framework-tools.ts'
import type { FrameworkToolDefinition } from '../src/contracts/framework-tools.ts'

const definition: FrameworkToolDefinition={name:'qbf_media_read',description:'Read scoped media',featureId:'media',capability:'native.media.read',timeoutMs:1000,
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

test('contact-sheet envelopes keep cell times, reject malformed grids and project all four positions', () => {
  const frame = { timeSeconds: 0, mediaType: 'image/jpeg', data: 'AQIDBA==', grid: { columns: 2, rows: 2, width: 960, height: 540, times: [0, 1, 2, 3] } }
  const video = { schema: FRAMEWORK_MEDIA_PROTOCOL, kind: 'video', contentRead: true, durationSeconds: 10, frames: [frame],
    coverage: 'sampled-frames-only', audioObserved: false, hasAudio: false }
  assert(parseNativeMediaReadEnvelope(video))
  const projected = makeFrameworkMediaResultProjector()(definition, video)
  assert.match(JSON.stringify(projected.value), /"times":\[0,1,2,3\]/)
  assert.match(JSON.stringify(projected.content?.[0]), /左上、右上、左下、右下/)
  for (const grid of [{ ...frame.grid, columns: 3 }, { ...frame.grid, times: [0, 1, 1, 3] },
    { ...frame.grid, times: [0, 1, 2, 11] }, { ...frame.grid, width: 4000 }, { ...frame.grid, times: [0, 1, 2, 3, 4] }]) {
    assert.equal(parseNativeMediaReadEnvelope({ ...video, frames: [{ ...frame, grid }] }), null)
  }
  assert.equal(parseNativeMediaReadEnvelope({ ...video, frames: [frame, { timeSeconds: 4, mediaType: 'image/jpeg', data: 'AQIDBA==' }] }), null)
})


test('six contact sheets fit the new batch budget while individual and aggregate limits remain enforced', () => {
  const frame = (index: number, bytes: number) => ({ timeSeconds: index * 4, mediaType: 'image/jpeg', data: Buffer.alloc(bytes).toString('base64'),
    grid: { columns: 2, rows: 2, width: 960, height: 540, times: [0, 1, 2, 3].map(time => time + index * 4) } })
  const video = { schema: FRAMEWORK_MEDIA_PROTOCOL, kind: 'video', contentRead: true, durationSeconds: 24,
    frames: Array.from({ length: 6 }, (_, index) => frame(index, 256 * 1024)), coverage: 'sampled-frames-only', audioObserved: false, hasAudio: false }
  assert(parseNativeMediaReadEnvelope(video))
  assert.equal(makeFrameworkMediaResultProjector()(definition, video).content?.length, 7)
  assert.equal(parseNativeMediaReadEnvelope({ ...video, frames: [frame(0, 256 * 1024 + 1)] }), null)
  assert.equal(parseNativeMediaReadEnvelope({ ...video, frames: [...video.frames, frame(6, 1)] }), null)
})
