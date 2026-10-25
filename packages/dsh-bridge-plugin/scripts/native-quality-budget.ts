export const QUALITY_LIMITS = Object.freeze({samples:10,maxOutputTokens:256,requestTimeoutMs:20000,totalTimeoutMs:240000,totalTokens:100000,maxInputBytes:32768})
export interface QualityUsage {readonly inputTokens:number;readonly outputTokens:number;readonly totalTokens:number;readonly cacheReadTokens?:number;readonly cacheWriteTokens?:number}
export function createQualityBudget(now=()=>performance.now(),previousBudgetChargedTokens=0,totalTokenLimit:number=QUALITY_LIMITS.totalTokens,maxOutputTokens:number=QUALITY_LIMITS.maxOutputTokens) {
  if(!Number.isSafeInteger(totalTokenLimit)||totalTokenLimit<1||totalTokenLimit>400000
    ||![256,512].includes(maxOutputTokens)
    ||!Number.isSafeInteger(previousBudgetChargedTokens)||previousBudgetChargedTokens<0||previousBudgetChargedTokens>totalTokenLimit)throw Error('QUALITY_PRIOR_BUDGET_INVALID')
  const started=now()
  let calls=0
  let used=0
  let measured=0
  let estimated=0
  let reserved=0
  let stopped=false
  return Object.freeze({
    reserve(inputBytes:number,minimumTokens=0) {
      const charge=Math.max(inputBytes+2048+maxOutputTokens,minimumTokens)
      if(stopped||reserved||calls>=QUALITY_LIMITS.samples||now()-started>=QUALITY_LIMITS.totalTimeoutMs
        ||!Number.isSafeInteger(inputBytes)||inputBytes<1||inputBytes>QUALITY_LIMITS.maxInputBytes
        ||!Number.isSafeInteger(minimumTokens)||minimumTokens<0
        ||previousBudgetChargedTokens+used+charge>totalTokenLimit)throw Error('QUALITY_BUDGET_EXHAUSTED')
      reserved=charge;calls++
    },
    settle(usage:QualityUsage|null) {
      if(!reserved)throw Error('QUALITY_BUDGET_UNRESERVED')
      const valid=usage!==null&&[usage.inputTokens,usage.outputTokens,usage.totalTokens].every(value=>Number.isSafeInteger(value)&&value>=0)
        &&usage.totalTokens>=usage.inputTokens+usage.outputTokens
      if(valid)measured+=usage.totalTokens;else estimated+=reserved
      used+=valid?usage.totalTokens:reserved;reserved=0
      if(!valid||usage!.outputTokens>maxOutputTokens||previousBudgetChargedTokens+used>totalTokenLimit)stopped=true
      return valid
    },
    status(){return Object.freeze({calls,budgetChargedTokens:used,previousBudgetChargedTokens,aggregateBudgetChargedTokens:previousBudgetChargedTokens+used,measuredTokens:measured,estimatedTokens:estimated,reservedTokens:reserved,stopped,elapsedMs:Math.max(0,now()-started)})},
  })
}
