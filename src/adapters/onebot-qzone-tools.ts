import type { JsonObject, JsonValue } from '../contracts/data.ts';
import type { QzoneToolDefinition, QzoneToolInventory, QzoneToolName, QzoneToolPort } from '../contracts/qzone-tools.ts';
import { isRecord, snapshot } from '../core/values.ts';
import { createOneBotQzoneClient, type OneBotQzoneConnectionOptions } from './onebot-qzone-http.ts';
import { qzonePublishParams, qzoneReference } from './onebot-qzone.ts';

const string: JsonObject = { type: 'string', minLength: 1, maxLength: 512 };
const userId: JsonObject = { oneOf: [{ type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, { type: 'integer', minimum: 1 }] };
const images: JsonObject = { type: 'array', maxItems: 32, items: { type: 'string', description: '协议端可访问的 file://、http(s):// 或 base64:// 图片来源' } };
const rights: JsonObject = { type: 'integer', enum: [1, 4, 16, 64, 128], description: '1 公开，4 好友，16 指定好友，64 自己，128 排除指定好友' };
const target = { target_uin: userId };
const page = { pos: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 }, num: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
function define(name: QzoneToolName, title: string, description: string, readOnly: boolean,
  properties: JsonObject, required: readonly string[] = []): QzoneToolDefinition {
  return { name, title, description, readOnly, parameters: { type: 'object', additionalProperties: false, properties, required: [...required] } };
}
export const ONEBOT_QZONE_TOOLS: readonly QzoneToolDefinition[] = snapshot([
  define('get_qzone_msg_list', '说说列表', '分页读取自己或指定账号的说说，访问范围由协议端判断。', true, { ...target, ...page }),
  define('get_qzone_msg_detail', '说说与评论详情', '读取指定说说与一页评论；内联回复不保证完整。', true, { tid: string, ...target, ...page }, ['tid']),
  define('get_qzone_feeds', '好友动态', '读取好友动态；分页游标原样传回，不将缺失正文或计数补为零。', true,
    { page_num: { type: 'integer', minimum: 1, maximum: 1000 }, count: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', minLength: 1, maxLength: 65536 } }),
  define('send_qzone_msg', '发布说说', '发布文字或多图说说，必须明确指定可见范围。', false,
    { content: { type: 'string', minLength: 0, maxLength: 32768, description: '有图片时正文可留空' }, images, ugc_right: rights, target_uins: { type: 'array', maxItems: 1000, items: userId } }, ['content', 'ugc_right']),
  define('delete_qzone_msg', '删除说说', '按真实说说编号删除当前账号的说说。', false, { tid: string }, ['tid']),
  define('set_qzone_msg_right', '修改可见范围', '修改已有说说的可见范围，指定或排除好友时需提供名单。', false,
    { tid: string, ugc_right: rights, target_uins: { type: 'array', maxItems: 1000, items: userId } }, ['tid', 'ugc_right']),
  define('like_qzone', '点赞', '给指定说说点赞；abstime 使用实际发表时间。', false,
    { tid: string, ...target, abstime: { type: 'integer', minimum: 0 } }, ['tid']),
  define('unlike_qzone', '取消点赞', '取消对指定说说的点赞；能力声明不代表已在当前协议端实机验证。', false,
    { tid: string, ...target, abstime: { type: 'integer', minimum: 0 } }, ['tid']),
  define('comment_qzone', '评论与回复', '评论说说或回复指定一级评论；评论编号 0 有效，回复评论仅支持文字。', false,
    { tid: string, ...target, content: { type: 'string', minLength: 1, maxLength: 32768 }, images,
      comment_id: string, comment_uin: userId, reply_uin: userId, reply_name: { type: 'string', minLength: 1, maxLength: 128 } }, ['tid', 'content']),
]);
const names = new Set<string>(ONEBOT_QZONE_TOOLS.map(tool => tool.name));
const positiveId = (value: unknown) => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
  || typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const integer = (value: unknown, minimum: number, maximum: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function parameters(tool: QzoneToolDefinition, input: JsonObject): JsonObject | null {
  if (!isRecord(input) || Object.keys(input).some(key => !Object.hasOwn(tool.parameters.properties as JsonObject, key))) return null;
  for (const key of ['target_uin', 'comment_uin', 'reply_uin']) if (input[key] !== undefined && !positiveId(input[key])) return null;
  if (input.tid !== undefined && !qzoneReference(input.tid)) return null;
  if (input.pos !== undefined && !integer(input.pos, 0, 1000000) || input.num !== undefined && !integer(input.num, 1, 100)
    || input.page_num !== undefined && !integer(input.page_num, 1, 1000) || input.count !== undefined && !integer(input.count, 1, 50)
    || input.abstime !== undefined && !integer(input.abstime, 0, Number.MAX_SAFE_INTEGER)
    || input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 65536)) return null;
  const required = tool.parameters.required as readonly JsonValue[];
  if (required.some(key => typeof key !== 'string' || !Object.hasOwn(input, key))) return null;
  if (tool.name === 'send_qzone_msg' || tool.name === 'set_qzone_msg_right') {
    const kinds = { 1: 'public', 4: 'friends', 16: 'allow', 64: 'self', 128: 'deny' } as const;
    const kind = kinds[input.ugc_right as keyof typeof kinds];
    if (!kind || typeof input.ugc_right !== 'number') return null;
    const checked = qzonePublishParams({ content: tool.name === 'send_qzone_msg' && typeof input.content === 'string' ? input.content : tool.name === 'set_qzone_msg_right' ? 'validation' : '',
      ...(input.images === undefined ? {} : { images: input.images as string[] }),
      visibility: kind === 'allow' || kind === 'deny' ? { kind, userIds: Array.isArray(input.target_uins) ? input.target_uins.map(value => String(value)) : [] } : { kind },
      signal: new AbortController().signal });
    if (!checked || input.target_uins !== undefined && !['allow', 'deny'].includes(kind)) return null;
  }
  if (tool.name === 'comment_qzone') {
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 32768
      || (input.comment_id === undefined) !== (input.comment_uin === undefined)
      || (input.reply_uin === undefined) !== (input.reply_name === undefined)
      || input.reply_uin !== undefined && input.comment_id === undefined
      || input.comment_id !== undefined && (!qzoneReference(input.comment_id) || Array.isArray(input.images) && input.images.length > 0)
      || input.reply_name !== undefined && (typeof input.reply_name !== 'string' || !input.reply_name.trim() || input.reply_name.length > 128)) return null;
    if (input.images !== undefined && !qzonePublishParams({ content: input.content, images: input.images as string[], visibility: { kind: 'self' }, signal: new AbortController().signal })) return null;
  }
  try { return Buffer.byteLength(JSON.stringify(input)) <= 16 * 1024 * 1024 ? snapshot(input) : null; } catch { return null; }
}
function validResult(name: QzoneToolName, data: JsonValue, input: JsonObject): boolean {
  if (['delete_qzone_msg', 'like_qzone', 'unlike_qzone'].includes(name)) return data === null;
  if (!isRecord(data)) return false;
  switch (name) {
    case 'send_qzone_msg': return qzoneReference(data.tid);
    case 'get_qzone_msg_list': return Array.isArray(data.msglist) && integer(data.total, 0, Number.MAX_SAFE_INTEGER);
    case 'get_qzone_msg_detail': return data.tid === input.tid && Array.isArray(data.comments);
    case 'get_qzone_feeds': return Array.isArray(data.feeds);
    case 'set_qzone_msg_right': return data.ugc_right === input.ugc_right;
    case 'comment_qzone': return typeof data.comment_id === 'string';
    default: return false;
  }
}
export interface OneBotQzoneToolsOptions extends OneBotQzoneConnectionOptions {
  /** Exact actions supplied by this protocol installation, not permissions. Unknown names are ignored. */
  readonly supportedActions?: readonly string[];
  readonly readSupportedActions?: (signal: AbortSignal) => Promise<readonly string[]>;
}
function inventory(actions: readonly string[], implementation: QzoneToolInventory['implementation'], source: QzoneToolInventory['source']): QzoneToolInventory {
  if (actions.length > 4096 || !actions.every(action => typeof action === 'string' && action.length <= 128)) throw new TypeError('Invalid protocol action inventory');
  const tools = ONEBOT_QZONE_TOOLS.filter(tool => actions.includes(tool.name));
  return snapshot({ schema: 1, state: tools.length ? 'available' : 'unsupported', source, implementation, tools, reason: tools.length ? null : 'QZONE_UNSUPPORTED' });
}
/** Low-level tools only: no QQ sender identity, chat plan, model registration, or authorization policy. */
export function createOneBotQzoneTools(options: OneBotQzoneToolsOptions): QzoneToolPort {
  const request = createOneBotQzoneClient(options);
  let current: QzoneToolInventory = options.supportedActions === undefined
    ? snapshot({ schema: 1, state: 'unknown', source: 'none', implementation: null, tools: [], reason: 'QZONE_NOT_INSPECTED' })
    : inventory(options.supportedActions, null, 'protocol-actions');
  async function inspect(signal: AbortSignal): Promise<QzoneToolInventory> {
    if (signal.aborted) return { ...current, state: 'unknown', reason: 'QZONE_ABORTED' };
    try {
      if (options.readSupportedActions) current = inventory(await options.readSupportedActions(signal), null, 'protocol-actions');
      else if (options.supportedActions !== undefined) current = inventory(options.supportedActions, null, 'protocol-actions');
      else {
        const result = await request('get_version_info', {}, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        if (result.status !== 'confirmed' || !isRecord(result.data) || typeof result.data.app_name !== 'string' || typeof result.data.app_version !== 'string') {
          current = snapshot({ schema: 1, state: 'unknown', source: 'none', implementation: null, tools: [], reason: result.status === 'confirmed' ? 'QZONE_INVALID_RESPONSE' : result.code });
        } else {
          const implementation = { name: result.data.app_name.slice(0, 128), version: result.data.app_version.slice(0, 128) };
          const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(implementation.version);
          // NapCat introduced these two extensions in 4.18.14. Other actions require an explicit installation inventory.
          const napcat = implementation.name === 'NapCat.Onebot' && version !== null
            && (Number(version[1]) > 4 || Number(version[1]) === 4 && (Number(version[2]) > 18 || Number(version[2]) === 18 && Number(version[3]) >= 14));
          current = inventory(napcat ? ['send_qzone_msg', 'delete_qzone_msg'] : [], implementation, napcat ? 'version-map' : 'none');
          if (!napcat) current = snapshot({ ...current, state: 'unknown', reason: 'QZONE_ACTIONS_NOT_DECLARED' });
        }
      }
    } catch { current = snapshot({ schema: 1, state: 'unknown', source: 'none', implementation: null, tools: [], reason: signal.aborted ? 'QZONE_ABORTED' : 'QZONE_DISCOVERY_UNKNOWN' }); }
    return current;
  }
  return Object.freeze({ describe: () => current, inspect,
    async execute(call) {
      if (call.signal.aborted) return { status: 'rejected', code: 'QZONE_ABORTED' };
      if (current.state === 'unknown' && current.reason === 'QZONE_NOT_INSPECTED') await inspect(call.signal);
      if (!names.has(call.name) || !current.tools.some(tool => tool.name === call.name)) return { status: 'rejected', code: 'QZONE_UNSUPPORTED' };
      const tool = current.tools.find(tool => tool.name === call.name)!;
      const input = parameters(tool, call.input);
      if (!input) return { status: 'rejected', code: 'QZONE_INVALID_INPUT' };
      const result = await request(call.name, input, call.signal, tool.readOnly ? 4 * 1024 * 1024 : 65536);
      if (result.status !== 'confirmed') return result;
      return validResult(call.name, result.data, input) ? result : { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' };
    },
  } satisfies QzoneToolPort);
}
