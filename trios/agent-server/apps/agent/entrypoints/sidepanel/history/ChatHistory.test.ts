/**
 * Contract suite for the exports of ChatHistory.tsx.
 *
 * The module exports exactly one symbol: `ChatHistory`. Every assertion
 * below renders that export - through its real child components - with the
 * session, storage and GraphQL hooks it depends on swapped for in-memory
 * stubs via `mock.module`, and asserts on the markup the tree emits, so
 * the suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ChatHistory`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The live dependencies are the GraphQL API that the `@/lib/graphql/*`
 * hooks call over HTTP and the `@wxt-dev/storage` items behind
 * `@/lib/auth/sessionStorage` and `@/lib/conversations/conversationStorage`;
 * those hook modules are stubbed here, so this suite needs no network, no
 * database and no container. The two GraphQL document modules the component
 * imports are built on `@/generated/graphql/gql`, which is generated at
 * build time and not committed, so they are stubbed with inert strings as
 * well. `useChatSessionContext` is stubbed because mounting its real
 * provider drags in the whole chat session; the `react-query` provider and
 * `react-router`'s `MemoryRouter` wrapping the render are the real ones.
 *
 * Not pinned, and why: user interactions (opening a conversation row,
 * opening and confirming the delete dialog, triggering the infinite-scroll
 * load-more) dispatch DOM events. There is no DOM environment available to
 * `bun test` in this project - `@testing-library`, `happy-dom` and `jsdom`
 * are all absent from the lockfile - so only the component's rendered
 * output is pinned. That is a gap in interaction coverage, not an export
 * left unexercised: the export itself is rendered and asserted on, so no
 * export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

type ChatMessage = {
  role: string
  parts: Array<{ type: string; text: string }>
}

type LocalConversation = {
  id: string
  messages: ChatMessage[]
  lastMessagedAt: number
}

type RemoteConversationNode = {
  rowId: string
  lastMessagedAt: string
  conversationMessages: { nodes: Array<{ message: ChatMessage } | null> }
}

type InfiniteQueryState = {
  data?: {
    pages: Array<{
      conversations?: { nodes: Array<RemoteConversationNode | null> }
    }>
  }
  isLoading: boolean
  isFetching: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
}

type SessionInfoState = {
  sessionInfo: { user?: { id: string } }
  isLoading: boolean
  updateSessionInfo: (info: { user?: { id: string } }) => Promise<void>
}

let sessionInfoState: SessionInfoState
let localConversations: LocalConversation[]
let profileData: { profileByUserId: { rowId: string } } | undefined
let infiniteState: InfiniteQueryState
let activeConversationId: string

mock.module('../../../lib/auth/sessionStorage', () => ({
  useSessionInfo: () => sessionInfoState,
}))

mock.module('../../../lib/conversations/conversationStorage', () => ({
  useConversations: () => ({
    conversations: localConversations,
    removeConversation: () => {},
  }),
}))

mock.module('../../../lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: () => ({ data: profileData }),
}))

mock.module('../../../lib/graphql/useGraphqlInfiniteQuery', () => ({
  useGraphqlInfiniteQuery: () => infiniteState,
}))

mock.module('../../../lib/graphql/useGraphqlMutation', () => ({
  useGraphqlMutation: () => ({ mutate: () => {} }),
}))

mock.module('../layout/ChatSessionContext', () => ({
  useChatSessionContext: () => ({ conversationId: activeConversationId }),
}))

// The document modules re-export values produced by
// `@/generated/graphql/gql`, which is generated at build time and not
// committed, so inert strings stand in and the suite does not depend on
// codegen having run.
mock.module('./graphql/chatHistoryDocument', () => ({
  GetConversationsForHistoryDocument: 'query GetConversationsForHistory',
  DeleteConversationDocument: 'mutation DeleteConversation',
}))

mock.module(
  '../../../lib/conversations/graphql/uploadConversationDocument',
  () => ({
    GetProfileIdByUserIdDocument: 'query GetProfileIdByUserId',
  }),
)

const { ChatHistory } = await import('./ChatHistory')

const userMessage = (text: string): ChatMessage => ({
  role: 'user',
  parts: [{ type: 'text', text }],
})

const assistantMessage = (text: string): ChatMessage => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

// Timestamps are chosen so bucketing cannot drift with the calendar day the
// suite happens to run on: noon today always lands in Today, and 45 days
// back is always outside the current calendar month, so it lands in Older.
const todayNoon = dayjs().startOf('day').add(12, 'hour')
const longAgo = dayjs().startOf('day').subtract(45, 'day')
// Deliberately without a trailing 'Z', exercising the component's
// normalisation of server timestamps before they are parsed.
const serverStamp = (moment: dayjs.Dayjs): string =>
  moment.format('YYYY-MM-DDTHH:mm:ss')

const remoteTodayNode: RemoteConversationNode = {
  rowId: 'conv-today',
  lastMessagedAt: serverStamp(todayNoon),
  conversationMessages: {
    nodes: [
      null,
      { message: assistantMessage('REMOTE-ASSISTANT-NOISE') },
      { message: userMessage('REMOTE-TODAY-USER-PREVIEW') },
    ],
  },
}

const remoteOlderNode: RemoteConversationNode = {
  rowId: 'conv-older',
  lastMessagedAt: serverStamp(longAgo),
  // No user message at all, so the row must fall back to the default label.
  conversationMessages: { nodes: [null] },
}

const settledInfinite: InfiniteQueryState = {
  data: {
    // Two pages, with null nodes and a page without a conversations key
    // mixed in: only the real conversations must survive into the list.
    pages: [
      { conversations: { nodes: [remoteTodayNode, null] } },
      {},
      { conversations: { nodes: [null, remoteOlderNode] } },
    ],
  },
  isLoading: false,
  isFetching: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => {},
}

const profile = { profileByUserId: { rowId: 'profile-77' } }

const signedIn: SessionInfoState = {
  sessionInfo: { user: { id: 'user-1' } },
  isLoading: false,
  updateSessionInfo: async () => {},
}

const signedOut: SessionInfoState = {
  sessionInfo: {},
  isLoading: false,
  updateSessionInfo: async () => {},
}

const localConversation: LocalConversation = {
  id: 'conv-local',
  messages: [userMessage('LOCAL-USER-PREVIEW')],
  lastMessagedAt: todayNoon.valueOf(),
}

const renderChatHistory = (): string =>
  renderToString(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(MemoryRouter, null, createElement(ChatHistory)),
    ),
  )

describe('ChatHistoryTsxContract', () => {
  it('renders the export across its local and remote history branches', () => {
    // While the profile lookup has not resolved, the remote branch shows a
    // spinner and no conversation rows from either source.
    sessionInfoState = signedIn
    profileData = undefined
    infiniteState = { ...settledInfinite, data: undefined, isLoading: true }
    activeConversationId = 'conv-today'
    localConversations = [localConversation]

    let html = renderChatHistory()
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('REMOTE-TODAY-USER-PREVIEW')
    expect(html).not.toContain('LOCAL-USER-PREVIEW')
    expect(html).not.toContain('No conversations yet')

    // Once the profile resolves but the conversation pages are still
    // loading, the spinner branch still holds.
    profileData = profile
    infiniteState = { ...settledInfinite, isLoading: true }
    html = renderChatHistory()
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('>Today<')

    // Settled remote render: pages are flattened, rows land in their
    // calendar buckets, and only the last user message becomes the label.
    infiniteState = { ...settledInfinite, isLoading: false }
    html = renderChatHistory()
    expect(html).toContain('REMOTE-TODAY-USER-PREVIEW')
    expect(html).not.toContain('REMOTE-ASSISTANT-NOISE')
    // The second page's conversation is present, and a conversation with
    // no user message falls back to the default label.
    expect(html).toContain('New conversation')
    expect(html).toContain('>Today<')
    expect(html).toContain('>Older<')
    expect(html).not.toContain('>This Week<')
    expect(html).not.toContain('>This Month<')
    // The stored local history is not consulted on the remote branch.
    expect(html).not.toContain('LOCAL-USER-PREVIEW')
    // The active conversation is highlighted exactly once, and every row
    // carries a delete affordance.
    expect(html.match(/bg-muted\/70/g)?.length).toBe(1)
    expect(html.match(/title="Delete conversation"/g)?.length).toBe(2)
    // No refresh banner while nothing refetches in the background.
    expect(html).not.toContain('Fetching latest conversations')

    // A background refetch announces itself without dropping the rows.
    infiniteState = { ...settledInfinite, isFetching: true }
    html = renderChatHistory()
    expect(html).toContain('Fetching latest conversations')
    expect(html).toContain('REMOTE-TODAY-USER-PREVIEW')

    // Signed out: the component falls back to the locally stored history.
    sessionInfoState = signedOut
    html = renderChatHistory()
    expect(html).toContain('LOCAL-USER-PREVIEW')
    expect(html).toContain('>Today<')
    expect(html).not.toContain('REMOTE-TODAY-USER-PREVIEW')
    expect(html).not.toContain('Fetching latest conversations')

    // Signed out with nothing stored: the empty state invites a new chat.
    localConversations = []
    html = renderChatHistory()
    expect(html).toContain('No conversations yet')
    expect(html).toContain('Start a new chat')
  })
})
