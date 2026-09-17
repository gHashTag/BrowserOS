import type { FC } from 'react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { formatLocalDate, ROW_BAR_COUNT } from './agent-row.helpers'

interface AgentSparklineProps {
  /** 14 entries, oldest → newest. Today's bucket is the last index. */
  turnsByDay: number[]
  /** Same length, same order. Failed turns counted separately. */
  failedByDay: number[]
  className?: string
}

const MIN_BAR_HEIGHT_PX = 2
const MAX_BAR_HEIGHT_PX = 18

export const AgentSparkline: FC<AgentSparklineProps> = ({
  turnsByDay,
  failedByDay,
  className,
}) => {
  if (turnsByDay.length === 0 || turnsByDay.every((n) => n === 0)) return null
  const max = Math.max(1, ...turnsByDay)

  return (
    <HoverCard openDelay={250}>
      <HoverCardTrigger asChild>
        <div
          role="img"
          aria-label={`Last ${ROW_BAR_COUNT} days of activity`}
          className={cn('flex h-5 items-end gap-px', className)}
        >
          {turnsByDay.map((count, idx) => {
            const ratio = count / max
            const height = Math.max(
              MIN_BAR_HEIGHT_PX,
              Math.round(ratio * MAX_BAR_HEIGHT_PX),
            )
            const isToday = idx === ROW_BAR_COUNT - 1
            const failed = failedByDay[idx] ?? 0
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length sparkline buckets keyed by day position
                key={`bar-${idx}`}
                className={cn(
                  'w-1.5 rounded-sm',
                  count === 0
                    ? 'bg-muted-foreground/15'
                    : failed > 0
                      ? 'bg-destructive/50'
                      : 'bg-[var(--accent-orange)]/50',
                  isToday && 'ring-1 ring-foreground/30',
                )}
                style={{ height }}
              />
            )
          })}
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="left" className="w-56 text-xs">
        <div className="mb-2 font-medium text-sm">Last 14 days</div>
        <ul className="space-y-0.5">
          {turnsByDay.map((count, idx) => {
            const failed = failedByDay[idx] ?? 0
            const dayLabel = formatLocalDate(idx)
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length list keyed by day position
                key={`day-${idx}`}
                className="flex items-center justify-between text-muted-foreground"
              >
                <span>{dayLabel}</span>
                <span>
                  {count}
                  {failed > 0 && (
                    <span className="ml-1 text-destructive">
                      ({failed} failed)
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </HoverCardContent>
    </HoverCard>
  )
}
