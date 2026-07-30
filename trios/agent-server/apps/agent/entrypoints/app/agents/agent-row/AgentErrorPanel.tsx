import { AlertTriangle, ChevronDown } from 'lucide-react'
import { type FC, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { truncate } from './agent-row.helpers'

interface AgentErrorPanelProps {
  agentId: string
  message: string
  errorAt: number | null
}

const STORAGE_PREFIX = 'agent-row:lastErrorSeenAt:'
const PREVIEW_CHARS = 200

export const AgentErrorPanel: FC<AgentErrorPanelProps> = ({
  agentId,
  message,
  errorAt,
}) => {
  const storageKey = `${STORAGE_PREFIX}${agentId}`
  // Open if we've never seen this `errorAt` for this agent. Once the
  // user collapses the panel (or refreshes after seeing it), we mark
  // it seen so it doesn't re-pop on every poll.
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !errorAt) return true
    const seen = Number(window.localStorage.getItem(storageKey) ?? 0)
    return !Number.isFinite(seen) || errorAt > seen
  })

  useEffect(() => {
    if (!open && errorAt && typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, String(errorAt))
    }
  }, [open, errorAt, storageKey])

  const preview = truncate(message, PREVIEW_CHARS)
  const truncated = preview.length < message.length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
        <div className="flex items-center gap-2 font-medium text-destructive text-xs">
          <AlertTriangle className="size-3.5" />
          Last error
        </div>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-muted-foreground"
          >
            <span className="text-xs">{open ? 'hide' : 'show'}</span>
            <ChevronDown
              className={cn(
                'ml-1 size-3 transition-transform',
                open && 'rotate-180',
              )}
            />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-1 rounded-md border-destructive/30 border-x border-b bg-destructive/5 px-3 pb-2 text-xs">
          {truncated ? (
            <HoverCard openDelay={300}>
              <HoverCardTrigger asChild>
                <span className="cursor-default font-mono text-foreground/80">
                  {preview}…
                </span>
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                className="max-w-md whitespace-pre-wrap font-mono text-xs"
              >
                {message}
              </HoverCardContent>
            </HoverCard>
          ) : (
            <span className="font-mono text-foreground/80">{message}</span>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
