import type { FC } from 'react'
import { Badge } from '@/components/ui/badge'
import { displayName } from '../agent-display.helpers'
import type { AgentListItem } from '../agents-page-types'
import type { AgentLiveness } from '../LivenessDot'
import { AgentSparkline } from './AgentSparkline'
import { PinToggle } from './PinToggle'

interface AgentTitleRowProps {
  agent: AgentListItem
  status: AgentLiveness
  pinned: boolean
  turnsByDay: number[]
  failedByDay: number[]
  onPinToggle: (next: boolean) => void
}

/**
 * Title strip: name + status badge + (right-aligned) sparkline. The
 * pin toggle sits trailing the title so the title always flushes left
 * regardless of pin state — moving the star left of the title indents
 * the row's first line off-axis from the model/preview/meta lines
 * below it. When unpinned and not hovered, the toggle is removed from
 * layout entirely so it reserves no space at all.
 */
export const AgentTitleRow: FC<AgentTitleRowProps> = ({
  agent,
  status,
  pinned,
  turnsByDay,
  failedByDay,
  onPinToggle,
}) => (
  <div className="mb-1 flex items-center gap-2">
    <span className="truncate font-semibold">{displayName(agent)}</span>
    {status === 'working' && (
      <Badge
        variant="secondary"
        className="bg-amber-50 text-amber-900 hover:bg-amber-50"
      >
        Working
      </Badge>
    )}
    {status === 'asleep' && (
      <Badge variant="outline" className="text-muted-foreground">
        Asleep
      </Badge>
    )}
    {status === 'error' && <Badge variant="destructive">Attention</Badge>}
    <PinToggle pinned={pinned} onToggle={onPinToggle} />
    <div className="ml-auto">
      <AgentSparkline turnsByDay={turnsByDay} failedByDay={failedByDay} />
    </div>
  </div>
)
