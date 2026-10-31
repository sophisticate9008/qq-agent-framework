import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOneBotMediaReader } from '../src/adapters/onebot-media.ts'
import { createOneBotActionPort } from '../src/adapters/onebot-actions.ts'

const signal = new AbortController().signal

test('protocol media reader uses fixed actions and bounded bytes from an explicitly trusted source without forwarding credentials', async context => {
  const received: {path:string;authorization:string|undefined}[] = []
  const server = createServer((request,response) => {
    received.push({path:request.url ?? '',authorization:request.headers.authorization})
    if(request.url==='/redirect') {response.writeHead(302,{location:'/secret'});response.end();return}
    if(request.url==='/large') {response.writeHead(200,{'content-length':'100'});response.end('x'.repeat(100));return}
    response.writeHead(200,{'content-type':'text/plain; charset=utf-8'});response.end('正文')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  context.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))})
  const address=server.address();assert(address&&typeof address==='object')
  const origin=`http://127.0.0.1:${address.port}`
  let path='/body'
  const actionsSeen:string[]=[]
  const actions=createOneBotActionPort({endpoint:'http://onebot.invalid',accessToken:'must-not-reach-download',allowedActions:['get_image','get_record','get_file','get_group_file_url','get_private_file_url'],
    async fetch(url,request){actionsSeen.push(String(url));assert.equal(new Headers(request?.headers).get('authorization'),'Bearer must-not-reach-download');
      if(String(url).endsWith('/get_group_file_url'))assert.deepEqual(JSON.parse(String(request?.body)),{group_id:'123',file_id:'opaque-id',busid:102});
      if(String(url).endsWith('/get_private_file_url'))assert.deepEqual(JSON.parse(String(request?.body)),{user_id:'456',file_id:'opaque-id',file_hash:'synthetic-file-hash'});
      return Response.json({status:'ok',retcode:0,data:{url:`${origin}${path}`,name:'report.txt'}})}})
  const reader=createOneBotMediaReader({actions,trustedOrigins:[origin],maxBytes:16,timeoutMs:1000})
  for(const kind of ['image','audio','file'] as const) {
    const result=await reader.read({kind,source:{file:'opaque-file',id:'opaque-id'},signal})
    assert.equal(result.status,'confirmed',JSON.stringify(result))
    if(result.status==='confirmed'){assert.equal(Buffer.from(result.data).toString('utf8'),'正文');assert.equal(result.mediaType,'text/plain')}
  }
  assert(actionsSeen[0]!.endsWith('/get_image'))
  assert(actionsSeen[1]!.endsWith('/get_record'))
  assert(actionsSeen[2]!.endsWith('/get_file'))
  assert.equal((await reader.read({kind:'file',conversationId:'group:123',source:{id:'opaque-id',busId:102},signal})).status,'confirmed')
  assert.equal((await reader.read({kind:'file',conversationId:'private:456',source:{id:'opaque-id',fileHash:'synthetic-file-hash'},signal})).status,'confirmed')
  assert(actionsSeen[3]!.endsWith('/get_group_file_url'))
  assert(actionsSeen[4]!.endsWith('/get_private_file_url'))
  assert(received.every(entry=>entry.authorization===undefined))
  const beforeDirect = actionsSeen.length
  for (const kind of ['image', 'audio', 'file'] as const) {
    assert.equal((await reader.read({kind,source:{url:`${origin}/body`,file:'stale-pointer',id:'stale-id'},signal})).status,'confirmed')
  }
  assert.equal(actionsSeen.length,beforeDirect,'Registered URLs bypass protocol cache lookups for forwarded and collected media.')
  path='/redirect';assert.deepEqual(await reader.read({kind:'image',source:{file:'opaque-file'},signal}),{status:'rejected',code:'ONEBOT_MEDIA_HTTP_REJECTED'})
  assert(!received.some(entry=>entry.path==='/secret'))
  path='/large';assert.deepEqual(await reader.read({kind:'image',source:{file:'opaque-file'},signal}),{status:'rejected',code:'ONEBOT_MEDIA_TOO_LARGE'})
  const before=received.length
  path='/body'
  assert.deepEqual(await createOneBotMediaReader({actions}).read({kind:'image',source:{file:'opaque-file'},signal}),{status:'rejected',code:'ONEBOT_MEDIA_ORIGIN_REJECTED'})
  assert.equal(received.length,before,'A protocol-returned private URL is not implicit network permission.')
})

test('unsupported file reads and unavailable URLs stay explicit, and cancellation bounds an uncooperative read action', async () => {
  const actions=createOneBotActionPort({endpoint:'http://onebot.invalid',async fetch(){return Response.json({status:'ok',retcode:0,data:{file:'/server/private/path'}})}})
  const reader=createOneBotMediaReader({actions,timeoutMs:20})
  assert.deepEqual(await reader.read({kind:'file',source:{id:'file-id'},signal}),{status:'rejected',code:'ONEBOT_ACTION_UNSUPPORTED'})
  assert.deepEqual(await reader.read({kind:'image',source:{file:'opaque'},signal}),{status:'rejected',code:'ONEBOT_MEDIA_URL_UNAVAILABLE'})
  const stalled={...actions,getImage:()=>new Promise<never>(()=>{})}
  const guard=setTimeout(()=>{},1000)
  try{assert.deepEqual(await createOneBotMediaReader({actions:stalled,timeoutMs:20}).read({kind:'image',source:{file:'opaque'},signal}),
    {status:'unknown',code:'ONEBOT_MEDIA_TIMEOUT_UNKNOWN'})}finally{clearTimeout(guard)}
})

test('collection URLs use the full media deadline while refreshable pointers retain a shorter first attempt', async context => {
  const server = createServer((_request, response) => response.end('image-bytes'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const actions = createOneBotActionPort({ endpoint: 'http://onebot.invalid' })
  const original = AbortSignal.timeout.bind(AbortSignal), deadlines: number[] = []
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { deadlines.push(milliseconds); return original(milliseconds) })
  const reader = createOneBotMediaReader({ actions, trustedOrigins: [origin], timeoutMs: 15000 })
  assert.equal((await reader.read({ kind: 'image', source: { url: origin + '/image' }, signal })).status, 'confirmed')
  assert.deepEqual(deadlines, [15000])
  deadlines.length = 0
  assert.equal((await reader.read({ kind: 'image', source: { url: origin + '/image', file: 'refreshable' }, signal })).status, 'confirmed')
  assert.deepEqual(deadlines, [15000, 5000])
})
