import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, errorMessage, isRecord, type ApiClient } from '../lib/api.ts';
import { modelCapabilitiesPath, modelCapabilitiesUnavailableMessage, modelReasoningEffortLabel,
  parseModelCapabilities, parseProviderModelCapabilities, providerModelCapabilitiesPath,
  type ModelCapabilities } from '../lib/model-capabilities.ts';
import { invalidateReadResources, readResource, writeResource } from '../lib/resource-reader.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { Button } from './ui/button.tsx';
import { ModelCapabilityEditor } from './model-capability-editor.tsx';
import type { DshDeploymentModelSettings } from '../../src/contracts/dsh-model-settings.ts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';

export function ProviderModelCapabilityDialog({ api, connected, provider, model, providersRevision, disabledReason, onUpdated, onClose }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly provider: string;
  readonly model: string;
  readonly providersRevision: string;
  readonly disabledReason?: string;
  readonly onUpdated?: (capabilities: ModelCapabilities) => void;
  readonly onClose: () => void;
}) {
  const path = providerModelCapabilitiesPath(provider);
  const cache = useReadResource(api, path, connected, parseProviderModelCapabilities);
  const [returned, setReturned] = useState<ModelCapabilities | null>(null);
  const [message, setMessage] = useState('');
  const [writing, setWriting] = useState<'refresh' | 'clear' | 'save' | null>(null);
  const [editing, setEditing] = useState<ModelCapabilities | null>(null);
  const [blocked, setBlocked] = useState(false);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const owner = useRef({ api, connected, provider, model, providersRevision, disabledReason });
  owner.current = { api, connected, provider, model, providersRevision, disabledReason };
  useEffect(() => {
    epoch.current++;
    request.current?.abort();
    request.current = null;
    setReturned(null); setMessage(''); setWriting(null); setBlocked(false); setEditing(null);
    return () => { epoch.current++; request.current?.abort(); };
  }, [api, connected, provider, model, providersRevision]);
  const capabilities = returned ?? (cache.snapshot?.provider === provider
    ? cache.snapshot.models.find(item => item.model === model) ?? null : null);
  const revisionMatches = cache.snapshot?.provider === provider && cache.snapshot.providersRevision === providersRevision;
  const locked = !connected || Boolean(disabledReason) || writing !== null || blocked || !revisionMatches;

  async function maintain(action: 'refresh' | 'clear' | 'save', modelSettings?: DshDeploymentModelSettings): Promise<boolean> {
    if (locked || request.current || owner.current.disabledReason || owner.current.api !== api || !owner.current.connected) return false;
    const controller = new AbortController();
    const started = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && epoch.current === started && request.current === controller
      && owner.current.api === api && owner.current.connected && owner.current.provider === provider
      && owner.current.model === model && owner.current.providersRevision === providersRevision;
    setWriting(action); setMessage('');
    try {
      const response = await writeResource(api, '/api/chat/model-capabilities', { provider, model, action, providersRevision,
        cacheRevision: action === 'save' ? editing?.cacheRevision : capabilities?.cacheRevision,
        ...(action === 'save' ? { modelSettings } : {}) }, controller.signal);
      if (!current()) return false;
      const parsed = isRecord(response) ? parseModelCapabilities(response.capabilities) : null;
      if (!isRecord(response) || typeof response.ok !== 'boolean' || response.action !== action
        || response.providersRevision !== providersRevision || !parsed || parsed.provider !== provider || parsed.model !== model) {
        throw new ApiError('model_capability_maintenance_unknown', 504);
      }
      setReturned(parsed);
      onUpdated?.(parsed);
      setMessage(response.ok ? action === 'save' ? '手动能力已保存。请在聊天方案或助手中选择档位并应用。'
        : action === 'clear' ? '已清除能力设置。后续选择模型时会重新读取自动声明。'
        : parsed.cache?.source === 'manual' ? '已保留手动能力；清除后可重新自动读取。' : '能力缓存已刷新。'
        : `${action === 'save' ? '保存' : '刷新'}失败，原能力设置保留。${modelCapabilitiesUnavailableMessage(typeof response.error === 'string' ? [response.error] : parsed.missingReasons)}`);
      // The model selectors use the default GET; prevent an earlier unavailable browser snapshot from surviving maintenance.
      invalidateReadResources(api, [modelCapabilitiesPath(provider, model)]);
      await readResource(api, path, controller.signal).catch(() => undefined);
      return current() && response.ok;
    } catch (failure) {
      if (!current()) return false;
      const uncertain = !(failure instanceof ApiError) || failure.status >= 500 || /unknown/.test(failure.code);
      setBlocked(uncertain || failure instanceof ApiError && failure.status === 409);
      setMessage(uncertain ? '维护结果尚未确认，请关闭窗口后重新查看缓存；不会自动再次提交。'
        : failure instanceof ApiError && failure.status === 409 ? '供应商或能力设置已变化，请重新查看后编辑，避免覆盖另一处修改。' : errorMessage(failure));
      return false;
    } finally {
      if (current()) setWriting(null);
      if (request.current === controller) request.current = null;
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !writing) onClose(); }}><DialogContent showCloseButton={!writing}>
    <DialogHeader><DialogTitle>模型能力缓存</DialogTitle><DialogDescription>{provider} / {model} · 自动读取或手动填写这个模型支持的参数。</DialogDescription></DialogHeader>
    {!editing && <dl className="grid grid-cols-2 gap-2 text-xs"><div className="col-span-2"><dt className="text-muted-foreground">思考等级</dt><dd className="mt-1">{capabilities?.state === 'available' ? capabilities.reasoningEfforts.map(modelReasoningEffortLabel).join('、') : '未缓存'}</dd></div><div><dt className="text-muted-foreground">上下文窗口</dt><dd className="mt-1 tabular-nums">{capabilities?.capacity?.contextWindow.toLocaleString() ?? '未提供'}</dd></div><div><dt className="text-muted-foreground">最大输出</dt><dd className="mt-1 tabular-nums">{capabilities?.capacity?.maxTokens.toLocaleString() ?? '未提供'}</dd></div><div><dt className="text-muted-foreground">缓存来源</dt><dd className="mt-1">{capabilities?.cache ? capabilities.cache.source === 'manual' ? '手动填写' : capabilities.cache.source === 'dsh' ? 'DSH 模型元数据' : '供应商模型元数据' : '未缓存'}</dd></div><div><dt className="text-muted-foreground">更新时间</dt><dd className="mt-1">{capabilities?.cache ? new Date(capabilities.cache.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}</dd></div></dl>}
    {!editing && capabilities?.state === 'unavailable' && <p className="text-xs text-muted-foreground">{modelCapabilitiesUnavailableMessage(capabilities.missingReasons)}</p>}
    {disabledReason && <p className="text-xs text-amber-700 dark:text-amber-300" role="status">{disabledReason}</p>}
    {!disabledReason && !revisionMatches && <p className="text-xs text-muted-foreground">{cache.loading ? '正在核对已保存的能力缓存…' : '尚未取得与当前供应商目录一致的缓存状态，请重新查看。'}</p>}
    {message && <p className="text-xs leading-5" role="status">{message}</p>}
    {!editing && capabilities?.cache?.source === 'manual' && <p className="text-xs text-muted-foreground">手动能力优先使用，自动刷新不会覆盖；清除后恢复自动读取。</p>}
    {editing ? <ModelCapabilityEditor key={`${provider}/${model}/${editing.cacheRevision}`} initial={editing.modelSettings} disabled={locked} saving={writing === 'save'} onSave={settings => maintain('save', settings)} onCancel={() => setEditing(null)} />
      : <div className="flex flex-wrap gap-2"><Button size="sm" disabled={locked || !capabilities?.cacheRevision} onClick={() => { if (capabilities) { setEditing(capabilities); setMessage(''); } }}>{capabilities?.cache?.source === 'manual' ? '编辑手动能力' : '手动填写'}</Button><Button size="sm" variant="outline" disabled={locked || capabilities?.cache?.source === 'manual'} onClick={() => void maintain('refresh')}>{writing === 'refresh' ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}刷新能力</Button><Button size="sm" variant="outline" disabled={locked || !capabilities?.cache} onClick={() => void maintain('clear')}>{writing === 'clear' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}{capabilities?.cache?.source === 'manual' ? '清除手动能力' : '清除缓存'}</Button><Button size="sm" variant="ghost" disabled={writing !== null} onClick={onClose}>关闭</Button></div>}

  </DialogContent></Dialog>;
}
