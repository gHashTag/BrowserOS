/**
 * Contract suite for Features.tsx (gHashTag/trios#1507).
 *
 * Subject: Features.tsx, whose single exported symbol is FeaturesPage.
 * The suite renders that component to static markup with react-dom/server
 * and pins what an onboarding visitor can observe on first paint. No
 * network, database, or container is involved: the renderer runs fully
 * in-process.
 *
 * Behaviour that could not be pinned here, and the dependency that
 * blocked each part:
 *
 * - The "Start Using BrowserOS" click handler (chrome.runtime.getURL,
 *   chrome.tabs.query, chrome.tabs.create, chrome.tabs.remove) needs an
 *   interactive DOM that can dispatch click events plus a chrome
 *   extension API shim. This workspace declares no DOM test renderer
 *   among its dependencies (no happy-dom, jsdom, or @testing-library
 *   package), and adding one would require editing manifest files
 *   outside this suite's allowed path.
 *
 * - The bento feature cards render only after the component's mount
 *   effect raises its mounted state, and react-dom/server never executes
 *   effects. The post-mount card grid is therefore pinned only
 *   negatively: the assertions below show the grid absent from the
 *   initial markup.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BROWSER_OS_INTRO_VIDEO_URL } from '@/lib/constants/mediaUrls'
import {
  discordUrl,
  docsUrl,
  productRepositoryUrl,
  slackUrl,
} from '@/lib/constants/productUrls'
import { FeaturesPage } from './Features'

describe('FeaturesTsxContract', () => {
  it('FeaturesPage renders the onboarding feature tour as static markup', () => {
    // The module's public surface is the page component itself.
    expect(typeof FeaturesPage).toBe('function')

    const html = renderToStaticMarkup(createElement(FeaturesPage))

    // The hero welcomes the visitor and names the product.
    expect(html).toContain('WELCOME')
    expect(html).toContain('Why Switch to ')
    expect(html).toContain('BrowserOS?')
    expect(html).toContain('Scroll for Features')

    // The hero video plays the canonical launch video, muted and looping.
    expect(html).toContain(`src="${BROWSER_OS_INTRO_VIDEO_URL}"`)
    expect(html).toContain('autoPlay=""')
    expect(html).toContain('muted=""')
    expect(html).toContain('loop=""')

    // The features section advertises the tour below the hero.
    expect(html).toContain('FEATURES')
    expect(html).toContain('Explore What')
    expect(html).toContain('Possible')
    expect(html).toContain(
      'Skim the highlights below, then click any card to see a focused',
    )

    // The feature cards are gated behind the mount effect, so none of
    // them ship in the initial markup.
    expect(html).not.toContain('feature-card')
    expect(html).not.toContain('Built-in AI Agent')

    // The community section links out to the four canonical
    // destinations, each opening in its own tab.
    expect(html.match(/community-card/g)).toHaveLength(4)
    expect(html).toContain(`href="${discordUrl}"`)
    expect(html).toContain('Join Discord')
    expect(html).toContain(`href="${slackUrl}"`)
    expect(html).toContain('Join Slack')
    expect(html).toContain(`href="${productRepositoryUrl}"`)
    expect(html).toContain('Star our repository')
    expect(html).toContain(`href="${docsUrl}"`)
    expect(html).toContain('Documentation')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')

    // The page ends on a single call to action.
    expect(html.match(/<button /g)).toHaveLength(1)
    expect(html).toContain('Start Using BrowserOS')
  })
})
