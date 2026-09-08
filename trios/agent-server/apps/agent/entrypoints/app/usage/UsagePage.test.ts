/**
 * Contract suite for the exports of UsagePage.tsx.
 *
 * The module exports exactly one symbol: `UsagePage`. The single test below
 * renders that export through every branch of its state machine (loading,
 * error, settled) and asserts on the markup it emits, so the suite pins
 * observable behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`UsagePage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the agent server that
 * `@/lib/credits/useCredits` fetches from over HTTP. The hook is swapped for
 * an in-memory stub via `mock.module`, so this suite needs no network, no
 * database and no container.
 *
 * Not pinned, and why: following the "Add Provider" anchor to
 * /app.html#/settings/ai is a navigation, and interactions of that kind need
 * a DOM environment that `bun test` does not provide in this project
 * (`@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile), so only the rendered output is pinned - the anchor's destination
 * is asserted as markup. That is a gap in interaction coverage, not an export
 * left unexercised: the export itself is rendered and asserted on, so no
 * export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { CreditsInfo } from '@/lib/credits/useCredits'

type UseCreditsResult = {
  data: CreditsInfo | undefined
  isLoading: boolean
  error: Error | null
}

let hookResult: UseCreditsResult

mock.module('@/lib/credits/useCredits', () => ({
  useCredits: () => hookResult,
}))

const { UsagePage } = await import('./UsagePage')

const render = (result: UseCreditsResult): string => {
  hookResult = result
  return renderToString(createElement(UsagePage))
}

const quiet = { isLoading: false, error: null }

describe('UsagePageTsxContract', () => {
  it('UsagePage renders the loading, error and settled faces of the usage screen', () => {
    // Loading: a bare placeholder - no header, no numbers, no upsell.
    const loading = render({ ...quiet, data: undefined, isLoading: true })
    expect(loading).toContain('Loading usage data...')
    expect(loading).not.toContain('Usage &amp; Billing')
    expect(loading).not.toContain('Daily Credits')
    expect(loading).not.toContain('Add Provider')

    // Error: the header survives, the numbers do not.
    const errored = render({
      ...quiet,
      data: undefined,
      error: new Error('agent server unreachable'),
    })
    expect(errored).toContain('Usage &amp; Billing')
    expect(errored).toContain('Monitor your BrowserOS AI credit usage')
    expect(errored).toContain('Unable to load credit information')
    expect(errored).not.toContain('Daily Credits')
    expect(errored).not.toContain('Add Provider')
    expect(errored).not.toContain('Loading usage data...')

    // Settled, healthy band (above the low threshold of 30 credits): a green
    // gauge, numbers straight from the hook, and both upsell cards.
    const healthy = render({
      ...quiet,
      data: { credits: 40, dailyLimit: 100 },
    })
    expect(healthy).toContain('Usage &amp; Billing')
    expect(healthy).toContain('Monitor your BrowserOS AI credit usage')
    expect(healthy).toContain('Daily Credits')
    expect(healthy).toContain('>40<span')
    expect(healthy).toContain('/ <!-- -->100')
    expect(healthy).toContain('text-green-500')
    expect(healthy).toContain('bg-green-500')
    expect(healthy).toContain('style="width:40%"')
    expect(healthy).toContain('60<!-- --> of <!-- -->100')
    expect(healthy).toContain('Credits used today')
    expect(healthy).toContain('Resets daily')
    expect(healthy).toContain('Midnight UTC')
    expect(healthy).toContain('Need more credits?')
    expect(healthy).toContain('Coming soon')
    expect(healthy).toContain(
      'Additional credit packages will be available soon',
    )
    expect(healthy).toContain('Want unlimited usage?')
    expect(healthy).toContain('Add your own LLM provider — no credit limits')
    expect(healthy).toContain('href="/app.html#/settings/ai"')
    expect(healthy).toContain('>Add Provider</a>')

    // Settled, low band (at or below 30 credits): the gauge turns yellow.
    const low = render({ ...quiet, data: { credits: 25, dailyLimit: 100 } })
    expect(low).toContain('text-yellow-500')
    expect(low).toContain('bg-yellow-500')
    expect(low).toContain('style="width:25%"')

    // No data at all: the documented fallbacks (0 of a 100-credit day) and a
    // red, empty gauge.
    const empty = render({ ...quiet, data: undefined })
    expect(empty).toContain('>0<span')
    expect(empty).toContain('/ <!-- -->100')
    expect(empty).toContain('text-red-500')
    expect(empty).toContain('bg-red-500')
    expect(empty).toContain('style="width:0%"')
    expect(empty).toContain('100<!-- --> of <!-- -->100')

    // Over the daily limit: the bar is clamped at full width, and the used
    // arithmetic goes negative - the behaviour as it stands today.
    const over = render({ ...quiet, data: { credits: 150, dailyLimit: 100 } })
    expect(over).toContain('>150<span')
    expect(over).toContain('style="width:100%"')
    expect(over).toContain('-50<!-- --> of <!-- -->100')

    // A non-default daily limit flows through every number on the page.
    const custom = render({
      ...quiet,
      data: { credits: 10, dailyLimit: 50 },
    })
    expect(custom).toContain('/ <!-- -->50')
    expect(custom).toContain('style="width:20%"')
    expect(custom).toContain('40<!-- --> of <!-- -->50')
  })
})
