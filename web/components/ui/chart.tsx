import type { ComponentProps, ReactElement } from 'react';
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
  return <div role="tooltip" className={cn('w-52 max-w-[calc(100vw-4rem)] rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg', className)} {...props} />;
}
