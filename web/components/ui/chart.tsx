import { useLayoutEffect, useRef, type ComponentProps, type ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';

import { cn } from '../../lib/utils.ts';

export function ChartContainer({ children, className, ...props }: Omit<ComponentProps<'div'>, 'children'> & {
  readonly children: ReactElement;
}) {
  return <div data-slot="chart" className={cn('h-72 min-w-0 text-xs has-[svg:focus-visible]:ring-2 has-[svg:focus-visible]:ring-ring/50 [&_.recharts-surface]:outline-none [&_.recharts-layer]:outline-none [&_svg_[tabindex]]:outline-none', className)} {...props}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 320, height: 288 }}>
      {children}
    </ResponsiveContainer>
  </div>;
}

export function ChartTooltipContent({ className, ...props }: ComponentProps<'div'>) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    element.style.translate = 'none';
    let offsetX = 0;
    let offsetY = 0;
    const clamp = () => {
      const bounds = element.getBoundingClientRect();
      const x = bounds.left - offsetX;
      const y = bounds.top - offsetY;
      offsetX = Math.max(8, Math.min(x, innerWidth - bounds.width - 8)) - x;
      offsetY = Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) - y;
      element.style.translate = `${offsetX}px ${offsetY}px`;
    };
    clamp();
    const observer = new MutationObserver(clamp);
    if (element.parentElement) observer.observe(element.parentElement, { attributes: true, attributeFilter: ['style'] });
    const resize = new ResizeObserver(clamp);
    resize.observe(element);
    addEventListener('scroll', clamp, true);
    addEventListener('resize', clamp);
    return () => { observer.disconnect(); resize.disconnect(); removeEventListener('scroll', clamp, true); removeEventListener('resize', clamp); };
  });
  return <div ref={content} role="tooltip" className={cn('max-h-[calc(100dvh-1rem)] w-52 max-w-[calc(100vw-4rem)] overflow-auto rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg', className)} {...props} />;
}
