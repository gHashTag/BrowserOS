/**
 * Contract suite for the exports of ConversationList.tsx.
 *
 * The module exports exactly one symbol: `ConversationList`. Every
 * assertion below renders that export and asserts on the markup it
 * emits, so the suite pins observable behaviour rather than the shape
 * of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ConversationList`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component has no live dependency: everything it renders follows
 * from its props, so the suite needs no network, no database and no
 * container. React Router's `Link` only renders inside a router
 * context, so every render wraps the export in an in-memory router.
 *
 * Not pinned, and why: two interactive behaviours cannot be exercised
 * under `renderToString`, which runs no effects and emits no live DOM.
 * (1) Infinite scroll - the `IntersectionObserver` that fires
 * `onLoadMore` when the sentinel scrolls into view needs a real
 * browser viewport, and `bun test` has no DOM environment
 * (`@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile). Only the mounting of the sentinel element itself is
 * pinned. (2) The delete flow - clicking a delete button opens a Radix
 * dialog and only the confirmed click invokes `onDelete`; dispatching
 * those DOM events needs the same missing environment. Only the
 * initial render of the delete affordance, and the dialog starting
 * closed, are pinned. These are gaps in interaction coverage, not
 * exports left unexercised: the export itself is rendered and asserted
 * on, so no export belongs in the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import type { ComponentProps } from 'react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { ConversationList } from './ConversationList'
import type { GroupedConversations, HistoryConversation } from './types'

const conversation = (id: string, preview: string): HistoryConversation => ({
  id,
  lastUserMessage: preview,
  // Only used for the relative-time line, which no assertion reads;
  // any value renders deterministically.
  lastMessagedAt: Date.now(),
})

const groups = (
  overrides: Partial<GroupedConversations> = {},
): GroupedConversations => ({
  today: [],
  thisWeek: [],
  thisMonth: [],
  older: [],
  ...overrides,
})

const renderList = (
  props: Partial<ComponentProps<typeof ConversationList>>,
): string =>
  renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(ConversationList, {
        groupedConversations: groups(),
        activeConversationId: '',
        ...props,
      }),
    ),
  )

// The refresh banner and the load-more area each own exactly one
// animated spinner in the markup, so this count is the number of
// spinners the user sees.
const spinnerCount = (html: string): number =>
  (html.match(/animate-spin/g) ?? []).length

// The element the IntersectionObserver attaches to is the only one
// carrying this layout marker, so this count says whether the watched
// sentinel is mounted.
const sentinelCount = (html: string): number =>
  (html.match(/justify-center py-4/g) ?? []).length

// A conversation link carries the highlighted style exactly when its
// id matches the active conversation, and no other element uses it.
const highlightCount = (html: string): number =>
  (html.match(/bg-muted\/70/g) ?? []).length

describe('ConversationListTsxContract', () => {
  it('renders an inviting empty state when no conversation exists', () => {
    const html = renderList({})

    expect(html).toContain('No conversations yet')
    expect(html).toContain('>Start a new chat</a>')
    expect(html).not.toContain('>Today</h3>')
    expect(html).not.toContain('>This Week</h3>')
    expect(html).not.toContain('>This Month</h3>')
    expect(html).not.toContain('>Older</h3>')
    expect(html).not.toContain('Fetching latest conversations')
    expect(spinnerCount(html)).toBe(0)
  })

  it('groups conversations under their time-bucket headings in order', () => {
    const html = renderList({
      groupedConversations: groups({
        today: [conversation('t1', 'Fix the login flow')],
        thisWeek: [conversation('w1', 'Draft the roadmap')],
        thisMonth: [conversation('m1', 'Review the budget')],
        older: [conversation('o1', 'Plan the offsite')],
      }),
    })

    const todayHeadingAt = html.indexOf('>Today</h3>')
    const todayItemAt = html.indexOf('Fix the login flow')
    const weekHeadingAt = html.indexOf('>This Week</h3>')
    const weekItemAt = html.indexOf('Draft the roadmap')
    const monthHeadingAt = html.indexOf('>This Month</h3>')
    const monthItemAt = html.indexOf('Review the budget')
    const olderHeadingAt = html.indexOf('>Older</h3>')
    const olderItemAt = html.indexOf('Plan the offsite')

    expect(todayHeadingAt).toBeGreaterThanOrEqual(0)
    expect(todayItemAt).toBeGreaterThan(todayHeadingAt)
    expect(weekHeadingAt).toBeGreaterThan(todayItemAt)
    expect(weekItemAt).toBeGreaterThan(weekHeadingAt)
    expect(monthHeadingAt).toBeGreaterThan(weekItemAt)
    expect(monthItemAt).toBeGreaterThan(monthHeadingAt)
    expect(olderHeadingAt).toBeGreaterThan(monthItemAt)
    expect(olderItemAt).toBeGreaterThan(olderHeadingAt)
    expect(html).not.toContain('No conversations yet')
  })

  it('omits the heading of any time bucket that holds no conversation', () => {
    const html = renderList({
      groupedConversations: groups({
        today: [conversation('t1', 'Fix the login flow')],
        older: [conversation('o1', 'Plan the offsite')],
      }),
    })

    expect(html).toContain('>Today</h3>')
    expect(html).toContain('>Older</h3>')
    expect(html).not.toContain('>This Week</h3>')
    expect(html).not.toContain('>This Month</h3>')
  })

  it('links every conversation to its own conversation id', () => {
    const html = renderList({
      groupedConversations: groups({
        today: [
          conversation('t1', 'Fix the login flow'),
          conversation('t2', 'Draft the roadmap'),
        ],
      }),
    })

    expect(html).toContain('href="/?conversationId=t1"')
    expect(html).toContain('href="/?conversationId=t2"')
  })

  it('highlights exactly the conversation whose id is active', () => {
    const grouped = groups({
      today: [
        conversation('t1', 'Fix the login flow'),
        conversation('t2', 'Draft the roadmap'),
      ],
    })

    const withActive = renderList({
      groupedConversations: grouped,
      activeConversationId: 't1',
    })
    expect(highlightCount(withActive)).toBe(1)
    // The highlighted anchor is the active conversation's own link.
    expect(withActive).toContain('bg-muted/70" href="/?conversationId=t1"')

    const withNone = renderList({
      groupedConversations: grouped,
      activeConversationId: 'no-such-conversation',
    })
    expect(highlightCount(withNone)).toBe(0)
  })

  it('shows the refresh banner only while a refresh is in flight', () => {
    const grouped = groups({
      today: [conversation('t1', 'Fix the login flow')],
    })

    const refreshing = renderList({
      groupedConversations: grouped,
      isRefreshing: true,
    })
    expect(refreshing).toContain('Fetching latest conversations')
    expect(spinnerCount(refreshing)).toBe(1)

    const idle = renderList({ groupedConversations: grouped })
    expect(idle).not.toContain('Fetching latest conversations')
    expect(spinnerCount(idle)).toBe(0)
  })

  it('offers per-conversation deletion only when a delete handler is supplied', () => {
    const grouped = groups({
      today: [conversation('t1', 'Fix the login flow')],
      thisWeek: [conversation('w1', 'Draft the roadmap')],
    })

    const deletable = renderList({
      groupedConversations: grouped,
      onDelete: () => undefined,
    })
    expect(deletable).toContain('title="Delete conversation"')
    expect((deletable.match(/title="Delete conversation"/g) ?? []).length).toBe(
      2,
    )
    // The confirmation dialog starts closed for every item.
    expect(deletable).not.toContain('Delete conversation?')

    const frozen = renderList({ groupedConversations: grouped })
    expect(frozen).not.toContain('title="Delete conversation"')
  })

  it('mounts the load-more sentinel only while another page exists', () => {
    const grouped = groups({
      today: [conversation('t1', 'Fix the login flow')],
    })

    const moreAvailable = renderList({
      groupedConversations: grouped,
      hasNextPage: true,
    })
    expect(sentinelCount(moreAvailable)).toBe(1)
    // A next page that exists but is not being fetched shows no spinner.
    expect(spinnerCount(moreAvailable)).toBe(0)

    const exhausted = renderList({ groupedConversations: grouped })
    expect(sentinelCount(exhausted)).toBe(0)
  })

  it('spins in the load-more area only while the next page is fetched', () => {
    const grouped = groups({
      today: [conversation('t1', 'Fix the login flow')],
    })

    const fetching = renderList({
      groupedConversations: grouped,
      hasNextPage: true,
      isFetchingNextPage: true,
    })
    expect(sentinelCount(fetching)).toBe(1)
    expect(spinnerCount(fetching)).toBe(1)

    // Without a next page there is nothing to fetch, spinner included.
    const stray = renderList({
      groupedConversations: grouped,
      isFetchingNextPage: true,
    })
    expect(sentinelCount(stray)).toBe(0)
    expect(spinnerCount(stray)).toBe(0)
  })
})
