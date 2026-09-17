import type { FC } from 'react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { formatTokens } from './agent-row.helpers'
import type { AgentTokenUsage } from './agent-row.types'

interface AgentTokenSummaryProps {
  tokens: AgentTokenUsage | null
}

/**
 * Inline token total + a HoverCard breakdown. Surfaces lifetime tokens
 * (the only window we can compute reliably from the session record).
 * Per-window stats land in a follow-up once the activity ledger ships.
 */
export const AgentTokenSummary: FC<AgentTokenSummaryProps> = ({ tokens }) => {
  if (!tokens) return null
  const { input, output } = tokens.cumulative
  const total = input + output
  if (total === 0) return null
  const inputPct = (input / total) * 100

  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <span className="cursor-default text-muted-foreground tabular-nums transition-colors hover:text-foreground">
          {formatTokens(total)} tokens
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-72 text-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-medium">Lifetime tokens</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatTokens(total)} total
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Input</span>
            <span className="tabular-nums">{formatTokens(input)}</span>
          </div>
          <Progress value={inputPct} className="h-1.5" />

          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Output</span>
            <span className="tabular-nums">{formatTokens(output)}</span>
          </div>
          <Progress value={100 - inputPct} className="h-1.5" />
        </div>

        <p className="mt-3 border-t pt-2 text-muted-foreground text-xs leading-snug">
          Cumulative across every turn this agent has run. Per-window stats
          arrive in a future release.
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
