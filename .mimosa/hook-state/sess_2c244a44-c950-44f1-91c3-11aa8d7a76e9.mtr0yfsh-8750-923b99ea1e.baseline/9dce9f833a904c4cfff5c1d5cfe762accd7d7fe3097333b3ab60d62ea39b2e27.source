import { TriangleAlert } from 'lucide-react'
import type { FC } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { adapterLabel } from '../AdapterIcon'
import type { HarnessAgentAdapter } from '../agent-harness-types'
import type { AgentAdapterHealth } from './agent-row.types'

interface AgentSummaryChipsProps {
  adapter: HarnessAgentAdapter | 'unknown'
  modelLabel: string | null
  reasoningEffort: string | null
  /** When unhealthy, the adapter label dims and a warning chip appears. */
  adapterHealth: AgentAdapterHealth | null
}

/**
 * Adapter / model / reasoning summary line. Always rendered (so OpenClaw
 * rows that fall back to defaults still expose what they're set up to do)
 * and surfaces adapter-health *only when unhealthy* — keeping the calm
 * default state silent and reserving visual noise for things the user
 * needs to act on.
 */
export const AgentSummaryChips: FC<AgentSummaryChipsProps> = ({
  adapter,
  modelLabel,
  reasoningEffort,
  adapterHealth,
}) => {
  const parts = [adapterLabel(adapter)]
  if (modelLabel) parts.push(modelLabel)
  if (reasoningEffort) parts.push(reasoningEffort)
  const unhealthy = adapterHealth?.healthy === false
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-muted-foreground text-xs',
        unhealthy && 'text-muted-foreground/70',
      )}
    >
      <span className="truncate">{parts.join(' · ')}</span>
      {unhealthy && adapterHealth && (
        <HoverCard openDelay={200}>
          <HoverCardTrigger asChild>
            <Badge
              variant="outline"
              className="h-5 cursor-default gap-1 border-amber-500/40 bg-amber-50 px-1.5 text-amber-900 hover:bg-amber-50"
            >
              <TriangleAlert className="size-2.5" />
              <span className="font-normal">Unavailable</span>
            </Badge>
          </HoverCardTrigger>
          <HoverCardContent side="right" className="w-72 text-sm">
            <div className="font-medium">
              {adapterLabel(adapter)} CLI not available
            </div>
            <div className="mt-1 text-muted-foreground text-xs">
              {adapterHealth.reason ??
                'Adapter binary missing on $PATH. Install it from the adapter docs to use this agent.'}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}
