import { asRecord } from './api.ts';
import { parsePlanCatalog } from './chat-plans.ts';
import { parseChatRuntimeStatus } from './chat-runtime.ts';
import type { PageDestination, PageId } from './types.ts';

export interface SetupStep {
  readonly id: 'connections' | 'companion' | 'access' | 'start';
  readonly title: string;
  readonly state: 'complete' | 'pending' | 'unknown';
  readonly description: string;
  readonly page: PageId;
  readonly target?: PageDestination;
}
export function setupProgress(input: { readonly adapters: unknown; readonly plans: unknown; readonly personas: unknown;
  readonly providers: unknown; readonly access: unknown; readonly runtime: unknown }): readonly SetupStep[] {
  const adapters = asRecord(asRecord(input.adapters).adapters);
  const ws = asRecord(adapters.onebotWs); const http = asRecord(adapters.onebotHttp); const dsh = asRecord(adapters.dshAgent);
  const connectionsKnown = [ws, http, dsh].every(value => typeof value.enabled === 'boolean' && typeof value.endpoint === 'string');
  const connections = connectionsKnown && [ws, http, dsh].every(value => value.enabled === true && value.endpoint !== '');
  const catalog = parsePlanCatalog(input.plans);
  const selected = catalog?.plans.find(plan => plan.id === catalog.activePlanId);
  const personas = asRecord(input.personas).personas; const providers = asRecord(input.providers).providers;
  const companionKnown = catalog !== null && Array.isArray(personas) && Array.isArray(providers);
  const companion = companionKnown && selected !== undefined
    && personas.some(value => asRecord(value).id === selected.personaId)
    && providers.some(value => { const provider = asRecord(value); return provider.id === selected.provider && provider.enabled === true
      && Array.isArray(provider.models) && provider.models.some(model => asRecord(model).id === selected.model); });
  const access = asRecord(input.access);
  const accessKnown = Array.isArray(access.allow) && (access.owner === null || typeof access.owner === 'string');
  const authorized = accessKnown && typeof access.owner === 'string' && /^[1-9][0-9]{0,19}$/.test(access.owner)
    && Array.isArray(access.allow) && access.allow.some(value => typeof value === 'string' && /^(?:group|private):[1-9][0-9]{0,19}$/.test(value));
  const runtime = parseChatRuntimeStatus(input.runtime);
  return [
    { id: 'connections', title: '连接 QQ 与 DSH', state: !connectionsKnown ? 'unknown' : connections ? 'complete' : 'pending',
      description: connections ? '已保存消息接收、发送与聊天引擎连接；实际可用性在启动时核对。' : '保存 QQ 收发连接，并自动连接本机 DSH。', page: 'adapters' },
    { id: 'companion', title: '选择模型与人设', state: !companionKnown ? 'unknown' : companion ? 'complete' : 'pending',
      description: companion ? '已启用的聊天方案已关联人设和已登记模型。' : '登记模型、保存人设，再关联并选择启用聊天方案。', page: 'model' },
    { id: 'access', title: '设置主人与白名单', state: !accessKnown ? 'unknown' : authorized ? 'complete' : 'pending',
      description: authorized ? '已保存主人与允许聊天的会话；运行时仍会逐次检查权限。' : '明确主人账号，并添加允许接收和回复的群聊、私聊。', page: 'access' },
    { id: 'start', title: '核对、应用并启用', state: !runtime ? 'unknown' : runtime.chatReady ? 'complete' : 'pending',
      description: runtime?.chatReady ? '聊天已报告就绪，实际消息结果可在会话中核对。' : '检查缺失条件，明确应用并启动；结果未知时先核对。',
      page: 'adapters', target: { title: '聊天运行', sectionId: 'chat-runtime', kind: 'section' } },
  ];
}
