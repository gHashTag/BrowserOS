/**
 * Contract suite for the exports of BentoCard.tsx.
 *
 * The module exports exactly one symbol: `BentoCard`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`BentoCard`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * Nothing is stubbed. The component's only import with side effects is
 * the analytics reporter, and that swallows its own startup errors, so
 * the unmodified module renders under `renderToString` with no network,
 * no database and no container.
 *
 * Not pinned, and why: the detail dialog (the detailed description, the
 * highlight list, the video and GIF panes) and the analytics event the
 * component fires when that dialog opens are reachable only by clicking
 * the Radix trigger, which dispatches DOM events. There is no DOM
 * environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the closed-card markup is pinned. That is a gap in
 * interaction coverage, not an export left unexercised: the export
 * itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { Bot } from 'lucide-react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { BentoCard, type Feature } from './BentoCard'

const baseFeature: Feature = {
  id: 'feature-x',
  Icon: Bot,
  tag: 'Tag One',
  title: 'Title One',
  description: 'Desc one',
  detailedDescription: 'The long detailed story',
  highlights: ['First highlight', 'Second highlight'],
  gridClass: 'md:col-span-2',
}

const makeFeature = (overrides: Partial<Feature> = {}): Feature => ({
  ...baseFeature,
  ...overrides,
})

const renderCard = (props: {
  feature: Feature
  mounted: boolean
  index: number
}): string => renderToString(createElement(BentoCard, props))

describe('BentoCardTsxContract', () => {
  it('renders the feature summary - tag, title, description - plus an open-details affordance', () => {
    const html = renderCard({ feature: makeFeature(), mounted: true, index: 0 })

    expect(html).toContain('>Tag One<')
    expect(html).toContain('>Title One</h3>')
    expect(html).toContain('>Desc one</p>')
    expect(html).toContain('Open details')
  })

  it('draws the icon supplied by the feature on the card', () => {
    const html = renderCard({ feature: makeFeature(), mounted: true, index: 0 })

    // Two inline svgs live on the card: the feature's own icon in the
    // header and the arrow that trails "Open details". The icon class
    // names come from the Icon the feature passed in, so its presence
    // proves the card draws the feature's icon rather than a stand-in.
    expect((html.match(/<svg /g) ?? []).length).toBe(2)
    expect(html).toContain('lucide-bot')
  })

  it('places the card on the bento grid via the feature grid class', () => {
    const html = renderCard({
      feature: makeFeature({ gridClass: 'md:col-span-1' }),
      mounted: true,
      index: 0,
    })

    expect(html).toContain('md:col-span-1')
    expect(html).not.toContain('md:col-span-2')
  })

  it('shows a video-duration footnote only when the feature has one', () => {
    const withDuration = renderCard({
      feature: makeFeature({ videoDuration: '2:22' }),
      mounted: true,
      index: 0,
    })
    expect(withDuration).toContain('Video:')
    expect(withDuration).toContain('2:22')
    expect(withDuration).toContain('mins')

    const withoutDuration = renderCard({
      feature: makeFeature(),
      mounted: true,
      index: 0,
    })
    expect(withoutDuration).not.toContain('Video:')
    expect(withoutDuration).not.toContain('mins')
  })

  it('staggers the entrance animation by card index once mounted', () => {
    const first = renderCard({
      feature: makeFeature(),
      mounted: true,
      index: 0,
    })
    const sixth = renderCard({
      feature: makeFeature(),
      mounted: true,
      index: 5,
    })

    expect(first).toContain('animation:fadeInUp 0.6s ease-out 0s both')
    expect(sixth).toContain('animation:fadeInUp 0.6s ease-out 0.5s both')
  })

  it('keeps the entrance animation off while the card is not yet mounted', () => {
    const html = renderCard({
      feature: makeFeature(),
      mounted: false,
      index: 5,
    })

    expect(html).toContain('animation:none')
    expect(html).not.toContain('fadeInUp')
  })

  it('renders the card as a closed dialog trigger, keeping detail content out of the initial markup', () => {
    const html = renderCard({
      feature: makeFeature({ videoUrl: 'https://example.invalid/demo.mp4' }),
      mounted: true,
      index: 0,
    })

    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('data-state="closed"')
    // Nothing that lives behind the dialog leaks into the card the user
    // first sees.
    expect(html).not.toContain('The long detailed story')
    expect(html).not.toContain('First highlight')
    expect(html).not.toContain('example.invalid')
  })
})
