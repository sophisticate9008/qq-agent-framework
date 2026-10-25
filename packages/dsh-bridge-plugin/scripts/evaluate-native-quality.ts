import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,isAbsolute} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Llm,{LlmAdapter,ReasoningEffortId,createUserMessage,createAssistantMessage,type GenerateOptions,type StreamChunk,type TokenUsage} from '@deepseek-ai/dsh-llm'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import type {CredentialKey,CredentialRecord} from '@deepseek-ai/dsh-credentials'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import {parseDocument} from 'yaml'
import {createQualityBudget,QUALITY_LIMITS,type QualityUsage} from './native-quality-budget.ts'

interface Sample {readonly id:string;readonly prompt:string;readonly expected:string;readonly rubric:string}
interface Dataset {readonly schema:1;readonly system:string;readonly samples:readonly Sample[]}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const fail=(code:string):never=>{throw Error(code)}

async function dataset(frameworkRoot:string):Promise<{data:Dataset;score:(id:string,text:string)=>unknown}> {
  const module:unknown=await import(pathToFileURL(join(frameworkRoot,'scripts/native-quality-samples.ts')).href)
  assert(object(module)&&typeof module.createNativeQualitySamples==='function'&&typeof module.scoreNativeQualityReply==='function','QUALITY_DATASET_INVALID')
  const score=module.scoreNativeQualityReply
  const data:unknown=module.createNativeQualitySamples()
  assert(object(data)&&data.schema===1&&typeof data.system==='string'&&Array.isArray(data.samples)&&data.samples.length>=10&&data.samples.length<=12
    &&data.samples.every(sample=>object(sample)&&typeof sample.id==='string'&&/^[a-z-]{1,64}$/.test(sample.id)
      &&typeof sample.prompt==='string'&&typeof sample.expected==='string'&&typeof sample.rubric==='string'),'QUALITY_DATASET_INVALID')
  return {data:data as unknown as Dataset,score:(id,text)=>Reflect.apply(score,undefined,[id,text]) as unknown}
}
async function yamlFile(filename:string):Promise<unknown>{
  const raw=await readFile(filename,'utf8');assert(Buffer.byteLength(raw)<=2*1024*1024,'QUALITY_CONFIGURATION_INVALID')
  const document=parseDocument(raw,{strict:true,uniqueKeys:true,prettyErrors:false,logLevel:'silent'})
  assert(document.errors.length===0&&document.warnings.length===0,'QUALITY_CONFIGURATION_INVALID')
  return document.toJS({maxAliasCount:0}) as unknown
}
async function providerConfiguration(bridgeRoot:string,requestTimeoutMs:number=QUALITY_LIMITS.requestTimeoutMs) {
  const models:unknown=JSON.parse(await readFile(join(bridgeRoot,'config/local/models.json'),'utf8'))
  assert(object(models)&&object(models.deepseekRouting)&&object(models.deepseekPrimary),'QUALITY_CONFIGURATION_INVALID')
  const route=models.deepseekRouting.activeProvider
  const selected=models.deepseekPrimary
  assert(route==='deepseek-primary'&&selected.provider===route&&typeof selected.model==='string'&&selected.modelVerified===true
    &&selected.thinking==='disabled'&&typeof selected.baseUrl==='string','QUALITY_PROVIDER_CHANGED')
  const provider='deepseek-primary'
  const model=selected.model
  const patch=await yamlFile(join(bridgeRoot,'dsh/home/profiles/web/cordis.patch.yml'))
  let profile:Record<string,unknown>|undefined
  let visited=0
  function walk(value:unknown){
    if(!object(value)&&!Array.isArray(value))return
    assert(++visited<100000,'QUALITY_CONFIGURATION_INVALID')
    if(object(value)&&object(value.providers)&&object(value.providers[provider]))profile={...profile,...value.providers[provider]}
    for(const child of Object.values(value))walk(child)
  }
  walk(patch)
  assert(profile&&profile.api==='openai-completions'&&typeof profile.baseURL==='string'&&Array.isArray(profile.models),'QUALITY_PROTOCOL_UNVERIFIED')
  const endpoint=new URL(profile.baseURL)
  assert(endpoint.origin===new URL(selected.baseUrl).origin&&['https:','http:'].includes(endpoint.protocol)
    &&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'QUALITY_PROTOCOL_UNVERIFIED')
  const candidates=profile.models.filter(model=>object(model)&&model.id===selected.model)
  assert(candidates.length===1&&object(candidates[0])&&object(candidates[0].reasoningEfforts)&&candidates[0].reasoningEfforts.off==='off','QUALITY_MODEL_UNVERIFIED')
  const secretFile=await yamlFile(join(bridgeRoot,'dsh/home/.credentials.yaml'))
  assert(object(secretFile)&&object(secretFile.refs)&&typeof profile.apiKeyEnv==='string','QUALITY_CREDENTIAL_UNAVAILABLE')
  const secret=secretFile.refs[profile.apiKeyEnv]
  assert(typeof secret==='string'&&secret.trim().length>0,'QUALITY_CREDENTIAL_UNAVAILABLE')
  const configuration=PiAi.Config({providers:{[provider]:{...profile,apiKeyEnv:'QUALITY_ONLY_API_KEY',models:[{...candidates[0],id:model}],timeoutMs:requestTimeoutMs,streamIdleTimeoutMs:requestTimeoutMs,
    retryPolicy:{mode:'normal',maxRetries:0}}}})
  return {provider,model,secret,configuration,origin:endpoint.origin}
}

