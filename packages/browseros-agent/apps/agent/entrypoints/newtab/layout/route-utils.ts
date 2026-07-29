const HIDE_FOCUS_GRID_PATHS = new Set([
  '/home',
  '/home/soul',
  '/home/memory',
  '/home/skills',
  '/home/chat',
])

export function isAgentCommandPath(pathname: string): boolean {
  return pathname === '/home' || isAgentConversationPath(pathname)
}

export function isAgentConversationPath(pathname: string): boolean {
  return pathname.startsWith('/home/agents/')
}

export function shouldHideFocusGrid(pathname: string): boolean {
  return (
    HIDE_FOCUS_GRID_PATHS.has(pathname) || isAgentConversationPath(pathname)
  )
}

export function shouldUseChatSession(
  pathname: string,
  useChatSessionOnHome = false,
): boolean {
  return (
    pathname === '/home/chat' || (useChatSessionOnHome && pathname === '/home')
  )
}
