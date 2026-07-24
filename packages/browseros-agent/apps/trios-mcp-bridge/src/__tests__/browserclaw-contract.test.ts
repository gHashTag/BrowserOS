import { describe, expect, test } from 'bun:test'
import {
  parseBrowserPages,
  resolveBrowserToolContract,
} from '../clients/browseros-client.js'
import { DEFAULT_CONFIG } from '../config.js'

describe('BrowserClaw bridge contract', () => {
  test('keeps BrowserClaw and the TRIOS bridge on separate ports', () => {
    expect(DEFAULT_CONFIG.port).toBe(9203)
    expect(DEFAULT_CONFIG.browserosMcpUrl).toBe('http://127.0.0.1:9105/mcp')
  })

  test('detects the current BrowserClaw tool catalog', () => {
    expect(resolveBrowserToolContract(['tabs', 'screenshot', 'snapshot'])).toBe(
      'browserclaw',
    )
    expect(resolveBrowserToolContract(['list_pages', 'take_screenshot'])).toBe(
      'legacy',
    )
  })

  test('parses current and legacy page listings', () => {
    expect(
      parseBrowserPages(
        '[17] https://example.com (Example page)\n[18] https://empty.test',
      ),
    ).toEqual([
      { id: 17, url: 'https://example.com', title: 'Example page' },
      { id: 18, url: 'https://empty.test', title: '' },
    ])
    expect(
      parseBrowserPages('[7] GitButler https://gitbutler.com/app'),
    ).toEqual([{ id: 7, url: 'https://gitbutler.com/app', title: 'GitButler' }])
  })
})
