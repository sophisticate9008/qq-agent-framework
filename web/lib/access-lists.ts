export interface AccessListFields {
  readonly groups: string;
  readonly privateChats: string;
}

export function formatAccessLists(entries: readonly string[]): AccessListFields {
  return {
    groups: entries.filter(entry => entry.startsWith('group:')).map(entry => entry.slice(6)).join(', '),
    privateChats: entries.filter(entry => entry.startsWith('private:')).map(entry => entry.slice(8)).join(', '),
  };
}

export function parseAccessLists(fields: AccessListFields, previous: readonly string[] = []): {
  readonly values?: string[];
  readonly error?: string;
} {
  const groups = fields.groups.split(/[\s,，、;；]+/u).filter(Boolean);
  const privateChats = fields.privateChats.split(/[\s,，、;；]+/u).filter(Boolean);
  if (groups.some(value => !/^[1-9][0-9]{0,19}$/.test(value))) return { error: '群号请填写 1–20 位数字，用逗号分隔，不需要 group: 前缀。' };
  if (privateChats.some(value => !/^[1-9][0-9]{0,19}$/.test(value))) return { error: '私聊账号请填写 1–20 位数字，用逗号分隔，不需要 private: 前缀。' };
  if (groups.length + privateChats.length > 1_024) return { error: '每份名单的群聊和私聊合计不能超过 1024 项。' };
  if (new Set(groups).size !== groups.length) return { error: '同一份名单中不能重复填写群号。' };
  if (new Set(privateChats).size !== privateChats.length) return { error: '同一份名单中不能重复填写私聊账号。' };
  const values = [...groups.map(value => `group:${value}`), ...privateChats.map(value => `private:${value}`)];
  const requested = new Set(values);
  const existing = new Set(previous);
  return { values: [...previous.filter(value => requested.has(value)), ...values.filter(value => !existing.has(value))] };
}
