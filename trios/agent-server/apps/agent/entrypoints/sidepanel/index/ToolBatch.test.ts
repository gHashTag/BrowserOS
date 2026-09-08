/**
 * Contract suite for the exports of ToolBatch.tsx.
 *
 * The module exports exactly one symbol: `ToolBatch`. Every assertion
 * below renders that export with `renderToString` and asserts on the
 * markup it emits, so the suite pins observable behaviour rather than
 * the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ToolBatch`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component has no live dependency at all: icons, the collapsible
 * task primitives and the buttons are all pure render, and the message
 * segment types are imported as types only. No mock is needed, so this
 * suite requires no network, no database and no container.
 *
 * Not pinned, and why: behaviour that needs a second render pass or a
 * DOM event - the effect that keeps the batch open while streaming and
 * collapses it once streaming ends, the manual open/close toggle, and
 * the click wiring from the Approve/Deny buttons to the onApprove and
 * onDeny callbacks. There is no DOM environment available to `bun test`
 * in this project - `@testing-library`, `happy-dom` and `jsdom` are all
 * absent from the lockfile - and `renderToString` renders only the
 * first pass, so only the server-rendered output is pinned. That is a
 * gap in interaction coverage, not an export left unexercised: the
 * export itself is rendered and asserted on, so no export belongs in
 * the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { ToolInvocationInfo } from './getMessageSegments'
import { ToolBatch } from './ToolBatch'

const baseTool = (
  state: ToolInvocationInfo['state'],
  toolCallId: string,
  toolName: string,
  extra: Partial<ToolInvocationInfo> = {},
): ToolInvocationInfo => ({
  state,
  toolCallId,
  toolName,
  input: {},
  output: [],
  ...extra,
})

// Six tools covering every state family the component distinguishes:
// two completed flavours, an error, a denial, an in-flight call and a
// partial call that matches no special case.
const mixedBatch: ToolInvocationInfo[] = [
  baseTool('result', 'call-1', 'search_web'),
  baseTool('output-available', 'call-2', 'fetchPage'),
  baseTool('output-error', 'call-3', 'runCommand'),
  baseTool('output-denied', 'call-4', 'DeniedTool'),
  baseTool('call', 'call-5', 'readPage'),
  baseTool('partial-call', 'call-6', 'draftNote'),
]

// A batch awaiting a decision: one tool carries an approval id and so
// must grow buttons, the other is approval-requested without an id and
// must not.
const approvalBatch: ToolInvocationInfo[] = [
  baseTool('result', 'call-7', 'search_web'),
  baseTool('approval-requested', 'call-8', 'delete_file', {
    approval: { id: 'approval-42' },
  }),
  baseTool('approval-requested', 'call-9', 'grant_access'),
]

const render = (
  tools: ToolInvocationInfo[],
  flags: Partial<
    Record<'isLastBatch' | 'isLastMessage' | 'isStreaming', boolean>
  >,
): string =>
  renderToString(
    createElement(ToolBatch, {
      tools,
      isLastBatch: flags.isLastBatch ?? false,
      isLastMessage: flags.isLastMessage ?? false,
      isStreaming: flags.isStreaming ?? false,
    }),
  )

const countOf = (html: string, needle: string): number => {
  let total = 0
  let at = html.indexOf(needle)
  while (at !== -1) {
    total += 1
    at = html.indexOf(needle, at + needle.length)
  }
  return total
}

describe('ToolBatchTsxContract', () => {
  it('renders the ToolBatch export: batch summary, open/closed state, per-state rows and approval controls', () => {
    // --- A batch that is done and is not the last message stays
    // collapsed: only the summary trigger is rendered, and the row
    // markup is absent entirely.
    const htmlFinished = render(mixedBatch, {})
    expect(htmlFinished).toContain('2/6 actions completed')
    expect(htmlFinished).toContain('aria-expanded="false"')
    expect(htmlFinished).not.toContain('>Search web<')
    expect(htmlFinished).not.toContain('>Read Page<')

    // --- The last batch of the streaming message is expanded so the
    // user can watch progress live; every tool gets one row.
    const htmlStreaming = render(mixedBatch, {
      isLastBatch: true,
      isLastMessage: true,
      isStreaming: true,
    })
    expect(htmlStreaming).toContain('2/6 actions completed')
    expect(htmlStreaming).toContain('aria-expanded="true"')
    expect(htmlStreaming).toContain('>Search web<')
    expect(htmlStreaming).toContain('>Fetch Page<')
    expect(htmlStreaming).toContain('>Run Command<')
    expect(htmlStreaming).toContain('>Denied Tool<')
    expect(htmlStreaming).toContain('>Read Page<')
    expect(htmlStreaming).toContain('>Draft Note<')

    // Tool names are humanised: underscores become spaces, camelCase
    // gets a space before each capital, and the first letter is
    // capitalised.
    expect(htmlStreaming).not.toContain('search_web')
    expect(htmlStreaming).not.toContain('fetchPage')

    // Each state family renders its own status icon next to the name.
    expect(
      countOf(htmlStreaming, 'lucide-circle-check h-3.5 w-3.5 text-green-500'),
    ).toBe(2)
    expect(
      countOf(htmlStreaming, 'lucide-circle-x h-3.5 w-3.5 text-destructive'),
    ).toBe(1)
    expect(
      countOf(htmlStreaming, 'lucide-shield-x h-3.5 w-3.5 text-red-400'),
    ).toBe(1)
    expect(
      countOf(htmlStreaming, 'lucide-loader-circle h-3.5 w-3.5 animate-spin'),
    ).toBe(1)
    expect(
      countOf(
        htmlStreaming,
        'lucide-circle-dashed h-3.5 w-3.5 text-muted-foreground',
      ),
    ).toBe(1)

    // --- Once streaming has ended, the last batch collapses again
    // even though it is still the last message.
    const htmlSettled = render(mixedBatch, {
      isLastBatch: true,
      isLastMessage: true,
      isStreaming: false,
    })
    expect(htmlSettled).toContain('aria-expanded="false"')
    expect(htmlSettled).not.toContain('>Read Page<')

    // --- A batch with a pending approval is expanded regardless of
    // the message flags, says so in the summary, and offers exactly
    // one Approve/Deny pair - only for the tool that carries an
    // approval id.
    const htmlApproval = render(approvalBatch, {})
    expect(htmlApproval).toContain('Waiting for approval...')
    expect(htmlApproval).toContain('aria-expanded="true"')
    expect(countOf(htmlApproval, '>Approve<')).toBe(1)
    expect(countOf(htmlApproval, '>Deny<')).toBe(1)
    expect(htmlApproval).toContain('>Delete file<')
    expect(htmlApproval).toContain('>Grant access<')
    expect(
      countOf(htmlApproval, 'lucide-clock h-3.5 w-3.5 text-yellow-500'),
    ).toBe(2)
  })
})
