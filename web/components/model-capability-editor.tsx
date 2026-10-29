import { useId, useState } from 'react';
import { CHAT_PLAN_REASONING_EFFORTS, type ChatPlanReasoningEffort } from '../../src/contracts/chat-plans.ts';
import { validateManualDshModelSettings, type DshDeploymentModelSettings } from '../../src/contracts/dsh-model-settings.ts';
import { modelReasoningEffortLabel } from '../lib/model-capabilities.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

export function ModelCapabilityEditor({ initial, disabled, saving, onSave, onCancel }: {
  readonly initial?: DshDeploymentModelSettings;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly onSave: (settings: DshDeploymentModelSettings) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(initial?.maxTokens.toString() ?? '');
  const [reasoning, setReasoning] = useState(initial?.reasoningEfforts !== false);
  const [image, setImage] = useState(initial?.inputModalities?.includes('image') ?? false);
  const [levels, setLevels] = useState(() => Object.fromEntries(CHAT_PLAN_REASONING_EFFORTS.map(level => {
    const mapping = initial?.reasoningEfforts;
    return [level, { enabled: Boolean(mapping && Object.hasOwn(mapping, level)), wire: mapping && mapping[level] || '' }];
  })) as Record<ChatPlanReasoningEffort, { enabled: boolean; wire: string }>);
  const [error, setError] = useState('');
  async function save() {
    if (disabled) return;
    const mapping = Object.fromEntries(CHAT_PLAN_REASONING_EFFORTS.filter(level => levels[level].enabled)
      .map(level => [level, level === 'off' && !levels[level].wire.trim() ? null : levels[level].wire.trim()]));
    if (reasoning && Object.values(mapping).some(value => value !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value))) {
      setError('请填写已勾选档位的请求值，例如 low、high 或 xhigh。关闭档位留空表示不传参数。'); return;
    }
    let settings: DshDeploymentModelSettings;
    try {
      settings = validateManualDshModelSettings({ contextWindow: Number(contextWindow), maxTokens: Number(maxTokens),
        inputModalities: image ? ['text', 'image'] : ['text'], reasoningEfforts: reasoning ? mapping : false });
    } catch {
      setError('窗口和最大输出须为正整数，最大输出小于窗口，上限 16,777,216；支持思考时至少勾选一个非关闭档位。'); return;
    }
    setError('');
    if (await onSave(settings)) onCancel();
  }
  return <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p className="text-xs text-muted-foreground">按当前供应商实际支持情况填写。保存后可选这些档位；应用聊天或助手配置时写入 DSH。</p>
    <div className="grid grid-cols-2 gap-2">
      <label className="grid gap-1 text-xs" htmlFor={`${id}-context`}>上下文窗口（Token）<Input id={`${id}-context`} type="number" min="2" max="16777216" step="1" required value={contextWindow} disabled={disabled} onChange={event => setContextWindow(event.target.value)} /></label>
      <label className="grid gap-1 text-xs" htmlFor={`${id}-output`}>最大输出（Token）<Input id={`${id}-output`} type="number" min="1" max="16777215" step="1" required value={maxTokens} disabled={disabled} onChange={event => setMaxTokens(event.target.value)} /></label>
    </div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
      <label className="flex items-center gap-2"><input type="checkbox" checked={reasoning} disabled={disabled} onChange={event => setReasoning(event.target.checked)} />支持思考强度设置</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={image} disabled={disabled} onChange={event => setImage(event.target.checked)} />支持图片输入</label>
    </div>
    {reasoning && <><div className="tablewrap"><table><thead><tr><th>启用档位</th><th>发送给供应商的请求值</th></tr></thead><tbody>
      {CHAT_PLAN_REASONING_EFFORTS.map(level => <tr key={level}><td><label className="flex items-center gap-2 whitespace-nowrap"><input type="checkbox" checked={levels[level].enabled} disabled={disabled} onChange={event => setLevels(previous => ({ ...previous, [level]: { ...previous[level], enabled: event.target.checked } }))} />{modelReasoningEffortLabel(level)} <span className="font-mono text-muted-foreground">{level}</span></label></td><td><Input aria-label={`${modelReasoningEffortLabel(level)}档请求值`} className="font-mono" maxLength={128} value={levels[level].wire} disabled={disabled || !levels[level].enabled} placeholder={level === 'off' ? '留空：不传参数' : level === 'max' ? '例如 xhigh' : `例如 ${level}`} onChange={event => setLevels(previous => ({ ...previous, [level]: { ...previous[level], wire: event.target.value } }))} /></td></tr>)}
    </tbody></table></div><p className="text-xs text-muted-foreground">例如低 → low、高 → high、最高 → xhigh。左侧是框架档位，右侧按你的 relay 映射填写。</p></>}
    {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled}>{saving ? '正在保存' : '保存手动能力'}</Button><Button size="sm" type="button" variant="ghost" disabled={saving} onClick={onCancel}>取消</Button></div>
  </form>;
}
