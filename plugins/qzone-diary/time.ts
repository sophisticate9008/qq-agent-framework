export function localDay(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
/** Resolve a local wall-clock minute, rejecting DST gaps rather than silently changing the date. */
export function localMinute(date: string, minute: number, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const target = Date.UTC(year!, month! - 1, day!, Math.floor(minute / 60), minute % 60)
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  let candidate = target
  for (let i = 0; i < 4; i++) {
    const parts = format.formatToParts(candidate), get = (type: string) => Number(parts.find(p => p.type === type)!.value)
    const seen = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
    if (seen === target) return candidate
    candidate += target - seen
  }
  throw new Error('DIARY_LOCAL_TIME_UNAVAILABLE')
}
