/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * AGENT T Layout
 * Three-pane layout with header, sidebar, main content, and actions
 */

import type { FC, ReactNode } from 'react'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'

interface AgentTLayoutProps {
  header: ReactNode
  sidebar: ReactNode
  main: ReactNode
  actions: ReactNode
}

export const AgentTLayout: FC<AgentTLayoutProps> = ({
  header,
  sidebar,
  main,
  actions,
}) => {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        {header}
      </div>

      <ResizablePanelGroup className="flex-1" direction="horizontal">
        <ResizablePanel defaultSize={15} minSize={10} maxSize={20}>
          <div className="flex h-full flex-col border-r bg-muted/10 p-2">
            <div className="space-y-1">{sidebar}</div>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={65} minSize={40}>
          <div className="h-full overflow-auto">{main}</div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={20} minSize={15} maxSize={25}>
          <div className="flex h-full flex-col border-l bg-muted/10 p-4">
            {actions}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
