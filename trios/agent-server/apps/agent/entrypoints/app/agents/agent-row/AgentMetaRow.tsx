import type { FC } from 'react'
import { formatRelativeTime } from '../agent-display.helpers'
import { AgentTokenSummary } from './AgentTokenSummary'
import type { AgentTokenUsage } from './agent-row.types'

interface AgentMetaRowProps {
  lastUsedAt: number | null
  tokens: AgentTokenUsage | null
}

/**
 * Bottom-of-row meta line. Intentionally sparse — last activity time
 * and lifetime tokens. CWD is no longer surfaced here because the path
 * the server happens to be running from isn't actionable; if a future
 * surface needs the cwd (chat panel, debug view) it reads from the
 * listing payload directly.
 */
export const AgentMetaRow: FC<AgentMetaRowProps> = ({ lastUsedAt, tokens }) => {
  const lastUsedLabel = formatRelativeTime(lastUsedAt)
  const tokensTotal =
    (tokens?.cumulative.input ?? 0) + (tokens?.cumulative.output ?? 0)
  const showTokens = tokensTotal > 0

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
      <span>{lastUsedLabel}</span>
      {showTokens && (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <AgentTokenSummary tokens={tokens} />
        </>
      )}
    </div>
  )
}
