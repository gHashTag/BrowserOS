/**
 * Contract suite for `web-preview.tsx`.
 *
 * The module is a React client-component family for the web preview panel.
 * This suite pins the behaviour that already exists, using
 * `renderToStaticMarkup` from `react-dom/server`: no DOM, no network, no
 * database, no container. Each test is named after the exported symbol it
 * covers, so a reader can map assertions to exports one-for-one.
 *
 * Not pinned, and why: the interaction-level behaviour — committing a typed
 * URL on Enter (`WebPreviewUrl` calling the context `setUrl` and the
 * `onUrlChange` callback of `WebPreview`), opening the console panel
 * (`WebPreviewConsole` toggling via its trigger), and button click handling
 * (`WebPreviewNavigationButton` invoking `onClick`) — needs a live DOM event
 * environment to exercise. No DOM test runtime (jsdom, happy-dom) is a
 * dependency of this workspace, and installing one is outside this suite's
 * file boundary, so those paths are pinned only as far as static rendering
 * shows them: the collapsed-by-default console, the initial url state, and
 * the disabled affordance. Every exported symbol is still exercised by at
 * least one assertion below; nothing is silently omitted.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewConsole,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from './web-preview'

const CONTEXT_URL = 'https://context-url.test'
const EXPLICIT_URL = 'https://explicit-url.test'

/** Renders one element tree to static markup, the way the suite observes it. */
function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element)
}

describe('webPreviewTsxContract', () => {
  it('WebPreview renders its children and supplies defaultUrl to descendants', () => {
    const markup = render(
      React.createElement(
        WebPreview,
        { defaultUrl: CONTEXT_URL },
        'marker-child',
        React.createElement(WebPreviewBody),
      ),
    )
    expect(markup).toContain('marker-child')
    // The child body must receive the url from the provider context.
    expect(markup).toContain('<iframe')
    expect(markup).toContain(`src="${CONTEXT_URL}"`)
  })

  it('WebPreviewNavigation renders its children in order', () => {
    const markup = render(
      React.createElement(
        WebPreviewNavigation,
        null,
        'first-navigation-child',
        'second-navigation-child',
      ),
    )
    expect(markup).toContain('first-navigation-child')
    expect(markup).toContain('second-navigation-child')
    expect(markup.indexOf('first-navigation-child')).toBeLessThan(
      markup.indexOf('second-navigation-child'),
    )
  })

  it('WebPreviewNavigationButton renders its label and forwards disabled', () => {
    const enabled = render(
      React.createElement(
        WebPreviewNavigationButton,
        { tooltip: 'Go back' },
        'GO-BACK-LABEL',
      ),
    )
    const disabled = render(
      React.createElement(
        WebPreviewNavigationButton,
        { disabled: true, tooltip: 'Reload' },
        'RELOAD-LABEL',
      ),
    )
    expect(enabled).toContain('GO-BACK-LABEL')
    expect(enabled).toContain('<button')
    expect(enabled).not.toContain('disabled=""')
    expect(disabled).toContain('RELOAD-LABEL')
    expect(disabled).toContain('disabled=""')
  })

  it('WebPreviewUrl starts from the context url and lets an explicit value win', () => {
    const fromContext = render(
      React.createElement(
        WebPreview,
        { defaultUrl: CONTEXT_URL },
        React.createElement(WebPreviewUrl),
      ),
    )
    expect(fromContext).toContain('placeholder="Enter URL..."')
    expect(fromContext).toContain(`value="${CONTEXT_URL}"`)

    const overridden = render(
      React.createElement(
        WebPreview,
        { defaultUrl: CONTEXT_URL },
        React.createElement(WebPreviewUrl, { value: EXPLICIT_URL }),
      ),
    )
    expect(overridden).toContain(`value="${EXPLICIT_URL}"`)
    expect(overridden).not.toContain(`value="${CONTEXT_URL}"`)
  })

  it('WebPreviewBody resolves iframe src as own prop first, then context, else omits it', () => {
    const fromContext = render(
      React.createElement(
        WebPreview,
        { defaultUrl: CONTEXT_URL },
        React.createElement(WebPreviewBody),
      ),
    )
    expect(fromContext).toContain(`src="${CONTEXT_URL}"`)

    const withOwnSrc = render(
      React.createElement(
        WebPreview,
        { defaultUrl: CONTEXT_URL },
        React.createElement(WebPreviewBody, { src: EXPLICIT_URL }),
      ),
    )
    expect(withOwnSrc).toContain(`src="${EXPLICIT_URL}"`)
    expect(withOwnSrc).not.toContain(`src="${CONTEXT_URL}"`)

    const empty = render(
      React.createElement(
        WebPreview,
        null,
        React.createElement(WebPreviewBody, {
          loading: React.createElement('p', null, 'loading-sentinel'),
        }),
      ),
    )
    expect(empty).toContain('<iframe')
    expect(empty).not.toContain('src=')
    expect(empty).toContain('loading-sentinel')
    // The preview iframe is always sandboxed with the module's allowlist.
    expect(empty).toContain(
      'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"',
    )
  })

  it('WebPreviewConsole renders a collapsed trigger and hides log entries until opened', () => {
    const markup = render(
      React.createElement(
        WebPreview,
        null,
        React.createElement(WebPreviewConsole, {
          logs: [
            {
              level: 'error',
              message: 'boom-log-message',
              timestamp: new Date('2025-01-02T03:04:05Z'),
            },
          ],
        }),
      ),
    )
    expect(markup).toContain('Console')
    // The console starts collapsed: the trigger reports not expanded...
    expect(markup).toContain('aria-expanded="false"')
    // ...and the log payload is not rendered into the closed panel.
    expect(markup).not.toContain('boom-log-message')
  })
})
