import { ArrowRight, Check, RefreshCw } from 'lucide-react';
import { asRecord } from '../lib/api.ts';
import { setupProgress } from '../lib/setup-progress.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { PageProps } from '../lib/types.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

export function SetupProgress({ api, connected, navigate }: Pick<PageProps, 'api' | 'connected' | 'navigate'>) {
  const adapters = useReadResource(api, '/api/chat/adapters', connected, asRecord);
  const plans = useReadResource(api, '/api/chat/plans', connected, asRecord);
  const personas = useReadResource(api, '/api/chat/personas', connected, asRecord);
  const providers = useReadResource(api, '/api/chat/providers', connected, asRecord);
  const access = useReadResource(api, '/api/chat/access', connected, asRecord);
  const runtime = useReadResource(api, '/api/chat/runtime', connected, asRecord);
  if (!connected) return null;
  const resources = { adapters, plans, personas, providers, access, runtime };
  const steps = setupProgress({ adapters: adapters.error ? undefined : adapters.snapshot, plans: plans.error ? undefined : plans.snapshot,
    personas: personas.error ? undefined : personas.snapshot, providers: providers.error ? undefined : providers.snapshot,
    access: access.error ? undefined : access.snapshot, runtime: runtime.error ? undefined : runtime.snapshot });
  const completed = steps.filter(step => step.state === 'complete').length;
  if (completed === steps.length) return <div id="first-setup" className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs"><Check className="size-4 text-[var(--success)]" /><span className="mr-auto">开始聊天所需配置已就绪</span><Button variant="ghost" size="sm" onClick={() => navigate('model')}>调整聊天方案</Button></div>;
  const next = steps.find(step => step.state !== 'complete');
  return <Section id="first-setup" title="开始聊天" actions={<><span className="text-xs text-muted-foreground">已完成 {completed}/{steps.length}</span><Button variant="ghost" size="icon" aria-label="重新核对配置步骤" onClick={() => { for (const resource of Object.values(resources)) resource.refresh(); }}><RefreshCw className="size-4" /></Button></>}>
    <ol className="divide-y">{steps.map((step, index) => <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 first:pt-0 last:pb-0" aria-current={next?.id === step.id ? 'step' : undefined}>
      <div className="min-w-0 flex-1 basis-64"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-medium">{index + 1}. {step.title}</strong><StatusPill tone={step.state === 'complete' ? 'success' : 'neutral'}>{step.state === 'complete' ? '已核对' : step.state === 'unknown' ? '待确认' : '待完成'}</StatusPill></div>{step.state !== 'complete' && <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p>}</div>
      <Button variant={next?.id === step.id ? 'outline' : 'ghost'} size="sm" onClick={() => navigate(step.page, step.target)}>{step.state === 'complete' ? '查看' : '去配置'}<ArrowRight className="size-4" /></Button>
    </li>)}</ol>
  </Section>;
}
