import { Popover } from '@base-ui/react/popover';
import { CircleHelp } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';

/** Short help stays beside its control; touch users can open the same content by tapping. */
export function HelpTip({ label, children }: { readonly label: string; readonly children: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <Popover.Root open={open} onOpenChange={setOpen} triggerId={id} modal={false}>
    <Popover.Trigger id={id} type="button" openOnHover delay={200} closeDelay={120}
      aria-label={`${label}说明`} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true); }}
      className="inline-flex size-[18px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CircleHelp className="size-3" aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="top" sideOffset={6} collisionPadding={8} className="z-[80]">
      <Popover.Popup initialFocus={false} finalFocus={false} className="max-w-[min(20rem,calc(100vw-2rem))] rounded-md border bg-popover px-2 py-1.5 text-xs leading-[1.45] text-popover-foreground shadow-lg outline-none">
        <Popover.Title className="sr-only">{label}</Popover.Title>
        <Popover.Description className="whitespace-pre-wrap break-words">{children}</Popover.Description>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}

/** Adds hover and keyboard help without changing the button's click action. */
export function ActionTip({ children, content }: { readonly children: ReactElement; readonly content: string }) {
  return <Tooltip><TooltipTrigger render={children} /><TooltipContent sideOffset={6} className="max-w-[min(20rem,calc(100vw-2rem))] leading-[1.45]">{content}</TooltipContent></Tooltip>;
}
