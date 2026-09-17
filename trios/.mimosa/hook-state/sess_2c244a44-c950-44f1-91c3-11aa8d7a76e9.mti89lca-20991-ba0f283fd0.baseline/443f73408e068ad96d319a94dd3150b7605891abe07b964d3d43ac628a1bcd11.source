import type { FC } from 'react'
import { Outlet, useLocation } from 'react-router'
import { ChatSessionProvider } from '@/entrypoints/sidepanel/layout/ChatSessionContext'
import { NewTabFocusGrid } from './NewTabFocusGrid'
import { shouldHideFocusGrid, shouldUseChatSession } from './route-utils'

interface NewTabLayoutProps {
  useChatSessionOnHome?: boolean
}

export const NewTabLayout: FC<NewTabLayoutProps> = ({
  useChatSessionOnHome = false,
}) => {
  const location = useLocation()
  const hideGrid = shouldHideFocusGrid(location.pathname)
  const useChatSession = shouldUseChatSession(
    location.pathname,
    useChatSessionOnHome,
  )
  const content = (
    <>
      {!hideGrid && <NewTabFocusGrid />}
      <Outlet />
    </>
  )

  if (!useChatSession) return content

  return <ChatSessionProvider origin="newtab">{content}</ChatSessionProvider>
}
