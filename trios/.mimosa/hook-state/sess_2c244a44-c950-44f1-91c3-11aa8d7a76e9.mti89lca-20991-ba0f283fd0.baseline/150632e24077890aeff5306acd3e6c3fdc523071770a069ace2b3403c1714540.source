import { Plus } from 'lucide-react'
import type { FC } from 'react'
import type {
  HarnessAdapterDescriptor,
  HarnessAdapterHealth,
  HarnessAgent,
  HarnessAgentAdapter,
} from '@/entrypoints/app/agents/agent-harness-types'
import { cn } from '@/lib/utils'
import { HomeAgentCard } from './HomeAgentCard'

interface AgentCardDockProps {
  agents: HarnessAgent[]
  adapters: HarnessAdapterDescriptor[]
  activeAgentId?: string
  onSelectAgent: (agentId: string) => void
  onCreateAgent?: () => void
}

function CreateAgentButton({ onCreateAgent }: { onCreateAgent: () => void }) {
  return (
    <button
      type="button"
      onClick={onCreateAgent}
      className={cn(
        'flex min-h-32 shrink-0 items-center justify-center gap-2 rounded-2xl border border-dashed px-5 py-4 text-muted-foreground transition-colors',
        'hover:border-[var(--accent-orange)] hover:text-[var(--accent-orange)]',
      )}
    >
      <Plus className="size-5" />
      <span>Create agent</span>
    </button>
  )
}

/**
 * 3-column grid of HomeAgentCards plus a trailing "Create agent"
 * tile. The previous `compact` mode (rendered a horizontal pill rail)
 * had no callers and was dropped along with the legacy AgentCard.
 */
export const AgentCardDock: FC<AgentCardDockProps> = ({
  agents,
  adapters,
  activeAgentId,
  onSelectAgent,
  onCreateAgent,
}) => {
  if (agents.length === 0 && !onCreateAgent) return null

  const adapterHealth = new Map<HarnessAgentAdapter, HarnessAdapterHealth>()
  for (const descriptor of adapters) {
    if (descriptor.health) adapterHealth.set(descriptor.id, descriptor.health)
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {agents.map((agent) => (
        <HomeAgentCard
          key={agent.id}
          agent={agent}
          adapter={agent.adapter}
          adapterHealth={adapterHealth.get(agent.adapter) ?? null}
          active={agent.id === activeAgentId}
          onClick={() => onSelectAgent(agent.id)}
        />
      ))}
      {onCreateAgent ? (
        <CreateAgentButton onCreateAgent={onCreateAgent} />
      ) : null}
    </div>
  )
}
