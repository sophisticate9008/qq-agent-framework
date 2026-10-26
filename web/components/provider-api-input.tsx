import { Autocomplete } from '@base-ui/react/autocomplete';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Input } from './ui/input.tsx';

interface ProtocolSuggestion {
  readonly api: string;
  readonly label: string;
  readonly hint: string;
  readonly keywords: string;
}

const protocols: readonly ProtocolSuggestion[] = [
  { api: 'openai-responses', label: 'OpenAI Responses', hint: '用于支持 Responses 的接口', keywords: 'response responses respones gpt OpenAI 响应' },
  { api: 'openai-completions', label: 'OpenAI Chat Completions', hint: '用于聊天补全兼容接口', keywords: 'chat completions deepseek 聊天 补全 兼容' },
  { api: 'anthropic-messages', label: 'Anthropic Messages', hint: '用于 Anthropic Messages 接口', keywords: 'anthropic claude messages 消息' },
];

export function ProviderApiInput({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [query, setQuery] = useState('');
  return <Autocomplete.Root items={protocols} value={value} disabled={disabled} openOnInputClick
    itemToStringValue={item => item.api}
    filter={(item: ProtocolSuggestion) => `${item.api} ${item.label} ${item.keywords}`.toLowerCase().includes(query.trim().toLowerCase())}
    onValueChange={next => { setQuery(next); onChange(next); }}
    onOpenChange={open => { if (!open) setQuery(''); }}>
    <Autocomplete.InputGroup className="relative min-w-0">
      <Autocomplete.Input id="provider-api" maxLength={128} placeholder="选择协议，或输入自定义标识"
        render={<Input className="pr-7" />} />
      <Autocomplete.Trigger aria-label="选择 DSH 接口协议" onClick={() => setQuery('')}
        className="absolute inset-y-0 right-0 flex w-7 items-center justify-center rounded-r text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
        <ChevronDown className="size-3.5" />
      </Autocomplete.Trigger>
    </Autocomplete.InputGroup>
    <Autocomplete.Portal>
      <Autocomplete.Positioner sideOffset={4} className="z-50 max-w-[calc(100vw-1.5rem)]">
        <Autocomplete.Popup className="w-[var(--anchor-width)] min-w-0 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <Autocomplete.Empty><span className="block px-2 py-2 text-xs text-muted-foreground">没有匹配项，可直接输入自定义协议。</span></Autocomplete.Empty>
          <Autocomplete.List className="max-h-64 overflow-y-auto overscroll-contain">
            {(item: ProtocolSuggestion) => <Autocomplete.Item key={item.api} value={item} title={item.api}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-4">{item.label}</span>
                <span className="block text-xs leading-4 text-muted-foreground">{item.hint}</span>
              </span>
              {value === item.api && <Check className="size-3.5 shrink-0 text-primary" aria-label="当前协议" />}
            </Autocomplete.Item>}
          </Autocomplete.List>
        </Autocomplete.Popup>
      </Autocomplete.Positioner>
    </Autocomplete.Portal>
  </Autocomplete.Root>;
}
