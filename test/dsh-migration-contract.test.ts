import test from 'node:test'
import assert from 'node:assert/strict'
import { validMigrationTargetSelection as rootValidator } from '../src/contracts/dsh-session-migration.ts'
import { validMigrationTargetSelection as pluginValidator } from '../packages/dsh-bridge-plugin/src/migration-protocol.ts'

const valid={provider:'route',model:'model',reasoningEffort:'high',contextLimits:{contextWindow:8192,maxTokens:1024,headroomTokens:0}}
test('independent root and plugin target codecs agree on exact model, reasoning and capacity fixtures',()=>{
  const fixtures:readonly [unknown,boolean][]=[[valid,true],[{...valid,reasoningEffort:undefined},false],
    [{provider:valid.provider,model:valid.model,contextLimits:valid.contextLimits},true],
    [{...valid,scope:'owner'},false],[{...valid,contextLimits:{...valid.contextLimits,unknown:0}},false],
    [{...valid,contextLimits:{...valid.contextLimits,maxTokens:8192}},false],
    [{...valid,contextLimits:{...valid.contextLimits,headroomTokens:-1}},false],
    [{...valid,contextLimits:{...valid.contextLimits,contextWindow:NaN}},false],
    [{...valid,model:'bad model'},false],[null,false]]
  for(const[value,expected]of fixtures){assert.equal(rootValidator(value),expected);assert.equal(pluginValidator(value),expected)}
})
