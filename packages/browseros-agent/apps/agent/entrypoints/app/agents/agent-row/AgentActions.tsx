import {
  Copy,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import type { FC } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  canDelete as canDeleteAgent,
  canRename as canRenameAgent,
  displayName,
} from '../agent-display.helpers'
import type { AgentListItem } from '../agents-page-types'

interface AgentActionsProps {
  agent: AgentListItem
  activeTurnId: string | null
  deleting?: boolean
  onDelete: (agent: AgentListItem) => void
}

/**
 * Single primary CTA per row: `Resume` (filled, accent-orange, with a
 * pulsing dot) when an active turn exists; otherwise `Chat` (outline).
 * Both navigate to the same place — the chat hook auto-attaches via
 * `/chat/active` when there's a live turn — but the row signals which
 * action the user is actually taking.
 */
export const AgentActions: FC<AgentActionsProps> = ({
  agent,
  activeTurnId,
  deleting,
  onDelete,
}) => {
  const navigate = useNavigate()
  const allowDelete = canDeleteAgent(agent)
  const allowRename = canRenameAgent(agent)

  const handleChat = () => navigate(`/agents/${agent.agentId}`)
  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(agent.agentId)
      toast.success('Agent id copied')
    } catch {
      toast.error('Could not copy agent id')
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {activeTurnId ? (
        <Button
          variant="default"
          size="sm"
          onClick={handleChat}
          className="gap-2 bg-[var(--accent-orange)] text-white shadow-sm hover:bg-[var(--accent-orange)]/90"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-white" />
          </span>
          Resume
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={handleChat}>
          <MessageSquare className="mr-1.5 size-3" />
          Chat
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`More actions for ${displayName(agent)}`}
            className="size-8 text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => void handleCopyId()}>
            <Copy className="mr-2 size-3.5" />
            Copy id
          </DropdownMenuItem>
          <ComingSoonItem
            icon={Pencil}
            label="Rename"
            disabled={!allowRename}
          />
          <ComingSoonItem icon={RotateCcw} label="Reset history" disabled />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onDelete(agent)}
            disabled={!allowDelete || deleting}
            className="text-destructive focus:text-destructive"
          >
            {deleting ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-2 size-3.5" />
            )}
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

interface ComingSoonItemProps {
  icon: typeof Pencil
  label: string
  disabled: boolean
}

const ComingSoonItem: FC<ComingSoonItemProps> = ({
  icon: Icon,
  label,
  disabled,
}) => {
  const item = (
    <DropdownMenuItem disabled className="text-muted-foreground">
      <Icon className="mr-2 size-3.5" />
      {label}
    </DropdownMenuItem>
  )
  if (!disabled) return item
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block w-full">{item}</span>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          {label} coming soon
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
