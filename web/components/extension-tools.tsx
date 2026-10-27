import type { NativeToolInventory } from '../../src/contracts/native-tool-inventory.ts';
import { inventoryToolCategory, registrationOriginLabel, registrationTransportLabel, toolNameNamespace, type ExtensionToolConflict, type PresentedInventoryTool } from '../lib/chat-tools.ts';
import { registrationLabel, toolLabel, toolLoadedLabel } from './chat-tools.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';

/** Tools stay in a compact package list; descriptions and evidence use a narrow details window. */
export function ExtensionTools({ tools, declaredNames, conflicts = [], ownerNames, sources = [], unavailable, compact = false }: {
  readonly tools: readonly PresentedInventoryTool[];
  readonly declaredNames: readonly string[];
  readonly conflicts?: readonly ExtensionToolConflict[];
  readonly ownerNames?: ReadonlyMap<string, string>;
  readonly sources?: NativeToolInventory['sources'];
  readonly unavailable: boolean;
  readonly compact?: boolean;
}) {
  const names = [...new Set([...declaredNames, ...tools.map(tool => tool.name)])];
  const registrationScopes = new Map(sources.map(source => [source.id, source]));
  return <section className="grid gap-1.5" aria-label="扩展提供的工具">
    {!compact && <h3 className="text-xs font-medium">包含工具 · {names.length}</h3>}
    {unavailable && !compact && <p className="text-xs text-muted-foreground">工具登记与会话加载状态暂时无法核对，已有记录保留供查看。</p>}
    {names.length === 0 ? <p className="text-xs text-muted-foreground">此扩展未登记模型工具。</p>
      : <ul className="m-0 list-none divide-y p-0">{names.map(name => {
        const matches = tools.filter(tool => tool.name === name);
        const first = matches[0];
        const conflict = conflicts.find(item => item.name === name);
        const registered = matches.some(tool => tool.registration === 'registered');
        const loadedStates = new Set(matches.map(tool => tool.loadedInSession));
        const loaded = !first ? '尚未观察' : loadedStates.size > 1 ? '加载状态待核对' : toolLoadedLabel(first);
        return <li key={name} className={compact ? 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded px-1.5 py-1 text-xs odd:bg-muted/30' : 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs'}>
          <span className={compact ? 'min-w-0 break-words leading-5 font-medium' : 'min-w-0 flex-1 basis-32 break-words font-medium'}>{toolLabel(name, first?.registrationSource)}</span>
          <span title={`${registered ? '已注册' : '已声明'} · ${loaded}`} className={conflict ? 'text-destructive' : compact ? 'text-[11px] text-muted-foreground' : 'text-muted-foreground'}>{conflict ? '归属冲突' : unavailable ? '待刷新' : compact ? registered ? '已注册' : '已声明' : `${registered ? '已注册' : '已声明'} · ${loaded}`}</span>
          <ReadOnlyDetails title={toolLabel(name, first?.registrationSource)} label="说明" compact={compact} description="工具说明、注册归属、接入方式与会话加载证据。">
            <div className="grid min-w-0 gap-3">
              {conflict && <p className="text-xs text-destructive">{conflict.framework ? '框架已登记同名工具，扩展声明不会覆盖框架的注册归属。' : conflict.dsh ? 'DSH 已登记同名内置工具，扩展声明不会覆盖其注册归属。' : '工具存在多项归属声明；已有来源元数据的登记按原归属保留，其余记录待核对。'}相关扩展：{conflict.owners.map(id => ownerNames?.get(id) ?? id).join('、')}。</p>}
              {matches.length === 0 && <p className="text-xs text-muted-foreground">{conflict ? '可在框架注入、扩展注入或 DSH 自带工具区域查看实际登记。' : '扩展已声明此工具，尚无匹配的运行注册记录。'}</p>}
              {matches.map(tool => <div key={tool.id} className="grid gap-2"><p className="whitespace-pre-wrap leading-relaxed">{tool.description || '未提供详细说明。'}</p><TechnicalDetails fields={[{ label: '提供来源', value: registrationOriginLabel(tool.registrationSource) }, { label: '所属组件', value: tool.category.label }, { label: '归属依据', value: tool.registrationSource ? '注册时来源元数据' : '扩展精确工具声明' }, { label: '接入方式', value: registrationTransportLabel(tool.registrationSource) }, { label: '名称命名空间', value: toolNameNamespace(tool.name) }, { label: '注册状态', value: unavailable ? '状态待核对' : registrationLabel(tool) }, { label: '当前会话', value: unavailable ? '状态待核对' : toolLoadedLabel(tool) }]} />
                <ul className="m-0 list-none space-y-1 p-0" aria-label="注册与加载证据">{tool.registrations.map(registration => <li key={registration.id} className="rounded border p-2"><TechnicalDetails fields={[{ label: '注册范围', value: registrationScopes.get(registration.sourceId)?.label ?? registration.sourceId }, { label: '登记归属', value: inventoryToolCategory(registration, registrationScopes.get(registration.sourceId)).label }, { label: '归属标识', value: registration.registrationSource?.ownerId }, { label: '接入方式', value: registrationTransportLabel(registration.registrationSource) }, { label: '注册状态', value: registrationLabel(registration) }, { label: '会话观察', value: unavailable ? '状态待核对' : registration.loadedInSession === true ? '当前已加载' : registration.loadedInSession === false ? '未在当前会话加载' : '尚未观察' }]} /></li>)}</ul>
              </div>)}
              <TechnicalDetails fields={[{ label: '工具标识', value: name }, { label: '注册记录', value: matches.flatMap(tool => tool.registrations) }]} />
            </div>
          </ReadOnlyDetails>
        </li>;
      })}</ul>}
    {!compact && <p className="text-xs text-muted-foreground">已注册与已加载分别记录；实际调用仍按所属会话权限核验。</p>}
  </section>;
}
