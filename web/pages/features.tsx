import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

const legacyModes = ['chat', 'reserved', 'reserved2', 'closed-agent'] as const;
type LegacyMode = typeof legacyModes[number];

interface LegacyModeState {
  readonly mode: LegacyMode;
  readonly revision: string;
  readonly supported: {
    readonly reserved: boolean;
    readonly reserved2: boolean;
  };
}

const modeLabels: Readonly<Record<LegacyMode, string>> = {
  chat: '普通聊天',
  reserved: '一代仿真',
  reserved2: '二代仿真',
  'closed-agent': '工作模式',
};

function isLegacyMode(value: unknown): value is LegacyMode {
  return typeof value === 'string' && (legacyModes as readonly string[]).includes(value);
}

function parseModeState(value: unknown): LegacyModeState {
  const record = asRecord(value);
  const supported = asRecord(record.supported);
  if (!isLegacyMode(record.mode)
    || typeof record.revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.revision)
    || typeof supported.reserved !== 'boolean'
    || typeof supported.reserved2 !== 'boolean') throw new Error('invalid_mode_response');
  return {
    mode: record.mode,
    revision: record.revision,
    supported: { reserved: supported.reserved, reserved2: supported.reserved2 },
  };
}

function modeSupported(mode: LegacyMode, state: LegacyModeState): boolean {
  if (mode === 'reserved') return state.supported.reserved;
  if (mode === 'reserved2') return state.supported.reserved2;
  return true;
}

function unavailableModeMessage(mode: LegacyMode): string {
  return `${modeLabels[mode]}的功能总开关当前为关闭；请先保存并应用对应开关，再重新读取运行模式。`;
}

function modeError(error: unknown, selected: LegacyMode): string {
  if (error instanceof ApiError && error.code === 'legacy_mode_disabled') return unavailableModeMessage(selected);
  if (error instanceof ApiError && /conflict|revision/.test(error.code)) {
    return '运行模式已在其他窗口发生变化，请重新读取后再应用。';
  }
  if (!(error instanceof ApiError) || /unknown/.test(error.code)) {
    return '暂时无法确认模式切换结果；不会自动重试，请重新读取真实运行状态。';
  }
  return errorMessage(error);
}

