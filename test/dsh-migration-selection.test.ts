import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveDshMigrationTargetSelection } from '../src/adapters/dsh-migration-selection.ts'
import type { JsonValue } from '../src/contracts/data.ts'

function fixture(reasoning: JsonValue | undefined = {efforts:[{id:'high',name:'High'}],defaultEffort:'high'}) {
  return {provider:'managed-route',model:'selected-model',reasoningEffort:'high',agentPreset:'managed-preset',
    catalog:{routableProviders:['managed-route'],groups:[{id:'managed-route',name:'Managed',models:[{id:'selected-model',name:'Selected',...(reasoning===undefined?{}:{reasoning})}]}],failures:[]},
    settings:{namespaces:[{ns:'llm',value:{providers:{'managed-route':{models:[{id:'selected-model',contextWindow:8192,maxTokens:1024}]}}}}]},
    presetDocument:{agentPreset:'managed-preset',content:'- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config: {prefix: instructions}\n- id: compaction\n  name: "cordis:group"\n  group: true\n  config:\n    - id: basic\n      name: "@deepseek-ai/dsh-compaction-basic"\n      config: {auto: true, headroomTokens: 0, maxTokens: 1024, summarizationProvider: managed-route, summarizationModel: selected-model}\n'}}
}

test('target selection derives actual live model capacity and managed compaction fields rather than catalog guesses',()=>{
  assert.deepEqual(deriveDshMigrationTargetSelection(fixture()),{provider:'managed-route',model:'selected-model',reasoningEffort:'high',
    contextLimits:{contextWindow:8192,maxTokens:1024,headroomTokens:0}})
  const none=fixture({efforts:[{id:'none',name:'None'}]})
  assert.equal(deriveDshMigrationTargetSelection({...none,reasoningEffort:'off'}).reasoningEffort,'none')
  const without=fixture();delete (without.catalog.groups[0]!.models[0] as {reasoning?:unknown}).reasoning
  assert.equal(deriveDshMigrationTargetSelection({...without,reasoningEffort:'off'}).reasoningEffort,undefined)
  assert.throws(()=>deriveDshMigrationTargetSelection({...fixture(),reasoningEffort:'max'}),{code:'DSH_MIGRATION_TARGET_UNVERIFIED'})
})

test('capacity mismatch, ambiguous live routes and YAML aliases cannot turn into a migration selection',()=>{
  const base=fixture()
  assert.throws(()=>deriveDshMigrationTargetSelection({...base,presetDocument:{...base.presetDocument,content:base.presetDocument.content.replace('maxTokens: 1024','maxTokens: 2048')}}),{code:'DSH_MIGRATION_TARGET_UNVERIFIED'})
  assert.throws(()=>deriveDshMigrationTargetSelection({...base,settings:{namespaces:[...base.settings.namespaces,...base.settings.namespaces]}}),{code:'DSH_MIGRATION_TARGET_UNVERIFIED'})
  assert.throws(()=>deriveDshMigrationTargetSelection({...base,presetDocument:{...base.presetDocument,content:'- &base {name: x}\n- *base'}}),{code:'DSH_MIGRATION_TARGET_UNVERIFIED'})
})
