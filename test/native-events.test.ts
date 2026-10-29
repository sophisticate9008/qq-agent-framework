import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeEventObserver } from '../src/host/native-events.ts'
import { createNativeActivity } from '../src/host/native-activity.ts'
import { isNativeEventPage, isNativeObservationEvent, type NativeEventInput } from '../src/contracts/native-events.ts'
import { mapDshObservation, mapNativeToolObservation, mapOneBotProtocolObservation } from '../src/host/native-event-mapping.ts'
import type { JsonObject } from '../src/contracts/data.ts'
import { normalizeOneBotProtocolEvent } from '../src/adapters/onebot-events.ts'

const input = (conversationId = 'private:123'): NativeEventInput => ({source:'host',kind:'execution',status:'progress',correlation:{conversationId,sessionId:'session-1',generation:2,executionId:'execution-1',requestId:'request-1'}})

test('versioned bounded observation pages expose process cursors, immutable metadata and explicit retention gaps',()=>{
  const observer=createNativeEventObserver({capacity:3,epoch:'epoch-1',now:()=>100})
  for(let index=0;index<5;index++)observer.record(input())
  const page=observer.read({after:{epoch:'epoch-1',sequence:0},limit:2})
  assert.equal(page.gap,'retention');assert.deepEqual(page.events.map(event=>event.cursor.sequence),[3,4])
  assert.deepEqual(page.nextCursor,{epoch:'epoch-1',sequence:4})
  assert(isNativeEventPage(page));assert(Object.isFrozen(page.events[0]!.correlation))
  const end=observer.read({after:page.nextCursor})
  assert.deepEqual(end.events.map(event=>event.cursor.sequence),[5]);assert.equal(end.gap,'none')
  const restarted=createNativeEventObserver({epoch:'epoch-2'})
  assert.equal(restarted.read({after:page.nextCursor}).gap,'epoch')
  assert.throws(()=>observer.read({after:{epoch:'epoch-1',sequence:6}}),{code:'EVENT_CURSOR_AHEAD'})
  assert(!isNativeEventPage({...page,protocol:'qbf.events/2'}))
  assert(!isNativeObservationEvent({...page.events[0],content:'private model body'}))
})

test('filters advance over unmatched observations without creating false sequence gaps',()=>{
  const observer=createNativeEventObserver({capacity:10,epoch:'filter-epoch'})
  observer.record(input('private:111'));observer.record(input('private:123'));observer.record(input('private:111'))
  const page=observer.read({after:{epoch:'filter-epoch',sequence:0},filter:{conversationId:'private:123',statuses:['progress']}})
  assert.equal(page.gap,'none');assert.equal(page.events.length,1);assert.equal(page.nextCursor.sequence,3)
  assert.deepEqual(observer.read({after:page.nextCursor,filter:{kinds:['tool']}}).events,[])
  assert.throws(()=>Reflect.apply(observer.read,undefined,[{filter:{content:'forbidden'}}]),{code:'EVENT_QUERY_INVALID'})
})

test('subscriptions isolate slow consumers, terminate overflow explicitly and resume from the last seen cursor',async()=>{
  const observer=createNativeEventObserver({epoch:'live-epoch',capacity:10})
  const slow=observer.subscribe({capacity:1})
  const healthy=observer.subscribe({capacity:5})
  observer.record(input());observer.record(input())
  await assert.rejects(slow.next(),{code:'EVENT_BACKPRESSURE'})
  assert.equal((await slow.next()).done,true)
  const first=await healthy.next();assert(!first.done&&first.value.type==='event')
  assert.equal(first.value.event.cursor.sequence,1)
  const resumed=observer.subscribe({after:first.value.event.cursor,capacity:5})
  const second=await resumed.next();assert(!second.done&&second.value.type==='event')
  assert.equal(second.value.event.cursor.sequence,2)
  await healthy.return!();await resumed.return!()
  assert.equal(observer.metrics().subscribers,0)
})

