import { Quote, TriangleAlert } from 'lucide-react'
import type { FC } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { adapterLabel } from '@/entrypoints/app/agents/AdapterIcon'
import { formatRelativeTime } from '@/entrypoints/app/agents/agent-display.helpers'
import type {
  HarnessAdapterHealth,
  HarnessAgent,
  HarnessAgentAdapter,
} from '@/entrypoints/app/agents/agent-harness-types'
import { AgentTile } from '@/entrypoints/app/agents/agent-row/AgentTile'
import {
  firstNonBlankLine,
  truncate,
} from '@/entrypoints/app/agents/agent-row/agent-row.helpers'
import type { AgentLiveness } from '@/entrypoints/app/agents/LivenessDot'
import { cn } from '@/lib/utils'

interface HomeAgentCardProps {
  agent: HarnessAgent
  adapter: HarnessAgentAdapter | 'unknown'
  /** Per-adapter health snapshot, shared across cards rendering the
   *  same adapter. `null` when the /adapters response hasn't surfaced
   *  health yet (we treat that as healthy until proven otherwise). */
  adapterHealth: HarnessAdapterHealth | null
  /** Highlights the card with an accent ring; tells the user which
   *  agent the conversation input is bound to. */
  active?: boolean
  onClick: () => void
}

const PREVIEW_CHARS = 100

/**
 * Grid-shaped card for the /home Recent agents section. Composition
 * mirrors the rail's `AgentRowCard` but the layout is a vertical
 * column sized for a 1/3-width tile rather than a full-width row.
 *
 * Reuses `<AgentTile>`, `<LivenessDot>`, `livenessDetail`,
 * `formatRelativeTime`, `firstNonBlankLine`, `truncate`, and the
 * inline `Unavailable` chip pattern so the visual language is
 * continuous between rail and grid.
 */
export const HomeAgentCard: FC<HomeAgentCardProps> = ({
  agent,
  adapter,
  adapterHealth,
  active,
  onClick,
}) => {
  const status = agent.status ?? 'unknown'
  const lastUsedAt = agent.lastUsedAt ?? null
  const isWorking = status === 'working'
  const isAsleep = status === 'asleep'
  const isError = status === 'error'
  const hasActiveTurn = Boolean(agent.activeTurnId)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-h-32 w-full min-w-0 flex-col rounded-2xl border bg-card p-4 text-left shadow-sm transition-colors',
        active && 'ring-1 ring-[var(--accent-orange)]/30',
        isWorking
          ? 'border-[var(--accent-orange)]/40'
          : isError
            ? 'border-destructive/30'
            : 'border-border/60 hover:border-[var(--accent-orange)]/30',
      )}
    >
      <div className="flex items-start gap-3">
        <AgentTile adapter={adapter} status={status} lastUsedAt={lastUsedAt} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-sm">
              {displayName(agent)}
            </span>
            {isWorking && (
              <Badge
                variant="secondary"
                className="ml-auto bg-amber-50 text-amber-900 hover:bg-amber-50"
              >
                Working
              </Badge>
            )}
          </div>
          <SummaryLine
            adapter={adapter}
            modelId={agent.modelId ?? null}
            reasoningEffort={agent.reasoningEffort ?? null}
            adapterHealth={adapterHealth}
          />
        </div>
      </div>

      <LastMessage message={agent.lastUserMessage ?? null} />

      <div className="mt-3 flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span>{statusFootnote(status, lastUsedAt)}</span>
        {hasActiveTurn ? (
          <ResumeChip />
        ) : isAsleep ? (
          <Badge variant="outline" className="text-muted-foreground">
            Asleep
          </Badge>
        ) : isError ? (
          <ErrorChip lastError={agent.lastError ?? null} />
        ) : null}
      </div>
    </button>
  )
}

const SummaryLine: FC<{
  adapter: HarnessAgentAdapter | 'unknown'
  modelId: string | null
  reasoningEffort: string | null
  adapterHealth: HarnessAdapterHealth | null
}> = ({ adapter, modelId, reasoningEffort, adapterHealth }) => {
  const parts = [adapterLabel(adapter)]
  if (modelId) parts.push(modelId)
  if (reasoningEffort) parts.push(reasoningEffort)
  const unhealthy = adapterHealth?.healthy === false
  return (
    <div
      className={cn(
        'mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs',
        unhealthy && 'text-muted-foreground/70',
      )}
    >
      <span className="truncate">{parts.join(' · ')}</span>
      {unhealthy && (
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
              {adapterHealth?.reason ??
                'Adapter binary missing on $PATH. Install it from the adapter docs to use this agent.'}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}

const LastMessage: FC<{ message: string | null }> = ({ message }) => {
  if (!message) {
    return (
      <p className="mt-3 flex-1 text-muted-foreground/70 text-xs italic">
        No messages yet — start a chat
      </p>
    )
  }
  return (
    <p className="mt-3 line-clamp-2 flex flex-1 items-start gap-1.5 text-foreground/85 text-sm italic leading-snug">
      <Quote
        className="mt-1 size-3 shrink-0 text-muted-foreground/60"
        aria-hidden
      />
      <span className="line-clamp-2">
        {truncate(firstNonBlankLine(message), PREVIEW_CHARS)}
      </span>
    </p>
  )
}

const ResumeChip: FC = () => (
  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-orange)] px-2.5 py-0.5 font-medium text-[11px] text-white shadow-sm">
    <span className="relative flex size-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70 opacity-75" />
      <span className="relative inline-flex size-1.5 rounded-full bg-white" />
    </span>
    Resume
  </span>
)

const ErrorChip: FC<{ lastError: string | null }> = ({ lastError }) => {
  if (!lastError) {
    return <Badge variant="destructive">Attention</Badge>
  }
  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <Badge variant="destructive" className="cursor-default">
          Attention
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent
        side="left"
        className="max-w-xs whitespace-pre-wrap font-mono text-xs"
      >
        {lastError}
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * Footer left side: relative time on every state EXCEPT working,
 * which shows `now` (the dot is already pulsing — restating it as
 * "Working" would duplicate the pill in the title row).
 */
function statusFootnote(
  status: AgentLiveness,
  lastUsedAt: number | null,
): string {
  if (status === 'working') return 'now'
  return formatRelativeTime(lastUsedAt)
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OC_UUID_PATTERN =
  /^oc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function displayName(agent: HarnessAgent): string {
  const name = agent.name?.trim()
  const id = agent.id
  if (!name || name === id) {
    if (OC_UUID_PATTERN.test(id)) return id.slice(0, 11)
    if (UUID_PATTERN.test(id)) return id.slice(0, 8)
    return id
  }
  return name
}
