/**
 * First contract suite for `open-in-chat.tsx`.
 *
 * Coverage accounting: the module exports twelve symbols
 * (OpenIn, OpenInContent, OpenInItem, OpenInLabel, OpenInSeparator,
 * OpenInTrigger, OpenInChatGPT, OpenInClaude, OpenInT3, OpenInScira,
 * OpenInv0, OpenInCursor) and every one of them is exercised by an
 * assertion below, one block per export, each titled with the symbol it
 * covers. Nothing was left out for needing a live dependency, so there is
 * no dependency-blocked export to list in this comment.
 *
 * Rendering seam: the assertions read the rendered markup through
 * `renderToStaticMarkup`, which needs no DOM, network, database or
 * container. Radix's portal component mounts its children into
 * `document.body` from a layout effect that never fires in a static
 * render, so the menu surface would be invisible to this suite. The
 * portal module is therefore substituted with a passthrough that renders
 * its children in place; every other dependency - the Radix menu
 * primitives, the ui wrappers, the icons, `cn` - runs for real. The
 * subject file itself is untouched.
 *
 * `defaultOpen` is passed through `OpenIn`'s public props in every
 * composition because Radix gates the menu surface's presence on the open
 * state; it is the public way to make the content observable in static
 * markup and no behaviour is changed by it.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement as h, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@radix-ui/react-portal', () => {
  const passthrough = ({ children }: { children?: ReactElement | null }) =>
    children ?? null
  return { Portal: passthrough, Root: passthrough }
})

const mod = await import('./open-in-chat')

const QUERY = 'hello world & more'
const ENCODED_QUERY = 'hello+world+%26+more'

/**
 * Render one menu composition and hand back its static markup.
 * `contentClassName` and `trigger` let a test customise those slots.
 */
const renderMenu = (
  item: ReactElement,
  contentClassName?: string,
  trigger?: ReactElement,
) =>
  renderToStaticMarkup(
    h(
      mod.OpenIn,
      { defaultOpen: true, query: QUERY },
      trigger ?? h(mod.OpenInTrigger),
      h(mod.OpenInContent, { className: contentClassName }, item),
    ),
  ).replaceAll('&amp;', '&')

const hrefIn = (markup: string) =>
  markup.match(/href="([^"]*)"/)?.[1] ?? '(no href rendered)'

