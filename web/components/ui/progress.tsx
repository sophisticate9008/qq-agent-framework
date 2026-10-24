"use client"

import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cn } from "cn"

function clampPercentage(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

function Progress({
  className,
  indicatorClassName,
  value = 0,
  ...props
}: Omit<ProgressPrimitive.Root.Props, "value"> & {
  readonly indicatorClassName?: string
  readonly value?: number
}) {
  const percentage = clampPercentage(value)

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={percentage}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-primary/15", className)}
      {...props}
    >
      <ProgressPrimitive.Track data-slot="progress-track" className="h-full w-full overflow-hidden rounded-full">
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn("h-full rounded-full bg-primary transition-[width]", indicatorClassName)}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
