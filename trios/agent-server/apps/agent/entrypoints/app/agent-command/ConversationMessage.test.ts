/**
 * Contract suite for the exports of ConversationMessage.tsx.
 *
 * The module exports exactly one symbol: `ConversationMessage`. Every
 * assertion below renders that export and asserts on the markup it
 * emits, so the suite pins observable behaviour rather than the shape
 * of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ConversationMessage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the agent server that the
 * file-preview hooks under the produced-files strip fetch from over
 * HTTP. Those fetches are dispatched from React effects, which never
 * execute while rendering to static markup, and the react-query
 * client supplied below starts with no base URL recorded, so every
 * query it would issue is disabled from the first render. The client
 * is supplied at all only because the preview hook reads it from
 * context during render - that is a context requirement, not a live
 * dependency. This suite therefore needs no network, no database and
 * no container.
 *
 * Not pinned, and why: click interactions (the produced-files strip's
 * View and "+N" buttons calling back into `onOpenOutputsRail`, card
 * clicks opening the preview Sheet) dispatch DOM events. There is no
 * DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the component's rendered output is pinned. That
 * is a gap in interaction coverage, not an export left unexercised:
 * the export itself is rendered and asserted on, so no export belongs
 * in the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AgentConversationTurn,
  AssistantPart,
  ConversationTurnFile,
  ToolEntry,
} from '@/lib/agent-conversations/types'
import { ConversationMessage } from './ConversationMessage'

type ConversationMessageProps = ComponentProps<typeof ConversationMessage>

const tool = (
  overrides: Partial<ToolEntry> & Pick<ToolEntry, 'id' | 'label'>,
): ToolEntry => ({
  name: `tool-${overrides.id}`,
  status: 'completed',
  ...overrides,
})

const turn = (
  overrides: Partial<AgentConversationTurn> = {},
): AgentConversationTurn => ({
  id: 'turn-1',
  turnId: 'server-turn-1',
  userText: 'Summarise the workspace notes',
  parts: [],
  done: true,
  timestamp: 1_757_000_000_000,
  ...overrides,
})

const produced = (name: string): ConversationTurnFile => ({
  id: `file-${name}`,
  path: `/workspace/out/${name}`,
  size: 2048,
  mtimeMs: 1_757_000_000_000,
})

const renderMessage = (props: ConversationMessageProps): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ConversationMessage, props),
    ),
  )

const firstIndexOf = (html: string, needle: string): number =>
  html.indexOf(needle)

describe('ConversationMessageTsxContract', () => {
  it('ConversationMessage renders a turn as the user sees it: their text and attachments, the thought, the reply, one aggregated task, the produced files and the waiting dots', () => {
    // --- A turn still in flight: thought open, tools aggregated, dots off.
    const runningParts: AssistantPart[] = [
      {
        kind: 'thinking',
        text: 'Reading the workspace first.',
        done: false,
      },
      { kind: 'text', text: 'Summary so far.' },
      {
        kind: 'tool-batch',
        tools: [
          tool({
            id: 't1',
            label: 'Read file',
            subject: 'notes.md',
            status: 'running',
            durationMs: 1500,
          }),
        ],
      },
      { kind: 'text', text: 'Writing the summary now.' },
      {
        kind: 'tool-batch',
        tools: [
          tool({
            id: 't2',
            label: 'Write file',
            subject: 'summary.md',
            status: 'completed',
            durationMs: 1200,
          }),
        ],
      },
    ]
    const runningHtml = renderMessage({
      turn: turn({ done: false, parts: runningParts }),
      streaming: true,
    })

    // The user's own words are echoed back.
    expect(runningHtml).toContain('Summarise the workspace notes')
    // A thought that is still streaming renders open, with its text.
    expect(runningHtml).toContain('Reading the workspace first.')
    expect(runningHtml).toContain('Thinking')
    // Both assistant text parts render, and the reading order is the
    // part order: thought, first text, tools, second text.
    expect(runningHtml).toContain('Summary so far.')
    expect(runningHtml).toContain('Writing the summary now.')
    expect(
      firstIndexOf(runningHtml, 'Reading the workspace first.'),
    ).toBeLessThan(firstIndexOf(runningHtml, 'Summary so far.'))
    expect(firstIndexOf(runningHtml, 'Summary so far.')).toBeLessThan(
      firstIndexOf(runningHtml, 'Agent activity'),
    )
    // Both tool batches collapse into ONE task whose title counts all
    // tools and says work is ongoing while any tool still runs.
    expect(runningHtml).toContain('Working… (2 actions)')
    expect(runningHtml).not.toContain('Agent activity')
    expect(runningHtml.match(/Working… \(2 actions\)/g)).toHaveLength(1)
    // The task items render in arrival order with subject and duration.
    expect(runningHtml).toContain('Read file')
    expect(runningHtml).toContain('· notes.md')
    expect(runningHtml).toContain('Write file')
    expect(runningHtml).toContain('· summary.md')
    expect(runningHtml).toContain('1.5s')
    expect(runningHtml).toContain('1.2s')
    expect(firstIndexOf(runningHtml, 'Read file')).toBeLessThan(
      firstIndexOf(runningHtml, 'Write file'),
    )
    // Once parts have arrived the waiting dots are gone.
    expect(runningHtml).not.toContain('animate-bounce')

    // --- The same turn finished: thought collapses, title turns
    // --- completed and singular, durations stay.
    const finishedHtml = renderMessage({
      turn: turn({
        parts: [
          { kind: 'thinking', text: 'Finished deliberation.', done: true },
          {
            kind: 'tool-batch',
            tools: [
              tool({ id: 't1', label: 'Solo step', status: 'completed' }),
            ],
          },
        ],
      }),
      streaming: false,
    })
    expect(finishedHtml).toContain('Agent activity (1 action)')
    expect(finishedHtml).not.toContain('Working…')
    // A finished thought renders collapsed: the summary label shows
    // and the thought text itself is no longer on the page.
    expect(finishedHtml).toContain('Thought for a few seconds')
    expect(finishedHtml).not.toContain('Finished deliberation.')
    // A tool without a recorded duration renders no duration column.
    expect(finishedHtml).toContain('Solo step')
    expect(finishedHtml).not.toContain('NaN')

    // --- Attachments the user staged render as image previews.
    const attachmentHtml = renderMessage({
      turn: turn({
        userText: 'Look at this',
        userAttachments: [
          {
            id: 'att-1',
            kind: 'image',
            mediaType: 'image/png',
            name: 'shot.png',
            dataUrl: 'data:image/png;base64,QUJD',
          },
        ],
      }),
      streaming: false,
    })
    expect(attachmentHtml).toContain('Look at this')
    expect(attachmentHtml).toContain('alt="shot.png"')
    expect(attachmentHtml).toContain('src="data:image/png;base64,QUJD"')

    // --- Produced files: full mode appends the strip, in path order,
    // --- with the overflow folded into a "+N" button.
    const overflowFiles = [
      produced('z-file.md'),
      produced('a-file.md'),
      produced('b-file.md'),
      produced('c-file.md'),
      produced('y-file.md'),
      produced('d-file.md'),
    ]
    const filesHtml = renderMessage({
      turn: turn({ producedFiles: overflowFiles }),
      streaming: false,
    })
    expect(filesHtml).toContain('Summarise the workspace notes')
    expect(filesHtml).toContain('Files produced (6)')
    // Sorted by path: a-file leads even though z-file arrived first.
    expect(filesHtml).toContain('a-file.md')
    expect(filesHtml).toContain('z-file.md')
    expect(firstIndexOf(filesHtml, 'a-file.md')).toBeLessThan(
      firstIndexOf(filesHtml, 'b-file.md'),
    )
    expect(firstIndexOf(filesHtml, 'z-file.md')).toBeGreaterThan(
      firstIndexOf(filesHtml, 'c-file.md'),
    )
    // Only the first four sorted files get cards; the last two fold
    // into the overflow button.
    expect(filesHtml).toContain('+2')
    expect(filesHtml).not.toContain('y-file.md')
    expect(filesHtml).not.toContain('d-file.md')

    // A single produced file uses the singular heading.
    const oneFileHtml = renderMessage({
      turn: turn({ producedFiles: [produced('only.md')] }),
      streaming: false,
    })
    expect(oneFileHtml).toContain('File produced')
    expect(oneFileHtml).toContain('only.md')

    // --- Strip-only mode renders just the files affordance.
    const stripHtml = renderMessage({
      turn: turn({
        userText: 'Please make the files',
        parts: [{ kind: 'text', text: 'Made them.' }],
        producedFiles: [produced('zeta.md'), produced('alpha.md')],
      }),
      streaming: false,
      stripOnly: true,
    })
    expect(stripHtml).toContain('Files produced (2)')
    expect(stripHtml).toContain('alpha.md')
    expect(stripHtml).toContain('zeta.md')
    expect(firstIndexOf(stripHtml, 'alpha.md')).toBeLessThan(
      firstIndexOf(stripHtml, 'zeta.md'),
    )
    // The user text and assistant text live elsewhere in this mode.
    expect(stripHtml).not.toContain('Please make the files')
    expect(stripHtml).not.toContain('Made them.')

    // Strip-only mode with nothing produced renders nothing at all.
    expect(
      renderMessage({ turn: turn(), streaming: false, stripOnly: true }),
    ).toBe('')

    // --- Waiting state: a fresh, partless turn shows the typing dots
    // --- only while streaming, and no assistant block exists yet.
    const waitingHtml = renderMessage({
      turn: turn({ done: false }),
      streaming: true,
    })
    expect(waitingHtml).toContain('animate-bounce')
    expect(waitingHtml).toContain('Summarise the workspace notes')
    expect(waitingHtml).not.toContain('is-assistant')
    const pausedHtml = renderMessage({
      turn: turn({ done: false }),
      streaming: false,
    })
    expect(pausedHtml).not.toContain('animate-bounce')
    const doneWaitingHtml = renderMessage({
      turn: turn({ done: true }),
      streaming: true,
    })
    expect(doneWaitingHtml).not.toContain('animate-bounce')
    expect(doneWaitingHtml).not.toContain('is-assistant')
  })
})
