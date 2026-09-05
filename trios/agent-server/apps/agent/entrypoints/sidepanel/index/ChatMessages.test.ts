/**
 * Contract suite for the exports of ChatMessages.tsx.
 *
 * The module exports exactly one symbol: `ChatMessages`. The single
 * registration below renders that export across every prop combination the
 * component branches on and asserts on the markup it emits, so the suite
 * pins observable behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ChatMessages`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * Two boundaries are stubbed via `mock.module`; everything else - the
 * conversation and message primitives, the reasoning and task
 * collapsibles, `ChatMessageActions`, `JtbdPopup`,
 * `ScheduleSuggestionCard`, `ToolBatch` and `UserActionMessage` - is
 * rendered for real.
 *
 * 1. `./ConnectAppCard`: the component's one child with live
 *    dependencies. Rendering the real card would need a
 *    `ChatSessionContext` provider, SWR mutations against the agent
 *    server over HTTP, and WXT extension storage (the `#imports`
 *    virtual module, which only exists under `wxt build` and cannot be
 *    resolved by `bun test`). The stub echoes the props it receives
 *    into the markup so the assertions can pin which nudge data the
 *    subject hands across this boundary.
 * 2. `streamdown`: both `MessageResponse` and `ReasoningContent` wrap
 *    their text in Streamdown, whose default streaming mode parses the
 *    markdown into blocks inside a `useEffect` and renders an empty
 *    div until the component mounts. Its output is therefore invisible
 *    to `renderToString` no matter what the subject does. The stub is a
 *    plain passthrough that renders its children as text, so the suite
 *    can observe which text the subject passes into the message
 *    content regions. Markdown-to-HTML fidelity is streamdown's
 *    contract, not this module's, and stays unpinned here.
 *
 * Not pinned, and why: click-level behaviour (liking, disliking, approving
 * or denying a tool call, taking the survey, copy-to-clipboard). There is
 * no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the rendered output is pinned. The like/dislike state
 * is still observed through the markup it produces ("Feedback submitted"
 * replacing the thumbs), and pending approvals are observed through the
 * Approve/Deny controls they reveal. Those are gaps in interaction
 * coverage, not exports left unexercised: the export itself is rendered
 * and asserted on, so no export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { UIMessage } from 'ai'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import type { BrowserOSAction } from '@/lib/chat-actions/types'
import type { NudgeData } from './getMessageSegments'

// Boundary stub for the one live-dependency child (see header note). The
// stub echoes the props it receives into the markup so the assertions can
// pin which data the subject hands across this boundary.
const stubbedConnectCard = (props: {
  data: NudgeData
  isLastMessage: boolean
}) =>
  createElement(
    'div',
    null,
    `connect-app-stub:${String(props.data.appName)}:${String(props.isLastMessage)}`,
  )

mock.module('./ConnectAppCard', () => ({
  ConnectAppCard: stubbedConnectCard,
}))

// Passthrough stub for streamdown (see header note): renders the markdown
// source it is handed as plain text instead of deferring to an effect.
const stubbedStreamdown = (props: { children?: ReactNode }) =>
  createElement('div', null, props.children)

mock.module('streamdown', () => ({
  Streamdown: stubbedStreamdown,
}))

const { ChatMessages } = await import('./ChatMessages')

type ChatStatus = 'streaming' | 'submitted' | 'ready' | 'error'

const baseProps = {
  messages: [] as UIMessage[],
  status: 'ready' as ChatStatus,
  liked: {} as Record<string, boolean>,
  disliked: {} as Record<string, boolean>,
  onClickLike: () => {},
  onClickDislike: () => {},
  showJtbdPopup: false,
  showDontShowAgain: false,
  onTakeSurvey: () => {},
  onDismissJtbdPopup: () => {},
}

const render = (overrides: Partial<typeof baseProps>): string =>
  renderToString(createElement(ChatMessages, { ...baseProps, ...overrides }))

const uiMessage = (
  id: string,
  role: 'user' | 'assistant',
  parts: unknown[],
): UIMessage => ({ id, role, parts }) as unknown as UIMessage

const textPart = (text: string) => ({ type: 'text', text })

const reasoningPart = (text: string) => ({ type: 'reasoning', text })

const toolPart = (
  toolName: string,
  state: string,
  toolCallId: string,
  extra: Record<string, unknown> = {},
) => ({
  type: `tool-${toolName}`,
  toolCallId,
  state,
  input: {},
  output: [],
  ...extra,
})

// Tool output shape that getMessageSegments parses nudges from.
const nudgeOutput = (data: NudgeData) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
})

// Plain-substring counter; used for occurrences that must be exact (the
// number of typing-indicator dots, of action bars, ...).
const occurrences = (html: string, needle: string): number => {
  let total = 0
  let at = html.indexOf(needle)
  while (at !== -1) {
    total++
    at = html.indexOf(needle, at + needle.length)
  }
  return total
}

// Every copy/like/dislike control renders its label into a sr-only span,
// so these counts are the number of message action bars in the markup.
const COPY_BAR = 'sr-only">Copy<'
const LIKE_CONTROL = 'sr-only">Like<'
const DISLIKE_CONTROL = 'sr-only">Dislike<'

describe('ChatMessagesTsxContract', () => {
  it('ChatMessages renders the sidepanel conversation contract', () => {
    // --- An empty, settled conversation renders the log region and
    // --- neither the typing indicator nor the survey popup.
    const emptyHtml = render({})
    expect(emptyHtml).toContain('role="log"')
    expect(occurrences(emptyHtml, 'animate-bounce')).toBe(0)
    expect(emptyHtml).not.toContain('Help us improve BrowserOS!')

    // --- Messages render in order under their role, and only assistant
    // --- messages carry the action bar (exactly one Copy control for one
    // --- assistant message; a user-only conversation carries none).
    const chatHtml = render({
      messages: [
        uiMessage('u1', 'user', [textPart('Knock knock')]),
        uiMessage('a1', 'assistant', [textPart('Who is there')]),
      ],
    })
    expect(chatHtml).toContain('Knock knock')
    expect(chatHtml).toContain('Who is there')
    expect(chatHtml.indexOf('Knock knock')).toBeLessThan(
      chatHtml.indexOf('Who is there'),
    )
    expect(chatHtml).toContain('is-user')
    expect(chatHtml).toContain('is-assistant')
    expect(occurrences(chatHtml, COPY_BAR)).toBe(1)
    const userOnlyHtml = render({
      messages: [uiMessage('u2', 'user', [textPart('Solo question')])],
    })
    expect(occurrences(userOnlyHtml, COPY_BAR)).toBe(0)

    // --- 'streaming' and 'submitted' both count as streaming: the typing
    // --- indicator (three bouncing dots) shows and the last assistant
    // --- message hides its action bar while it streams.
    const streamingHtml = render({
      status: 'streaming',
      messages: [uiMessage('a2', 'assistant', [textPart('Working on it')])],
    })
    expect(occurrences(streamingHtml, 'animate-bounce')).toBe(3)
    expect(occurrences(streamingHtml, COPY_BAR)).toBe(0)
    const submittedHtml = render({
      status: 'submitted',
      messages: [uiMessage('a3', 'assistant', [textPart('Queued answer')])],
    })
    expect(occurrences(submittedHtml, 'animate-bounce')).toBe(3)
    expect(occurrences(submittedHtml, COPY_BAR)).toBe(0)

    // --- An assistant message that is not the last one keeps its action
    // --- bar even while the conversation streams.
    const mixedHtml = render({
      status: 'streaming',
      messages: [
        uiMessage('a4', 'assistant', [textPart('Earlier answer')]),
        uiMessage('u3', 'user', [textPart('Follow-up question')]),
      ],
    })
    expect(occurrences(mixedHtml, COPY_BAR)).toBe(1)
    expect(occurrences(mixedHtml, 'animate-bounce')).toBe(3)

    // --- 'error' is not a streaming state: no indicator, and the last
    // --- assistant message keeps its action bar.
    const errorHtml = render({
      status: 'error',
      messages: [uiMessage('a5', 'assistant', [textPart('It broke')])],
    })
    expect(occurrences(errorHtml, 'animate-bounce')).toBe(0)
    expect(occurrences(errorHtml, COPY_BAR)).toBe(1)

    // --- Liked and disliked state crosses into the action bar: feedback
    // --- replaces the thumbs once either flag is set for the message.
    const neutralHtml = render({
      messages: [uiMessage('a6', 'assistant', [textPart('Plain answer')])],
    })
    expect(occurrences(neutralHtml, LIKE_CONTROL)).toBe(1)
    expect(occurrences(neutralHtml, DISLIKE_CONTROL)).toBe(1)
    expect(neutralHtml).not.toContain('Feedback submitted')
    const likedHtml = render({
      messages: [uiMessage('a7', 'assistant', [textPart('Good answer')])],
      liked: { a7: true },
    })
    expect(likedHtml).toContain('Feedback submitted')
    expect(occurrences(likedHtml, LIKE_CONTROL)).toBe(0)
    const dislikedHtml = render({
      messages: [uiMessage('a8', 'assistant', [textPart('Bad answer')])],
      disliked: { a8: true },
    })
    expect(dislikedHtml).toContain('Feedback submitted')
    expect(occurrences(dislikedHtml, DISLIKE_CONTROL)).toBe(0)

    // --- When getActionForMessage returns an action for a message, that
    // --- action card renders in place of the message's own parts.
    const browserosAction: BrowserOSAction = {
      id: 'act-1',
      timestamp: 1,
      type: 'browseros',
      mode: 'agent',
      message: 'Condense the active tab',
    }
    const actionHtml = render({
      messages: [
        uiMessage('u4', 'user', [textPart('Raw prompt that must stay hidden')]),
      ],
      getActionForMessage: (message) =>
        message.id === 'u4' ? browserosAction : undefined,
    })
    expect(actionHtml).toContain('Condense the active tab')
    expect(actionHtml).toContain('>Agent<')
    expect(actionHtml).not.toContain('Raw prompt that must stay hidden')

    // --- Reasoning and text parts of one message both surface.
    const reasoningHtml = render({
      messages: [
        uiMessage('a9', 'assistant', [
          reasoningPart('Deliberating quietly'),
          textPart('Final answer'),
        ]),
      ],
    })
    expect(reasoningHtml).toContain('Deliberating quietly')
    expect(reasoningHtml).toContain('Final answer')

    // --- Tool parts collapse into one batch whose trigger reports the
    // --- completed count.
    const toolsHtml = render({
      messages: [
        uiMessage('a10', 'assistant', [
          toolPart('web_search', 'output-available', 't1'),
          toolPart('read_page', 'output-available', 't2'),
        ]),
      ],
    })
    expect(toolsHtml).toContain('2/2 actions completed')

    // --- A pending approval opens the batch and reveals the decision
    // --- controls and the tool's display name.
    const approvalHtml = render({
      messages: [
        uiMessage('a11', 'assistant', [
          toolPart('delete_file', 'approval-requested', 't3', {
            approval: { id: 'appr-7' },
          }),
        ]),
      ],
    })
    expect(approvalHtml).toContain('Waiting for approval...')
    expect(approvalHtml).toContain('>Approve<')
    expect(approvalHtml).toContain('>Deny<')
    expect(approvalHtml).toContain('Delete file')

    // --- Nudge tool outputs route to their cards: a schedule suggestion
    // --- renders the real schedule card with its parsed data...
    const scheduleHtml = render({
      messages: [
        uiMessage('a12', 'assistant', [
          toolPart('suggest_schedule', 'output-available', 't4', {
            output: nudgeOutput({
              type: 'schedule_suggestion',
              suggestedName: 'Morning News',
              scheduleType: 'daily',
              scheduleTime: '09:00',
              query: 'daily news digest',
            }),
          }),
        ]),
      ],
    })
    expect(scheduleHtml).toContain('Run this automatically?')
    expect(scheduleHtml).toContain('Morning News')
    expect(scheduleHtml).toContain('daily at 09:00')

    // --- ...and an app-connection nudge hands the parsed data and the
    // --- last-message flag across the ConnectAppCard boundary.
    const connectHtml = render({
      messages: [
        uiMessage('a13', 'assistant', [
          toolPart('suggest_app_connection', 'output-available', 't5', {
            output: nudgeOutput({
              type: 'app_connection',
              appName: 'Slack',
              reason: 'to read channels',
            }),
          }),
        ]),
      ],
    })
    expect(connectHtml).toContain('connect-app-stub:Slack:true')

    // --- The JTBD survey popup appears only when asked for, and its
    // --- "don't show again" checkbox only when that flag is set.
    const popupHtml = render({ showJtbdPopup: true, showDontShowAgain: true })
    expect(popupHtml).toContain('Help us improve BrowserOS!')
    expect(popupHtml).toContain('Take Survey')
    expect(popupHtml).toContain('jtbd-dont-show-again')
    const popupNoCheckboxHtml = render({
      showJtbdPopup: true,
      showDontShowAgain: false,
    })
    expect(popupNoCheckboxHtml).toContain('Take Survey')
    expect(popupNoCheckboxHtml).not.toContain('jtbd-dont-show-again')
  })
})
