import assert from 'node:assert/strict'
import test from 'node:test'
import {createQualityBudget,QUALITY_LIMITS} from '../scripts/native-quality-budget.ts'

test('quality runner admits ten serial generations within the token/output/time budget and refuses retries',()=>{
  let clock=100
  const budget=createQualityBudget(()=>clock)
  for(let index=0;index<10;index++){
    budget.reserve(9000)
    assert.throws(()=>budget.reserve(9000),/QUALITY_BUDGET_EXHAUSTED/)
    clock+=20
    assert.equal(budget.settle({inputTokens:2500,outputTokens:100,totalTokens:2600}),true)
  }
  assert.equal(budget.status().calls,10);assert.equal(budget.status().budgetChargedTokens,26000)
  assert.equal(budget.status().measuredTokens,26000);assert.equal(budget.status().estimatedTokens,0)
  assert.throws(()=>budget.reserve(100),/QUALITY_BUDGET_EXHAUSTED/)
})
test('unknown usage, output limit violations, oversized input and total deadline stop further calls',()=>{
  const unknown=createQualityBudget();unknown.reserve(100)
  assert.equal(unknown.settle(null),false);assert.equal(unknown.status().budgetChargedTokens,2404)
  assert.equal(unknown.status().measuredTokens,0);assert.equal(unknown.status().estimatedTokens,2404)
  assert.throws(()=>unknown.reserve(100),/QUALITY_BUDGET_EXHAUSTED/)
  const overOutput=createQualityBudget();overOutput.reserve(100)
  overOutput.settle({inputTokens:100,outputTokens:257,totalTokens:357})
  assert.throws(()=>overOutput.reserve(100),/QUALITY_BUDGET_EXHAUSTED/)
  assert.throws(()=>createQualityBudget().reserve(QUALITY_LIMITS.maxInputBytes+1),/QUALITY_BUDGET_EXHAUSTED/)
  let clock=0;const timeout=createQualityBudget(()=>clock);clock=QUALITY_LIMITS.totalTimeoutMs
  assert.throws(()=>timeout.reserve(1),/QUALITY_BUDGET_EXHAUSTED/)
  const followup=createQualityBudget(()=>0,9610);followup.reserve(7306)
  assert.equal(followup.settle(null),false)
  assert.equal(followup.status().aggregateBudgetChargedTokens,19220)
  assert.throws(()=>createQualityBudget(()=>0,99999).reserve(1),/QUALITY_BUDGET_EXHAUSTED/)
  const extended=createQualityBudget(()=>0,34193,400000);extended.reserve(7306,30000);extended.settle(null)
  assert.equal(extended.status().aggregateBudgetChargedTokens,64193)
  assert.throws(()=>createQualityBudget(()=>0,380000,400000).reserve(100,30000),/QUALITY_BUDGET_EXHAUSTED/)
  const largerOutput=createQualityBudget(()=>0,183021,400000,512);largerOutput.reserve(100,30000)
  largerOutput.settle({inputTokens:100,outputTokens:297,totalTokens:397});assert.equal(largerOutput.status().stopped,false)
})
