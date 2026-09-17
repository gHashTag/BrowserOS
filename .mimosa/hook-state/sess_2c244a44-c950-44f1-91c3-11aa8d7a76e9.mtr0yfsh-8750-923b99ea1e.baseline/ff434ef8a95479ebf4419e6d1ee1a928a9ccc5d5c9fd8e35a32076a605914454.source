import type { HarnessAgentAdapter } from '../agent-harness-types'
import type { AgentListItem } from '../agents-page-types'
import type { AgentLiveness } from '../LivenessDot'

/**
 * Window-bounded token usage. Server returns `null` when no session
 * record exists yet for the agent.
 */
export interface AgentTokenUsage {
  last7d: { input: number; output: number; requestCount: number }
  cumulative: { input: number; output: number }
}

export interface AgentAdapterHealth {
  healthy: boolean
  reason?: string
}

/**
 * Everything an `AgentRowCard` needs to render. Mirrors the shape
 * `useHarnessAgents` exposes; the page assembles one entry per row in
 * `AgentList` and passes it down. Sub-components only see slices of
 * this object — no prop drilling beyond two levels.
 */
export interface AgentRowData {
  agent: AgentListItem
  adapter: HarnessAgentAdapter | 'unknown'
  modelLabel: string | null
  reasoningEffort: string | null
  status: AgentLiveness
  lastUsedAt: number | null
  pinned: boolean
  cwd: string | null
  lastUserMessage: string | null
  tokens: AgentTokenUsage | null
  /** 14 entries, oldest → newest. Today is the last index. */
  turnsByDay: number[]
  /** Same length and ordering as `turnsByDay`. */
  failedByDay: number[]
  lastError: string | null
  lastErrorAt: number | null
  /** When non-null, an in-flight turn this row can be resumed from. */
  activeTurnId: string | null
  /** Adapter-level health, shared across rows for the same adapter. */
  adapterHealth: AgentAdapterHealth | null
}

export interface AgentRowCallbacks {
  onDelete: (agent: AgentListItem) => void
  onPinToggle: (agent: AgentListItem, next: boolean) => void
}