export async function inspectQualityProvider(bridgeRoot:string){
  const target=await providerConfiguration(bridgeRoot)
  const configured=target.configuration.providers.get()[target.provider]
  return {provider:target.provider,model:target.model,protocol:'openai-completions',configuredProtocol:configured?.api,
    configuredModelCount:configured?.models?.length,credentialConfigured:true,retries:0,maxOutputTokens:256}
}

class DryRunAdapter extends LlmAdapter {
  override async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
    const prompt=options.messages.map(message=>JSON.stringify(message.content)).join('\n')
    const silent=prompt.includes('synthetic-others-conversation')||prompt.includes('synthetic-quoted-old-name')||prompt.includes('synthetic-owner-ambient')
    const text=silent?'序列化评估替身，不作真实质量证据。':'仅评估预算与SDK路径，不作真实质量证据。'
    yield {type:'text-delta',index:0,text}
    yield {type:'usage',usage:{inputTokens:2500,outputTokens:50,totalTokens:2550}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}

export async function evaluateNativeQuality(options:{frameworkRoot:string;bridgeRoot?:string;execute:boolean;blockNetwork?:boolean;availabilityProbe?:boolean;previousBudgetChargedTokens?:number;
  evaluationSampleId?:string;evaluationDeadline?:number;maximumObservedTokens?:number;evaluationOutputTokens?:512}) {
  assert(isAbsolute(options.frameworkRoot)&&(!options.execute||options.bridgeRoot&&isAbsolute(options.bridgeRoot)),'QUALITY_OPTIONS_INVALID')
  const {data,score}=await dataset(options.frameworkRoot)
  const directory=await mkdtemp(join(tmpdir(),'qqaf-quality-'));await chmod(directory,0o700)
  const previousHome=process.env.DSH_HOME;process.env.DSH_HOME=directory
  const ctx=new Context();ctx.baseUrl=import.meta.url;ctx.logger.exporter({export(){}})
  const extended=options.evaluationSampleId!==undefined
  assert(!extended||options.execute&&typeof options.evaluationDeadline==='number'&&Number.isSafeInteger(options.evaluationDeadline)
    &&options.evaluationDeadline>Date.now()&&options.evaluationDeadline<=Date.now()+900000
    &&typeof options.maximumObservedTokens==='number'&&Number.isSafeInteger(options.maximumObservedTokens)&&options.maximumObservedTokens>=24583
    &&data.samples.some(sample=>sample.id===options.evaluationSampleId&&sample.id!=='direct-mention'),'QUALITY_OPTIONS_INVALID')
  assert(options.evaluationOutputTokens===undefined||extended&&options.evaluationOutputTokens===512,'QUALITY_OPTIONS_INVALID')
  const limits=extended?{...QUALITY_LIMITS,samples:1,maxOutputTokens:options.evaluationOutputTokens??QUALITY_LIMITS.maxOutputTokens,requestTimeoutMs:90000,totalTimeoutMs:Math.min(90000,options.evaluationDeadline!-Date.now()),totalTokens:400000}
    :options.availabilityProbe?{...QUALITY_LIMITS,samples:1,requestTimeoutMs:90000,totalTimeoutMs:90000}:QUALITY_LIMITS
  const budget=createQualityBudget(()=>performance.now(),options.previousBudgetChargedTokens??0,limits.totalTokens,limits.maxOutputTokens)
  const reports:Record<string,unknown>[]=[]
  const responses:{id:string;text:string}[]=[]
  const mode=options.blockNetwork?'protocol-preflight':options.execute?extended?'real-model-quality':options.availabilityProbe?'real-model-availability':'real-model':'dry-run'
  const originalFetch=globalThis.fetch
  let wireRequests=0;let caseWireRequests=0;let caseWireAttempts=0;let activeCase=false
  let requestLimit:{field:'max_tokens'|'max_completion_tokens';value:number}|null=null
  let provider='offline-fixture';let model='offline-fixture'
  try {
    const projection=ctx.plugin(Projections);const sessions=ctx.plugin(Sessions);const llm=ctx.plugin(Llm)
    await Promise.all([projection.inertia,sessions.inertia,llm.inertia])
    if(options.execute){
      const target=await providerConfiguration(options.bridgeRoot!,limits.requestTimeoutMs)
      provider=target.provider;model=target.model
      const records=new Map<CredentialKey,CredentialRecord>()
      ctx.provide('credentials',{
        async resolve(reference:string){return reference==='QUALITY_ONLY_API_KEY'?{value:target.secret,source:'isolated-evaluation'}:undefined},
        async readRecord(key:CredentialKey){return records.get(key)},async listRecords(){return []},
        async modifyRecord(key:CredentialKey,mutate:(record:CredentialRecord|undefined)=>Promise<CredentialRecord|undefined>){const next=await mutate(records.get(key));if(next)records.set(key,next);return records.get(key)},
        async deleteRecord(key:CredentialKey){records.delete(key)},
      })
      globalThis.fetch=async(input,init)=>{
        const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
        const method=init?.method??(input instanceof Request?input.method:'GET')
        assert(activeCase&&url.origin===target.origin&&method==='POST'&&caseWireRequests===0&&wireRequests<limits.samples,'QUALITY_WIRE_BOUND')
        const body:unknown=JSON.parse(typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():'null')
        assert(object(body),'QUALITY_REQUEST_INVALID')
        const field=typeof body.max_tokens==='number'?'max_tokens':'max_completion_tokens'
        assert(body[field]===limits.maxOutputTokens,'QUALITY_REQUEST_OUTPUT_CAP_MISSING')
        requestLimit={field,value:limits.maxOutputTokens}
        caseWireAttempts++
        if(options.blockNetwork)fail('QUALITY_NETWORK_PREVIEW')
        caseWireRequests++;wireRequests++
        return originalFetch(input,{...init,redirect:'error'})
      }
      PiAi.apply(ctx,target.configuration)
      await new Promise<void>(ready=>setImmediate(ready))
    } else ctx.llm.registerAdapter([provider],new DryRunAdapter())
    for(const sample of (extended?data.samples.filter(sample=>sample.id===options.evaluationSampleId):data.samples.slice(0,limits.samples))){
      const at=performance.now()
      let text='';let usage:TokenUsage|null=null;let state='completed';let code:string|null=null;let providerErrorCode:string|null=null;let reserved=false
      caseWireRequests=0;caseWireAttempts=0;requestLimit=null;activeCase=true
      const signal=AbortSignal.timeout(Math.max(1,Math.floor(Math.min(limits.requestTimeoutMs,limits.totalTimeoutMs-budget.status().elapsedMs))))
      try {
        budget.reserve(Buffer.byteLength(data.system)+Buffer.byteLength(sample.prompt),extended?Math.max(30000,Math.ceil(options.maximumObservedTokens!*1.2)):0);reserved=true
        const session=ctx.sessions.create(SessionId(`quality-${sample.id}`),{meta:{cwd:directory}})
        const message=createUserMessage({source:{kind:'user',rpcId:`quality-${sample.id}`},content:[{type:'text',text:sample.prompt}]})
        session.append('user/message',message,{surfaceOp:'append'})
        let finished=false
        for await(const chunk of ctx.llm.stream({provider,model,...(options.execute?{reasoningEffort:ReasoningEffortId('off')}:{}) ,system:data.system,
          messages:[message],sessionId:session.id,maxTokens:limits.maxOutputTokens,signal})){
          signal.throwIfAborted()
          if(chunk.type==='text-delta'){text+=chunk.text;if(Buffer.byteLength(text)>16384)fail('QUALITY_OUTPUT_BOUND')}
          else if(chunk.type==='usage')usage=chunk.usage
          else if(chunk.type==='finish'){
            finished=true
            if((chunk.reason.kind==='error'||chunk.reason.kind==='aborted')&&/^[A-Z_]{1,64}$/.test(chunk.reason.failure.code))providerErrorCode=chunk.reason.failure.code
            if(chunk.reason.kind!=='stop')fail(chunk.reason.kind==='max-tokens'?'QUALITY_OUTPUT_TRUNCATED':chunk.reason.kind==='aborted'?'QUALITY_REQUEST_TIMEOUT':'QUALITY_PROVIDER_ERROR')
          }
        }
        if(!finished||!text.trim())fail('QUALITY_PROVIDER_EMPTY')
        session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider,model},content:[{type:'text',text}]}),stream:[]},{surfaceOp:'append'})
      } catch(error){
        state='failed';code=signal.aborted?'QUALITY_REQUEST_TIMEOUT':error instanceof Error&&/^QUALITY_[A-Z_]{1,60}$/.test(error.message)?error.message:'QUALITY_PROVIDER_ERROR'
      }
      const actual:QualityUsage|null=usage&&typeof usage.totalTokens==='number'?{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.totalTokens,
        ...(usage.cacheReadTokens===undefined?{}:{cacheReadTokens:usage.cacheReadTokens}),...(usage.cacheWriteTokens===undefined?{}:{cacheWriteTokens:usage.cacheWriteTokens})}:null
      if(reserved&&!budget.settle(actual)){state='failed';code??='QUALITY_USAGE_UNKNOWN'}
      if(actual&&actual.outputTokens>limits.maxOutputTokens){state='failed';code??='QUALITY_OUTPUT_BUDGET_EXCEEDED'}
      responses.push({id:sample.id,text})
      activeCase=false
      reports.push({id:sample.id,state,errorCode:code,providerErrorCode,requestLimit,wireRequests:caseWireRequests,wireAttempts:caseWireAttempts,latencyMs:Math.round(performance.now()-at),usage:actual,assessment:state==='completed'?score(sample.id,text):null,
        humanAssessment:null,cost:null,costState:'provider-price-unknown'})
      if(state==='failed'||budget.status().stopped)break
    }
  } finally {
    globalThis.fetch=originalFetch
    await ctx.fiber.dispose()
    if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome
    await writeFile(join(directory,'responses.json'),JSON.stringify({schema:1,mode,responses},null,2),{mode:0o600,flag:'wx'})
    await writeFile(join(directory,'summary.json'),JSON.stringify({schema:1,mode,provider,model,promptRevision:createHash('sha256').update(data.system).digest('hex'),wireRequests,limits,budget:budget.status(),
      planned:data.samples.length,completed:reports.filter(report=>report.state==='completed').length,skipped:data.samples.filter(sample=>!reports.some(report=>report.id===sample.id)).map(sample=>sample.id),reports,
      scope:'synthetic QQ input with current framework prompts in isolated official SDK sessions; no QQ transport or external tools',cost:null,costState:'provider-price-unknown'},null,2),{mode:0o600,flag:'wx'})
  }
  return {directory,summary:join(directory,'summary.json'),mode,completed:reports.filter(report=>report.state==='completed').length,attempted:budget.status().calls}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2)
  const execute=args.includes('--execute');const framework=args.find(value=>value.startsWith('--framework-root='))?.slice(17)
  const bridge=args.find(value=>value.startsWith('--bridge-root='))?.slice(14)
  if(!framework||args.some(value=>value!=='--execute'&&!value.startsWith('--framework-root=')&&!value.startsWith('--bridge-root=')))throw Error('QUALITY_OPTIONS_INVALID')
  evaluateNativeQuality({frameworkRoot:framework,...(bridge?{bridgeRoot:bridge}:{}),execute}).then(result=>{process.stdout.write(JSON.stringify(result)+'\n')},()=>{process.stderr.write('QUALITY_EVALUATION_FAILED\n');process.exitCode=1})
}
