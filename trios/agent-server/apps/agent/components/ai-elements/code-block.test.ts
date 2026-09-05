/**
 * Contract suite for the exports of code-block.tsx.
 *
 * The module exports exactly three symbols: `highlightCode`, `CodeBlock`
 * and `CodeBlockCopyButton`. Every assertion below drives one of those
 * exports and asserts on output that a consumer can observe - the HTML
 * shiki emits, the server-rendered markup of the components, and the
 * callbacks the copy button fires - so the suite pins behaviour rather
 * than the shape of the implementation.
 *
 * Export accounting (the module has 3 exports in total):
 *   - exercised by assertions below: 3 (`highlightCode`, `CodeBlock`,
 *     `CodeBlockCopyButton`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 3 + 0 = 3, matching the export count of the module.
 *
 * The only module-level mock is a transparent instrumentation of
 * `@/components/ui/button`: the real `Button` still renders (so markup
 * assertions hit the real surface), while its received props are kept
 * so a test can invoke the copy button's click handler. This suite
 * needs no network, no database and no container: shiki highlights from
 * its bundled grammars, and the clipboard is either absent (the honest
 * `bun test` environment) or an in-memory stub.
 *
 * Not pinned, and why: the flip from the copy icon to the check icon,
 * its reset after `timeout`, and the asynchronous fill of the light and
 * dark panes inside `CodeBlock` all require a client-side re-render
 * after a click or an effect - that is, a live DOM with the Clipboard
 * API. There is no DOM environment available to `bun test` in this
 * project (`@testing-library`, `happy-dom` and `jsdom` are all absent
 * from the lockfile), so only server-rendered output and the copy
 * handler's callback contract are pinned. Those are gaps in interaction
 * coverage, not exports left unexercised: each export is rendered or
 * invoked and asserted on above, so no export belongs in the blocked
 * list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { type ComponentProps, createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Button as ImportedButton } from '@/components/ui/button'

type ButtonProps = ComponentProps<typeof ImportedButton> & {
  onClick?: (event: unknown) => void | Promise<void>
}

// Captured before `mock.module` below: the import binding above is
// live, so reading it after the mock is installed would resolve to the
// mock itself and recurse forever.
const RealButton = ImportedButton

let lastButtonProps: ButtonProps | undefined

// A transparent wrapper: the real Button still renders (markup
// assertions hit the real surface) while its received props are kept
// so a test can invoke the copy button's click handler.
const InstrumentedButton = (props: ButtonProps) => {
  lastButtonProps = props
  return RealButton(props)
}

mock.module('@/components/ui/button', () => ({
  Button: InstrumentedButton,
}))

const { highlightCode, CodeBlock, CodeBlockCopyButton } = await import(
  './code-block'
)

const SAMPLE = 'const answer = 42\nconst twice = answer * 2'

describe('codeBlockTsxContract', () => {
  it('highlightCode returns distinct light and dark HTML for the same code, and numbers lines only when asked', async () => {
    const plain = await highlightCode(SAMPLE, 'ts', false)

    // The caller gets one pane per colour scheme, in that order.
    expect(plain).toHaveLength(2)
    const [light, dark] = plain
    expect(light).toContain('one-light')
    expect(dark).toContain('one-dark-pro')
    // Both panes carry the highlighted source, not a placeholder.
    expect(light).toContain('answer')
    expect(light).toContain('42')
    expect(dark).toContain('answer')
    // The colour schemes are genuinely different markup.
    expect(light).not.toBe(dark)
    // Line numbering is opt-in: absent by default...
    expect((light.match(/min-w-10/g) ?? []).length).toBe(0)
    expect((dark.match(/min-w-10/g) ?? []).length).toBe(0)

    // ...and when asked for, both panes number every line.
    const numbered = await highlightCode(SAMPLE, 'ts', true)
    const [numberedLight, numberedDark] = numbered
    expect((numberedLight.match(/min-w-10/g) ?? []).length).toBe(2)
    expect((numberedDark.match(/min-w-10/g) ?? []).length).toBe(2)
    expect(numberedLight).toContain('>1<')
  })

  it('CodeBlock server-renders a framed block with one light pane and one dark pane, spreading attributes, class names and children', () => {
    const html = renderToString(
      createElement(
        CodeBlock,
        {
          code: SAMPLE,
          language: 'ts',
          className: 'w-80',
          id: 'snippet',
        },
        createElement(CodeBlockCopyButton, { 'aria-label': 'Copy snippet' }),
      ),
    )

    // One bordered frame, widened by the caller's class name.
    expect(html).toContain('rounded-md')
    expect(html).toContain('border')
    expect(html).toContain('w-80')
    // Unknown container attributes pass through to the frame element.
    expect(html).toContain('id="snippet"')
    // Exactly one pane for light mode and one for dark mode.
    expect((html.match(/dark:hidden/g) ?? []).length).toBe(1)
    expect((html.match(/dark:block/g) ?? []).length).toBe(1)
    // Children render in the corner slot, wired to the block.
    expect(html).toContain('absolute top-2 right-2')
    expect(html).toContain('aria-label="Copy snippet"')
    // Highlighting happens client-side: the server output ships the
    // frame empty rather than blocking on shiki.
    expect(html).not.toContain('shiki')
  })

  it('CodeBlockCopyButton renders a ghost icon button and, on click, reports clipboard failures and copies the owning block\u2019s code', async () => {
    // Idle appearance: a compact ghost button showing the copy icon.
    lastButtonProps = undefined
    const idle = renderToString(
      createElement(CodeBlockCopyButton, { 'aria-label': 'Copy code' }),
    )
    expect(idle).toContain('data-variant="ghost"')
    expect(idle).toContain('data-size="icon"')
    expect(idle).toContain('<svg')
    expect(idle).toContain('aria-label="Copy code"')
    // Callers can replace the icon with their own children.
    const labelled = renderToString(
      createElement(CodeBlockCopyButton, {}, 'Copy!'),
    )
    expect(labelled).toContain('>Copy!<')
    expect(labelled).not.toContain('<svg')

    // In an environment with no clipboard at all - which is exactly
    // what `bun test` provides - a click must report the missing API
    // instead of pretending to copy.
    const errors: Error[] = []
    const copies: number[] = []
    renderToString(
      createElement(CodeBlockCopyButton, {
        onCopy: () => copies.push(1),
        onError: (error: Error) => errors.push(error),
      }),
    )
    await lastButtonProps?.onClick?.(undefined)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('Clipboard API not available')
    expect(copies).toHaveLength(0)

    // With a clipboard present, a click inside a block copies the
    // code that block provides, then reports success.
    const written: string[] = []
    const savedWindow = Reflect.getOwnPropertyDescriptor(globalThis, 'window')
    const savedClipboard = Reflect.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    )
    Reflect.set(globalThis, 'window', {})
    Reflect.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => written.push(text) },
      configurable: true,
    })
    try {
      const innerErrors: Error[] = []
      renderToString(
        createElement(
          CodeBlock,
          { code: 'const a = 1', language: 'ts' },
          createElement(CodeBlockCopyButton, {
            timeout: 5,
            onCopy: () => copies.push(2),
            onError: (error: Error) => innerErrors.push(error),
          }),
        ),
      )
      await lastButtonProps?.onClick?.(undefined)
      expect(written).toEqual(['const a = 1'])
      expect(copies).toEqual([2])
      expect(innerErrors).toHaveLength(0)
    } finally {
      if (savedClipboard) {
        Reflect.defineProperty(navigator, 'clipboard', savedClipboard)
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard
      }
      if (savedWindow) {
        Reflect.defineProperty(globalThis, 'window', savedWindow)
      } else {
        delete (globalThis as { window?: unknown }).window
      }
    }
  })
})
