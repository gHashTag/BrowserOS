/**
 * Contract suite for the exports of AdminDashboardPage.tsx (DRAFT).
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  ConversationExecutionHistory,
  ExecutionTaskRecord,
} from '@/lib/execution-history/types'

let historyResult: Record<string, ConversationExecutionHistory>

mock.module('@/lib/execution-history/storage', () => ({
  removeConversationExecutionTask: async () => undefined,
  useExecutionHistoryByConversation: () => historyResult,
}))

const { AdminDashboardPage } = await import('./AdminDashboardPage')

const olderTask: ExecutionTaskRecord = {
  id: 'task-older',
  conversationId: 'chat-alpha',
  promptText: 'Summarise the quarterly report',
  startedAt: '2020-01-01T09:00:00.000Z',
  completedAt: '2020-01-01T09:01:30.000Z',
  status: 'completed',
  responsePreview: 'Revenue is up overall.',
  actionCount: 1,
  approvalCount: 0,
  deniedCount: 0,
  errorCount: 0,
  steps: [],
}

const newerRunningTask: ExecutionTaskRecord = {
  id: 'task-newer',
  conversationId: 'chat-beta',
  promptText: 'Draft the release notes',
  startedAt: '2020-01-02T10:00:00.000Z',
  status: 'running',
  actionCount: 2,
  approvalCount: 0,
  deniedCount: 0,
  errorCount: 0,
  steps: [],
}

const historyFor = (entries: ConversationExecutionHistory[]) =>
  Object.fromEntries(
    entries.map((entry) => [entry.conversationId, entry]),
  ) as Record<string, ConversationExecutionHistory>

const render = (history: Record<string, ConversationExecutionHistory>) => {
  historyResult = history
  return renderToString(createElement(AdminDashboardPage))
}

describe('AdminDashboardPageTsxContract', () => {
  it('calibration dump', () => {
    const twoChats = historyFor([
      {
        conversationId: 'chat-alpha',
        updatedAt: 1577872800000,
        tasks: [olderTask],
      },
      {
        conversationId: 'chat-beta',
        updatedAt: 1577964000000,
        tasks: [newerRunningTask],
      },
    ])
    const html = render(twoChats)
    console.log('===TWO CHATS===')
    console.log(html)
    const emptyHtml = render({})
    console.log('===EMPTY===')
    console.log(emptyHtml)
    const singleHtml = render(
      historyFor([
        {
          conversationId: 'chat-alpha',
          updatedAt: 1577872800000,
          tasks: [olderTask],
        },
      ]),
    )
    console.log('===SINGLE===')
    console.log(singleHtml)
    expect(true).toBe(true)
  })
})
