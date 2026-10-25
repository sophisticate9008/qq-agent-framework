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
  if (steps.every(step => step.state === 'complete')) return null;
  const next = steps.find(step => step.state !== 'complete');
  return <Section id="first-setup" title="开始聊天" description="依次完成配置；各页分别保存，最后明确应用。连接、模型、人设和访问草稿可跨页保留。"
    actions={<Button variant="outline" size="sm" onClick={() => { for (const resource of Object.values(resources)) resource.refresh(); }}><RefreshCw className="size-3.5" />核对步骤</Button>}>
    <ol className="grid gap-3 sm:grid-cols-2">{steps.map((step, index) => <li key={step.id} className="grid gap-3 rounded-lg border p-4" aria-current={next?.id === step.id ? 'step' : undefined}>
      <div className="flex items-center justify-between gap-2"><strong className="text-sm">{index + 1}. {step.title}</strong><StatusPill tone={step.state === 'complete' ? 'success' : 'neutral'}>{step.state === 'complete' ? <><Check className="mr-1 inline size-3" />已核对</> : step.state === 'unknown' ? '待确认' : '待完成'}</StatusPill></div>
      <p className="text-xs leading-6 text-muted-foreground">{step.description}</p><Button variant={next?.id === step.id ? 'default' : 'outline'} size="sm" className="justify-self-start" onClick={() => navigate(step.page, step.target)}>打开配置<ArrowRight className="size-3.5" /></Button>
    </li>)}</ol>
  </Section>;
}