export function FeaturesPage(props: PageProps) {
  const { api, connected, setDirty } = props;
  const [modeState, setModeState] = useState<LegacyModeState | null>(null);
  const [selectedMode, setSelectedMode] = useState<LegacyMode | null>(null);
  const [loadingMode, setLoadingMode] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [modeMessage, setModeMessage] = useState('');
  const [confirmingMode, setConfirmingMode] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const modeDirty = modeState !== null && selectedMode !== null && selectedMode !== modeState.mode;
  const selectedUnsupported = modeState !== null && selectedMode !== null && !modeSupported(selectedMode, modeState);

  useEffect(() => {
    setDirty(modeDirty, 'legacy-mode');
  }, [modeDirty, setDirty]);
  useEffect(() => () => setDirty(false, 'legacy-mode'), [setDirty]);

  useEffect(() => {
    if (!connected || asRecord(props.snapshot.integrations).chatManagement === false) {
      setModeState(null);
      setSelectedMode(null);
      setModeMessage('');
      setLoadingMode(false);
      return;
    }
    const controller = new AbortController();
    setLoadingMode(true);
    setModeMessage('');
    void api.get('/api/legacy/mode', controller.signal).then(value => {
      const next = parseModeState(value);
      setModeState(next);
      setSelectedMode(next.mode);
    }).catch(error => {
      if (!controller.signal.aborted) {
        setModeState(null);
        setSelectedMode(null);
        setModeMessage(errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingMode(false);
    });
    return () => controller.abort();
  }, [api, connected, props.snapshot.integrations, reloadVersion]);

  function requestModeSave(): void {
    if (!modeDirty || selectedMode === null || selectedUnsupported || savingMode) return;
    setConfirmingMode(true);
  }

  async function saveMode(): Promise<void> {
    if (!modeState || !selectedMode || !modeDirty || selectedUnsupported || savingMode) return;
    setConfirmingMode(false);
    setSavingMode(true);
    setModeMessage('正在应用运行模式');
    try {
      const next = parseModeState(await api.post('/api/legacy/mode', {
        revision: modeState.revision,
        mode: selectedMode,
      }));
      setModeState(next);
      setSelectedMode(next.mode);
      setModeMessage(`已切换到${modeLabels[next.mode]}。`);
    } catch (error) {
      setModeMessage(modeError(error, selectedMode));
    } finally {
      setSavingMode(false);
    }
  }

  const editorModeProps = modeState === null ? {} : { activeMode: modeState.mode };
  const saveMessage = selectedUnsupported && selectedMode !== null
    ? unavailableModeMessage(selectedMode)
    : modeMessage || (modeDirty ? '已选择新模式，确认后才会应用。' : '显示已接入聊天服务当前实际运行的模式。');

  return <div className="page-stack" data-page="features">
    <PageHeading title="功能与触发" description="按需管理能力、触发条件与表达方式；关闭功能不会清除其他设置。" />
    {connected && asRecord(props.snapshot.integrations).chatManagement !== false && <Section
      title="运行模式"
      description="已接入的聊天服务一次只运行一种模式；一代与二代可以都配置为可用，但不能同时运行。"
      actions={modeState && <StatusPill tone="neutral">当前：{modeLabels[modeState.mode]}</StatusPill>}
      footer={modeState && selectedMode ? <SaveBar
        dirty={modeDirty}
        saving={savingMode}
        disabled={selectedUnsupported || loadingMode}
        message={saveMessage}
        label="应用运行模式"
        onSave={requestModeSave}
        onReset={() => { setSelectedMode(modeState.mode); setModeMessage(''); }}
      ><Button type="button" variant="outline" disabled={loadingMode || savingMode || modeDirty} onClick={() => setReloadVersion(version => version + 1)}><RefreshCw className={loadingMode ? 'size-4 animate-spin' : 'size-4'} />重新读取</Button></SaveBar> : undefined}
    >
      {loadingMode && !modeState ? <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取真实运行模式</div> : modeState && selectedMode ? <div className="grid gap-3">
        <Field label="选择运行模式" description="选择不会立即写入；应用前会再次确认影响。">
          <Select value={selectedMode} disabled={savingMode} onValueChange={value => {
            if (isLegacyMode(value)) {
              setSelectedMode(value);
              setModeMessage('');
            }
          }}>
            <SelectTrigger className="w-full"><SelectValue>{modeLabels[selectedMode]}</SelectValue></SelectTrigger>
            <SelectContent>
              {legacyModes.map(mode => <SelectItem key={mode} value={mode}>{modeLabels[mode]}{!modeSupported(mode, modeState) ? '（功能总开关已关闭）' : ''}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <p className="text-xs leading-6 text-muted-foreground">切换只改变互斥的运行模式，不会自动打开主动话题、黑话学习或其他已关闭的功能开关。</p>
      </div> : <div className="flex flex-wrap items-center justify-between gap-3" role="alert"><span className="text-sm text-destructive">{modeMessage || '暂时无法读取真实运行模式，不会默认选择二代。'}</span><Button type="button" variant="outline" disabled={loadingMode} onClick={() => setReloadVersion(version => version + 1)}><RefreshCw className={loadingMode ? 'size-4 animate-spin' : 'size-4'} />重新读取</Button></div>}
    </Section>}
    <ConfigurationEditor {...props} category="features" {...editorModeProps} />
    <Dialog open={confirmingMode} onOpenChange={setConfirmingMode}><DialogContent><DialogHeader><DialogTitle>确认应用运行模式</DialogTitle><DialogDescription>已有会话和上下文会保留，但模式切换可能取消尚未投递的排队任务。此操作不会开启主动话题、黑话学习或其他已关闭的功能。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setConfirmingMode(false)}>取消</Button><Button type="button" onClick={() => void saveMode()}>确认应用{selectedMode ? `：${modeLabels[selectedMode]}` : ''}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
