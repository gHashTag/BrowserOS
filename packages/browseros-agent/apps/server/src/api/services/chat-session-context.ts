/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentSession } from '../../agent/session-store'
import type { Browser } from '../../browser/browser'
import { logger } from '../../lib/logger'
import type { BrowserContext, ChatRequest } from '../types'
import { resolveBrowserContextPageIds } from '../utils/resolve-browser-context-page-ids'

export interface EffectiveBrowserContext {
  browserContext?: BrowserContext
  hiddenPageId?: number
  newlyCreatedHiddenPageId?: number
}

function logInfoSafely(
  message: string,
  details: Record<string, unknown>,
): void {
  try {
    logger.info(message, details)
  } catch {
    // Observability must not affect hidden-page ownership.
  }
}

function logWarningSafely(
  message: string,
  details: Record<string, unknown>,
): void {
  try {
    logger.warn(message, details)
  } catch {
    // Observability must not affect hidden-page ownership.
  }
}

export async function resolveEffectiveBrowserContext(
  browser: Browser,
  request: ChatRequest,
  session?: AgentSession,
): Promise<EffectiveBrowserContext> {
  if (
    request.isScheduledTask &&
    session?.hiddenPageId !== undefined &&
    session.browserContext
  ) {
    return {
      browserContext: {
        ...session.browserContext,
        enabledMcpServers: request.browserContext?.enabledMcpServers,
        customMcpServers: request.browserContext?.customMcpServers,
      },
      hiddenPageId: session.hiddenPageId,
    }
  }

  let browserContext = await resolveBrowserContextPageIds(
    browser,
    request.browserContext,
  )
  if (!request.isScheduledTask) {
    return { browserContext }
  }

  let hiddenPageId: number
  try {
    hiddenPageId = await browser.newPage('about:blank', {
      hidden: true,
      background: true,
    })
  } catch (error) {
    logWarningSafely('Failed to create hidden page, using default context', {
      conversationId: request.conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { browserContext }
  }

  let hiddenWindowId: number | undefined
  try {
    const hiddenPage = (await browser.listPages()).find(
      (page) => page.pageId === hiddenPageId,
    )
    hiddenWindowId = hiddenPage?.windowId
  } catch (error) {
    logWarningSafely('Failed to look up hidden page metadata', {
      conversationId: request.conversationId,
      pageId: hiddenPageId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  browserContext = {
    ...browserContext,
    windowId: hiddenWindowId,
    selectedTabs: undefined,
    tabs: undefined,
    activeTab: {
      id: hiddenPageId,
      pageId: hiddenPageId,
      url: 'about:blank',
      title: 'Scheduled Task',
    },
  }
  logInfoSafely('Created hidden page for scheduled task', {
    conversationId: request.conversationId,
    pageId: hiddenPageId,
    windowId: hiddenWindowId,
  })
  return {
    browserContext,
    hiddenPageId,
    newlyCreatedHiddenPageId: hiddenPageId,
  }
}

export function buildContextChanges(
  session: AgentSession,
  request: ChatRequest,
  mcpServerKey: string,
  mcpChanged: boolean,
  workspaceChanged: boolean,
): string[] {
  const contextChanges: string[] = []
  if (mcpChanged) {
    const oldParts = (session.mcpServerKey ?? '').split(',').filter(Boolean)
    const newParts = mcpServerKey.split(',').filter(Boolean)
    const oldKlavisState = oldParts.find((part) => part.startsWith('klavis:'))
    const newKlavisState = newParts.find((part) => part.startsWith('klavis:'))
    const oldServers = new Set(
      oldParts.filter((part) => !part.startsWith('klavis:')),
    )
    const newServers = new Set(
      newParts.filter((part) => !part.startsWith('klavis:')),
    )
    const added = [...newServers].filter((server) => !oldServers.has(server))
    const removed = [...oldServers].filter((server) => !newServers.has(server))

    const parts: string[] = []
    if (removed.length > 0) {
      parts.push(
        `The following app integrations were disconnected: ${removed.join(', ')}. Their tools are no longer available.`,
      )
    }
    if (added.length > 0) {
      parts.push(
        `The following app integrations were connected: ${added.join(', ')}. Their tools are now available.`,
      )
    }
    if (parts.length === 0) {
      if (
        oldKlavisState === 'klavis:pending' &&
        newKlavisState === 'klavis:connected' &&
        newServers.size > 0
      ) {
        parts.push(
          `Klavis app integration tools are now available for the following connected apps: ${[...newServers].join(', ')}.`,
        )
      } else {
        parts.push(
          'Connected app integrations changed during this conversation. Use only tools that are currently registered.',
        )
      }
    }
    contextChanges.push(parts.join(' '))
  }

  if (workspaceChanged) {
    if (!request.userWorkingDir) {
      contextChanges.push(
        'The user disconnected the workspace during this conversation. Filesystem tools (filesystem_read, filesystem_write, filesystem_edit, filesystem_bash, filesystem_grep, filesystem_find, filesystem_ls) are no longer available. Return all output directly in chat. If the user asks for file operations, suggest they select a working directory from the chat toolbar.',
      )
    } else if (!session.workingDir) {
      contextChanges.push(
        `The user connected a workspace during this conversation. Filesystem tools are now available. Working directory: ${request.userWorkingDir}`,
      )
    } else {
      contextChanges.push(
        `The user switched workspace during this conversation. Filesystem tools now use the new working directory: ${request.userWorkingDir}`,
      )
    }
  }

  return contextChanges
}

export function buildApprovalConfigKey(config?: {
  categories: Record<string, boolean>
}): string {
  if (!config) return ''
  return Object.entries(config.categories)
    .filter(([, enabled]) => enabled)
    .map(([category]) => category)
    .sort()
    .join(',')
}

export function buildMcpServerKey(
  browserContext: BrowserContext | undefined,
  klavisConnected: boolean,
): string {
  const managed = [...new Set(browserContext?.enabledMcpServers ?? [])].sort()
  const custom =
    browserContext?.customMcpServers?.map((server) => server.url).sort() ?? []
  const klavisState =
    managed.length > 0
      ? klavisConnected
        ? 'klavis:connected'
        : 'klavis:pending'
      : null
  return [klavisState, ...managed, ...custom].filter(Boolean).join(',')
}