const textOf = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('openInChatTsxContract', () => {
  it('OpenIn supplies the query its provider items link with, and provider items refuse to render outside one', () => {
    const markup = renderMenu(h(mod.OpenInScira))

    expect(hrefIn(markup)).toBe(`https://scira.ai/?q=${ENCODED_QUERY}`)

    expect(() => renderToStaticMarkup(h(mod.OpenInScira))).toThrow(
      'OpenIn components must be used within an OpenIn provider',
    )
  })

  it('OpenInContent aligns the menu to the start edge at a 240px default width that a custom width overrides', () => {
    const defaultMarkup = renderMenu(h(mod.OpenInItem, null, 'an item'))

    expect(defaultMarkup).toContain('role="menu"')
    expect(defaultMarkup).toContain('data-align="start"')
    expect(defaultMarkup).toContain('w-[240px]')

    const customMarkup = renderMenu(
      h(mod.OpenInItem, null, 'an item'),
      'w-[360px]',
    )

    expect(customMarkup).toContain('w-[360px]')
    expect(customMarkup).not.toContain('w-[240px]')
  })

  it('OpenInItem renders its children as a menu item and marks itself disabled when asked', () => {
    const enabled = renderMenu(h(mod.OpenInItem, null, 'pick me'))

    expect(enabled).toContain('role="menuitem"')
    expect(textOf(enabled)).toContain('pick me')

    const disabled = renderMenu(
      h(mod.OpenInItem, { disabled: true }, 'pick me'),
    )

    expect(disabled).toContain('aria-disabled="true"')
    expect(disabled).toContain('data-disabled=""')
  })

  it('OpenInLabel renders its children as a label that is not a menu item', () => {
    const markup = renderMenu(h(mod.OpenInLabel, null, 'DESTINATIONS'))

    expect(textOf(markup)).toContain('DESTINATIONS')
    expect(markup).not.toContain('role="menuitem"')
  })

  it('OpenInSeparator renders a horizontal separator between menu sections', () => {
    const withoutSeparator = renderMenu(h(mod.OpenInItem, null, 'an item'))

    expect(withoutSeparator).not.toContain('role="separator"')

    const withSeparator = renderMenu(
      h(
        'div',
        null,
        h(mod.OpenInItem, null, 'above'),
        h(mod.OpenInSeparator),
        h(mod.OpenInItem, null, 'below'),
      ),
    )

    expect(withSeparator).toContain('role="separator"')
    expect(withSeparator).toContain('aria-orientation="horizontal"')
    expect(textOf(withSeparator)).toContain('above')
    expect(textOf(withSeparator)).toContain('below')
  })

  it('OpenInTrigger shows a default "Open in chat" button, or the caller\'s children when supplied', () => {
    const withDefault = renderMenu(h(mod.OpenInItem, null, 'an item'))

    expect(withDefault).toContain('>Open in chat<')
    expect(withDefault).toContain('type="button"')
    expect(withDefault).toContain('lucide-chevron-down')
    expect(withDefault).toContain('aria-haspopup="menu"')

    const withCustom = renderMenu(
      h(mod.OpenInItem, null, 'an item'),
      undefined,
      h(mod.OpenInTrigger, null, h('span', null, 'MY OWN TRIGGER')),
    )

    expect(textOf(withCustom)).toContain('MY OWN TRIGGER')
    expect(withCustom).not.toContain('Open in chat')
    expect(withCustom).toContain('aria-haspopup="menu"')
  })

  it('OpenInChatGPT links to ChatGPT with the query as a search prompt, opening a new tab', () => {
    const markup = renderMenu(h(mod.OpenInChatGPT))

    expect(hrefIn(markup)).toBe(
      `https://chatgpt.com/?hints=search&prompt=${ENCODED_QUERY}`,
    )
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener"')
    expect(textOf(markup)).toContain('Open in ChatGPT')
  })

  it('OpenInClaude links to Claude with the query, opening a new tab', () => {
    const markup = renderMenu(h(mod.OpenInClaude))

    expect(hrefIn(markup)).toBe(`https://claude.ai/new?q=${ENCODED_QUERY}`)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener"')
    expect(textOf(markup)).toContain('Open in Claude')
  })

  it('OpenInT3 links to T3 Chat with the query, opening a new tab', () => {
    const markup = renderMenu(h(mod.OpenInT3))

    expect(hrefIn(markup)).toBe(`https://t3.chat/new?q=${ENCODED_QUERY}`)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener"')
    expect(textOf(markup)).toContain('Open in T3 Chat')
  })

  it('OpenInScira links to Scira with the query, opening a new tab', () => {
    const markup = renderMenu(h(mod.OpenInScira))

    expect(hrefIn(markup)).toBe(`https://scira.ai/?q=${ENCODED_QUERY}`)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener"')
    expect(textOf(markup)).toContain('Open in Scira')
  })

  it('OpenInv0 links to v0 with the query, opening a new tab', () => {
    const markup = renderMenu(h(mod.OpenInv0))

    expect(hrefIn(markup)).toBe(`https://v0.app?q=${ENCODED_QUERY}`)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener"')
    expect(textOf(markup)).toContain('Open in v0')
  })

  it('OpenInCursor links to Cursor with the query as prompt text, opening a new tab', () => {
    const markup = renderMenu(h(mod.OpenInCursor))

    expect(hrefIn(markup)).toBe(
      `https://cursor.com/link/prompt?text=${ENCODED_QUERY}`,
    )
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener"')
    expect(textOf(markup)).toContain('Open in Cursor')
  })
})
