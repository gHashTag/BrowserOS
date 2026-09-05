import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClawChatMessage } from './ClawChatMessage'
import type { ClawChatMessage as ClawChatMessageType } from './claw-chat-types'

function clawMessage(
  overrides: Partial<ClawChatMessageType> = {},
): ClawChatMessageType {
  return {
    id: 'msg-1',
    role: 'user',
    sessionKey: 'session-1',
    parts: [],
    ...overrides,
  }
}

function render(message: ClawChatMessageType): string {
  return renderToStaticMarkup(createElement(ClawChatMessage, { message }))
}

describe('ClawChatMessageTsxContract', () => {
  it('ClawChatMessage renders a finalized chat message from its parts', () => {
    // The message shell is shaped by the caller's role.
    const userHtml = render(
      clawMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Plain hello' }],
      }),
    )
    expect(userHtml).toContain('is-user')
    expect(userHtml).toContain('Plain hello')
    // The copy toolbar belongs to assistant messages only.
    expect(userHtml).not.toContain('Copy')

    const assistantHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Assistant answer' }],
      }),
    )
    expect(assistantHtml).toContain('is-assistant')
    expect(assistantHtml).toContain('Assistant answer')
    expect(assistantHtml).toContain('Copy')

    // An assistant message whose parts carry no text has nothing to copy.
    const metaOnlyHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [{ type: 'meta', label: 'Tokens', value: '42' }],
      }),
    )
    expect(metaOnlyHtml).not.toContain('Copy')
    // Meta parts render as a plain label/value line.
    expect(metaOnlyHtml).toContain('Tokens: 42')

    // The cost badge rounds cents normally and keeps sub-cent precision.
    const roundedHtml = render(
      clawMessage({
        role: 'assistant',
        costUsd: 0.1234,
        parts: [{ type: 'text', text: 'Costly answer' }],
      }),
    )
    expect(roundedHtml).toContain('$0.12')
    const subCentHtml = render(
      clawMessage({
        role: 'assistant',
        costUsd: 0.003,
        parts: [{ type: 'text', text: 'Cheap answer' }],
      }),
    )
    expect(subCentHtml).toContain('$0.0030')
    // A zero cost is treated as absent rather than printed.
    const zeroCostHtml = render(
      clawMessage({
        role: 'assistant',
        costUsd: 0,
        parts: [{ type: 'text', text: 'Free answer' }],
      }),
    )
    expect(zeroCostHtml).not.toContain('$')

    // Multiple text parts each render, in the order the parts appear.
    const multiTextHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [
          { type: 'text', text: 'First chunk' },
          { type: 'text', text: 'Second chunk' },
        ],
      }),
    )
    expect(multiTextHtml.indexOf('First chunk')).toBeLessThan(
      multiTextHtml.indexOf('Second chunk'),
    )

    // Reasoning collapses behind a trigger whose wording tracks the duration.
    const reasoningHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'secret deliberation', duration: 7 },
        ],
      }),
    )
    expect(reasoningHtml).toContain('Thought for 7 seconds')
    expect(reasoningHtml).not.toContain('secret deliberation')
    const untimedHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'untimed deliberation' }],
      }),
    )
    expect(untimedHtml).toContain('Thought for a few seconds')

    // Every tool call collapses into a single summary group that sits at
    // the position of the first call, whatever else appears between calls.
    const toolsHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Opening line' },
          {
            type: 'tool-call',
            name: 'browser_navigate',
            label: 'Opened page',
            subject: 'example.com',
            status: 'completed',
            durationMs: 1250,
          },
          { type: 'text', text: 'Middle line' },
          {
            type: 'tool-call',
            name: 'read_file',
            label: 'Read file',
            status: 'failed',
            error: 'ENOENT',
            durationMs: 300,
          },
          { type: 'text', text: 'Closing line' },
        ],
      }),
    )
    const activitySummaries = toolsHtml.match(/Agent activity \(/g) ?? []
    expect(activitySummaries.length).toBe(1)
    expect(toolsHtml).toContain('Agent activity (2 actions, 1 failed)')
    expect(toolsHtml.indexOf('Opening line')).toBeLessThan(
      toolsHtml.indexOf('Agent activity'),
    )
    expect(toolsHtml.indexOf('Agent activity')).toBeLessThan(
      toolsHtml.indexOf('Middle line'),
    )
    const singleToolHtml = render(
      clawMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            name: 'browser_navigate',
            label: 'Opened page',
            status: 'completed',
          },
        ],
      }),
    )
    expect(singleToolHtml).toContain('Agent activity (1 action)')

    // Attachments collapse into one strip at the first attachment's spot:
    // a later attachment joins the strip instead of opening a new one.
    const twoImagesHtml = render(
      clawMessage({
        role: 'user',
        parts: [
          {
            type: 'attachment',
            kind: 'image',
            mediaType: 'image/png',
            dataUrl: 'data:image/png;base64,QUJD',
            name: 'one.png',
          },
          { type: 'text', text: 'Between' },
          {
            type: 'attachment',
            kind: 'image',
            mediaType: 'image/jpeg',
            dataUrl: 'data:image/jpeg;base64,Qg',
            name: 'two.jpg',
          },
        ],
      }),
    )
    const imageTags = twoImagesHtml.match(/<img/g) ?? []
    expect(imageTags.length).toBe(2)
    expect(twoImagesHtml).toContain('src="data:image/png;base64,QUJD"')
    expect(twoImagesHtml).toContain('alt="one.png"')
    expect(twoImagesHtml.indexOf('two.jpg')).toBeLessThan(
      twoImagesHtml.indexOf('Between'),
    )
    // A non-image attachment renders no image element at all.
    const fileHtml = render(
      clawMessage({
        role: 'user',
        parts: [
          {
            type: 'attachment',
            kind: 'file',
            mediaType: 'text/plain',
            name: 'notes.txt',
          },
        ],
      }),
    )
    expect(fileHtml).not.toContain('<img')

    // A message with no parts still renders its shell.
    const emptyHtml = render(clawMessage({ role: 'assistant', parts: [] }))
    expect(emptyHtml).toContain('is-assistant')
    expect(emptyHtml).not.toContain('Copy')
  })
})