test('retention and restart gaps are delivered before resumed events; abort and close release pending reads',async()=>{
  const observer=createNativeEventObserver({epoch:'new-epoch',capacity:2})
  for(let index=0;index<3;index++)observer.record(input())
  const resumed=observer.subscribe({after:{epoch:'old-epoch',sequence:100}})
  const first=await resumed.next();assert(!first.done&&first.value.type==='gap');assert.equal(first.value.reason,'epoch')
  const event=await resumed.next();assert(!event.done&&event.value.type==='event');assert.equal(event.value.event.cursor.sequence,2)
  await resumed.return!()
  const abort=new AbortController();const live=observer.subscribe({signal:abort.signal})
  const waiting=live.next()
  await assert.rejects(live.next(),{code:'EVENT_SUBSCRIPTION_BUSY'})
  abort.abort('a private reason must not escape')
  await assert.rejects(waiting,{code:'EVENT_SUBSCRIPTION_ABORTED'})
  assert.equal(observer.metrics().subscribers,0)
  const closing=observer.subscribe();const pending=closing.next();observer.close()
  assert.equal((await pending).done,true)
  assert.throws(()=>observer.record(input()),{code:'EVENT_STREAM_CLOSED'})
})

test('resuming a backlog larger than the consumer queue reports overflow rather than silently dropping events',async()=>{
  const observer=createNativeEventObserver({epoch:'queue-epoch'})
  observer.record(input());observer.record(input())
  const live=observer.subscribe({after:{epoch:'queue-epoch',sequence:0},capacity:1})
  await assert.rejects(live.next(),{code:'EVENT_BACKPRESSURE'})
  assert.equal(observer.metrics().subscribers,0)
})

test('existing native activity publishes versioned metadata while legacy content stays outside event observation',()=>{
  const activity=createNativeActivity({now:()=>123})
  activity.record('received','private:123','private-message-secret',{sessionId:'session-1',generation:1,requestId:'request-1'})
  activity.record('accepted','private:123')
  activity.record('send_confirmed','private:123','private-result-secret')
  const page=activity.events()
  assert(isNativeEventPage(page));assert.deepEqual(page.events.map(event=>event.status),['received','accepted','sent'])
  assert.equal(page.events[0]!.correlation.requestId,'request-1')
  assert(!JSON.stringify(page).includes('secret'));assert(!JSON.stringify(page).includes('content'))
})

test('real DSH event vocabulary preserves correlation and distinguishes synthetic ends and tool failures without copying payloads',()=>{
  const frame=(type:string,data:JsonObject)=>
    ({type:'session/event' as const,sessionId:'session-1',event:{type,seq:7,data}})
  const terminal=mapDshObservation(frame('turn/end',{turn:2,reason:{kind:'completed'}}),{conversationId:'private:123',requestId:'request-2'})!
  assert.equal(terminal.status,'completed');assert.equal(terminal.correlation.sourceSequence,7);assert.equal(terminal.correlation.requestId,'request-2')
  assert.equal(mapDshObservation(frame('turn/end',{turn:2,reason:{kind:'interrupted'}}))?.status,'unknown')
  const call=mapDshObservation(frame('tool/call',{turn:2,step:1,callId:'call-1',arguments:'private-arguments'}))!
  assert.equal(call.kind,'tool');assert.equal(call.status,'started');assert(!JSON.stringify(call).includes('private-arguments'))
  const result=mapDshObservation(frame('tool/result',{turn:2,step:1,message:{role:'tool',toolCallId:'call-1',isError:true,content:['private-result']}}))!
  assert.equal(result.status,'failed');assert(!JSON.stringify(result).includes('private-result'))
  assert.equal(mapDshObservation(frame('assistant/message',{turn:2})),null)
  assert.equal(mapDshObservation(frame('turn/start',{})),null)
  assert.equal(mapDshObservation(frame('turn/start',{turn:2}),{sessionId:'other-session'}),null)
})

test('OneBot lifecycle observations require the strict normalized protocol and tools never expose model input or result bodies',()=>{
  const protocol=normalizeOneBotProtocolEvent({post_type:'meta_event',meta_event_type:'heartbeat',self_id:999,time:100,interval:1000,status:{good:true,online:true}},
    {selfId:'999',receivedAt:100000})!
  assert.equal(mapOneBotProtocolObservation(protocol)?.status,'connected')
  assert.equal(mapOneBotProtocolObservation({...protocol,data:{...protocol.data,good:'true'}}),null)
  const tool=mapNativeToolObservation({id:'call-1',sessionId:'session-1',generation:1,requestId:'request-1',userMessageId:'message-1',turn:1,
    name:'qbf_media_read',input:{private:'input'},expiresAt:1000},{status:'confirmed',value:{private:'result'}},'private:123')!
  assert.equal(tool.status,'completed');assert.equal(tool.correlation.toolCallId,'call-1')
  assert(!JSON.stringify(tool).includes('private":"'))
})
