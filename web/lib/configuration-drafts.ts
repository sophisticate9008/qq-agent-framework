export function readConfigurationDraft<Value>(drafts: Readonly<Record<string, Value>>, key: string, fallback: Value): Value {
  return Object.hasOwn(drafts, key) ? drafts[key] : fallback;
}
