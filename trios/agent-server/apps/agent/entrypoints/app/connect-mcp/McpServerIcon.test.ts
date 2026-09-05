/**
 * Contract suite for the exports of McpServerIcon.tsx.
 *
 * The module exports exactly one symbol: `McpServerIcon`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`McpServerIcon`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component is a pure render: a server name is looked up in a static
 * map of bundled logo assets, and the result is either an `<img>` carrying
 * that asset or the generic lucide `Server` glyph. Neither branch needs a
 * browser, a backend or any other live dependency, so the whole suite runs
 * under `bun test` with no network, no database and no container.
 *
 * Not pinned: the map holds 45 entries and only representative keys are
 * asserted below (a plain key, one whose asset is shared by a sibling key,
 * and one whose asset file differs from the key's name). Enumerating every
 * key would duplicate the map rather than pin the export's behaviour, so
 * the two render branches are what this suite locks down.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import calcomSvg from '@/assets/mcp-icons/cal_com.svg'
import googleSvg from '@/assets/mcp-icons/google.svg'
import outlookSvg from '@/assets/mcp-icons/outlook.svg'
import slackSvg from '@/assets/mcp-icons/slack.svg'
import { McpServerIcon } from './McpServerIcon'

const render = (props: {
  serverName: string
  size?: number
  className?: string
}): string => renderToString(createElement(McpServerIcon, props))

describe('McpServerIconTsxContract', () => {
  it('McpServerIcon renders the bundled logo for a mapped server name and the generic Server glyph otherwise', () => {
    // Mapped name: an <img> pointing at that name's bundled asset, with
    // the name as alt text and the default size of 20. (React 19's
    // server renderer prepends a preload <link> for the src, so presence
    // of the element is asserted rather than its position in the string.)
    const slackHtml = render({ serverName: 'Slack' })
    expect(slackHtml).toContain('<img ')
    expect(slackHtml).toContain(`src="${slackSvg}"`)
    expect(slackHtml).toContain('alt="Slack"')
    expect(slackHtml).toContain('width="20"')
    expect(slackHtml).toContain('height="20"')
    expect(slackHtml).toContain('rounded-md')

    // A custom size and className are honoured on the same branch, with
    // the rounding class kept and the custom class appended after it.
    const calcomHtml = render({
      serverName: 'Cal.com',
      size: 16,
      className: 'mt-1 inline',
    })
    expect(calcomHtml).toContain(`src="${calcomSvg}"`)
    expect(calcomHtml).toContain('width="16"')
    expect(calcomHtml).toContain('height="16"')
    expect(calcomHtml).toContain('class="rounded-md mt-1 inline"')

    // 'Google Sheets' is served the plain Google mark, not the Drive one.
    expect(render({ serverName: 'Google Sheets' })).toContain(
      `src="${googleSvg}"`,
    )

    // Two Outlook keys share a single bundled asset.
    expect(render({ serverName: 'Outlook Mail' })).toContain(
      `src="${outlookSvg}"`,
    )
    expect(render({ serverName: 'Outlook Calendar' })).toContain(
      `src="${outlookSvg}"`,
    )

    // Unmapped name: the generic lucide Server glyph, with the size and
    // className carried over to it, and no <img> at all.
    const fallbackHtml = render({
      serverName: 'NotAMappedService',
      size: 32,
      className: 'text-red-500',
    })
    expect(fallbackHtml.startsWith('<svg ')).toBe(true)
    expect(fallbackHtml).not.toContain('<img ')
    expect(fallbackHtml).toContain('class="lucide lucide-server text-red-500"')
    expect(fallbackHtml).toContain('width="32"')
    expect(fallbackHtml).toContain('height="32"')

    // The fallback branch also defaults to size 20 when none is passed.
    expect(render({ serverName: 'AlsoNotMapped' })).toContain('width="20"')
  })
})
