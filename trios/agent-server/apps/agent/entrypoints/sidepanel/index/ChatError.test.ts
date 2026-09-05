/**
 * Contract suite for the exports of ChatError.tsx.
 *
 * The module exports exactly one symbol: `ChatError`, a presentational
 * component that turns a chat failure into the title, message, links and
 * retry affordance the user sees. Every assertion below renders that
 * export with `renderToString` and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ChatError`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * `ChatError` reads everything it renders from its props - it performs no
 * fetches, touches no storage and subscribes to nothing - so no export is
 * blocked by a live dependency, and the suite needs no network, no
 * database and no container.
 *
 * Not pinned, and why: dispatching a click on the rendered retry button.
 * There is no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only rendered output is asserted. That is a gap in
 * interaction coverage, not an export left unexercised: the export itself
 * is rendered and asserted on, so no export belongs in the blocked list
 * above.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { ChatError } from './ChatError'

type ChatErrorRenderProps = {
  error: Error
  onRetry?: () => void
  providerType?: string
}

const render = (props: ChatErrorRenderProps): string =>
  renderToString(createElement(ChatError, props))

// renderToString escapes the survey link query string, so its `&`
// separators appear as `&amp;` in the markup. The experiment direction is
// picked at random from these four fixed options on every render.
const surveyHrefPattern =
  /\/app\.html\?page=survey&amp;maxTurns=20&amp;experimentId=daily_limit_(competitor|switching|workflow|activation)#\/settings\/survey/

describe('ChatErrorTsxContract', () => {
  it('ChatError maps every error shape onto the title, message, links and retry button the user sees', () => {
    // A plain message with no provider and no retry handler: the generic
    // title and the raw message, with no link rows and no button at all.
    const generic = render({ error: new Error('Boom') })
    expect(generic).toContain('>Something went wrong</span>')
    expect(generic).toContain('>Boom</p>')
    expect(generic).not.toContain('Daily limit reached')
    expect(generic).not.toContain('Connection failed')
    expect(generic).not.toContain('View troubleshooting guide')
    expect(generic).not.toContain('Learn more')
    expect(generic).not.toContain('Try again')
    expect(generic).not.toContain('<button')

    // Both fetch-failure spellings map onto the connection block: the
    // connection title, the agent-server guidance message and a link to
    // the troubleshooting guide.
    for (const message of ['Failed to fetch', 'fetch failed']) {
      const html = render({
        error: new Error(message),
        providerType: 'browseros',
      })
      expect(html).toContain('>Connection failed</span>')
      expect(html).toContain(
        '>Unable to connect to BrowserOS agent. Follow below instructions.</p>',
      )
      expect(html).toContain(
        'href="https://docs.browseros.com/troubleshooting/connection-issues"',
      )
      expect(html).toContain('View troubleshooting guide')
      expect(html).not.toContain('Daily limit reached')
    }

    // Credits exhaustion, signalled by any of three gateway spellings on
    // the BrowserOS provider: the daily-limit title, the reset message and
    // the usage link - and no survey paragraph, which is reserved for
    // rate limits that credits did not cause.
    for (const message of [
      'CREDITS_EXHAUSTED',
      'Credits exhausted',
      'Daily credits exhausted',
    ]) {
      const html = render({
        error: new Error(message),
        providerType: 'browseros',
      })
      expect(html).toContain('>Daily limit reached</span>')
      expect(html).toContain(
        '>Daily credits exhausted. Credits reset at midnight UTC.</p>',
      )
      expect(html).toContain('href="/app.html#/settings/usage"')
      expect(html).toContain('View Usage &amp; Billing')
      expect(html).not.toContain('Learn more')
      expect(html).not.toContain('take a quick survey')
    }

    // The BrowserOS daily rate limit: the learn-more link plus a survey
    // link whose experiment direction is one of the four fixed options.
    const rateLimited = render({
      error: new Error('BrowserOS LLM daily limit reached'),
      providerType: 'browseros',
    })
    expect(rateLimited).toContain('>Daily limit reached</span>')
    expect(rateLimited).toContain(
      '>Add your own API key for unlimited usage.</p>',
    )
    expect(rateLimited).toContain('href="https://dub.sh/browseros-usage-limit"')
    expect(rateLimited).toContain('Learn more')
    expect(rateLimited).toContain('take a quick survey')
    expect(rateLimited).toMatch(surveyHrefPattern)
    expect(rateLimited).not.toContain('View Usage &amp; Billing')

    // The credits and rate-limit detections are gated on the BrowserOS
    // provider: the same gateway message from another provider keeps the
    // generic title and shows the raw message untouched.
    const ungated = render({
      error: new Error('CREDITS_EXHAUSTED'),
      providerType: 'openai',
    })
    expect(ungated).toContain('>Something went wrong</span>')
    expect(ungated).toContain('>CREDITS_EXHAUSTED</p>')
    expect(ungated).not.toContain('Daily limit reached')

    // A gateway error wrapped in a JSON envelope renders only the inner
    // message, never the envelope itself.
    const wrapped = render({
      error: new Error('{"error":{"message":"Gateway exploded"}}'),
    })
    expect(wrapped).toContain('>Gateway exploded</p>')
    expect(wrapped).not.toContain('&quot;error&quot;')

    // A URL inside a generic message is lifted out of the message body
    // and, because the row is generic, is rendered nowhere at all.
    const withUrl = render({
      error: new Error(
        'Payment required. Visit https://pay.example.com/topup to add credits',
      ),
    })
    expect(withUrl).toContain('>Payment required. Visit to add credits</p>')
    expect(withUrl).not.toContain('https://pay.example.com/topup')

    // A message that is nothing but a URL leaves empty text behind, which
    // falls back to the generic unexpected-error message.
    expect(render({ error: new Error('https://only.example.com') })).toContain(
      '>An unexpected error occurred</p>',
    )

    // A retry handler renders the try-again button; its absence was
    // asserted above on the generic render.
    const retrying = render({
      error: new Error('Boom'),
      onRetry: () => {},
    })
    expect(retrying).toContain('<button')
    expect(retrying).toContain('Try again</button>')
  })
})
