import { describe, expect, it } from 'bun:test'
import { buildToolLabel } from '../../src/tools/tool-label-registry'

/**
 * Pins the contract of the tool label registry as it stands today.
 *
 * The chat activity view renders one line per tool call, and this module is
 * the entire editorial layer between a snake_case identifier and something a
 * person can read. Until now nothing in the test corpus exercised any export
 * of it, so a careless edit to the override table or the extractors would
 * have shipped silently. This suite is the first to pin that behaviour.
 *
 * Export ledger (runtime symbols: 1 exercised + 0 blocked = 1):
 *
 *  - buildToolLabel — exercised throughout this suite. It is a pure function
 *    of its arguments, so every branch below runs with no network, database
 *    or container.
 *  - ToolLabelResult is a type-only export (an interface); it has no runtime
 *    presence and is covered by the values buildToolLabel returns.
 *
 * No export was left untested, so there is nothing to list as blocked by a
 * live dependency.
 */
describe('toolLabelRegistryContract', () => {
  // ── buildToolLabel: curated verbs ──────────────────────────────────────

  describe('buildToolLabel maps curated tool names to their verb', () => {
    it('labels navigate_page with the curated verb and no subject when no input is given', () => {
      const result = buildToolLabel('navigate_page')
      expect(result.label).toBe('Navigated to')
      expect(result.subject).toBeUndefined()
    })

    it('labels take_screenshot, a tool with a verb but no extractor', () => {
      const result = buildToolLabel('take_screenshot')
      expect(result.label).toBe('Took screenshot')
      expect(result.subject).toBeUndefined()
    })
  })

  // ── buildToolLabel: namespace prefixes ─────────────────────────────────

  describe('buildToolLabel strips MCP namespace prefixes before lookup', () => {
    it('reads a browseros__ prefix through to the curated verb and extractor', () => {
      const result = buildToolLabel('browseros__new_page', {
        url: 'https://example.com/docs/getting-started',
      })
      expect(result.label).toBe('Opened tab')
      expect(result.subject).toBe('example.com/docs/getting-started')
    })

    it('reads an mcp_ prefix through to the curated verb and extractor', () => {
      const result = buildToolLabel('mcp_click', { element: '17' })
      expect(result.label).toBe('Clicked')
      expect(result.subject).toBe('17')
    })
  })

  // ── buildToolLabel: fallback humanization ──────────────────────────────

  describe('buildToolLabel humanizes unknown names as a fallback', () => {
    it('sentence-cases a snake_case name no override covers', () => {
      const result = buildToolLabel('resize_browser_window')
      expect(result.label).toBe('Resize browser window')
      expect(result.subject).toBeUndefined()
    })

    it('treats hyphens as word separators too', () => {
      expect(buildToolLabel('pin-note').label).toBe('Pin note')
    })

    it('strips the namespace prefix before humanizing an unknown name', () => {
      expect(buildToolLabel('browseros__totally_unknown').label).toBe(
        'Totally unknown',
      )
    })

    it('returns a name made only of separators unchanged', () => {
      expect(buildToolLabel('___').label).toBe('___')
    })

    it('derives no subject for an unknown tool even when input carries one', () => {
      const result = buildToolLabel('unknown_thing', {
        url: 'https://example.com',
      })
      expect(result.label).toBe('Unknown thing')
      expect(result.subject).toBeUndefined()
    })
  })

  // ── buildToolLabel: URL subjects ───────────────────────────────────────

  describe('buildToolLabel formats URL subjects for display', () => {
    it('shows host and path without the scheme', () => {
      const result = buildToolLabel('web_fetch', {
        url: 'https://example.com/docs/getting-started',
      })
      expect(result.label).toBe('Fetched URL')
      expect(result.subject).toBe('example.com/docs/getting-started')
    })

    it('drops a bare root path', () => {
      expect(
        buildToolLabel('new_page', { url: 'https://example.com/' }).subject,
      ).toBe('example.com')
    })

    it('drops the query string, keeping only the path', () => {
      expect(
        buildToolLabel('new_page', { url: 'https://example.com/search?q=bee' })
          .subject,
      ).toBe('example.com/search')
    })

    it('passes a value that is not a URL through as-is', () => {
      expect(buildToolLabel('new_page', { url: 'not-a-url' }).subject).toBe(
        'not-a-url',
      )
    })

    it('truncates a host-plus-path longer than 60 characters to 59 plus an ellipsis', () => {
      const url = `https://${'a'.repeat(50)}.com/${'b'.repeat(40)}`
      const result = buildToolLabel('new_page', { url })
      expect(result.subject).toBe(`${'a'.repeat(50)}.com/${'b'.repeat(4)}…`)
      expect(result.subject?.length).toBe(60)
    })
  })

  // ── buildToolLabel: navigate_page actions ──────────────────────────────

  describe('buildToolLabel names navigation back, forward and reload', () => {
    it.each([
      'back',
      'forward',
      'reload',
    ] as const)('uses the action word %s as the subject', (action) => {
      const result = buildToolLabel('navigate_page', { action })
      expect(result.label).toBe('Navigated to')
      expect(result.subject).toBe(action)
    })

    it('falls back to the URL when the action is anything else', () => {
      const result = buildToolLabel('navigate_page', {
        action: 'url',
        url: 'https://example.com',
      })
      expect(result.subject).toBe('example.com')
    })
  })

  // ── buildToolLabel: quoted query subjects ──────────────────────────────

  describe('buildToolLabel quotes search queries', () => {
    it('wraps a query in typographic quotes', () => {
      const result = buildToolLabel('web_search', {
        query: 'how bees navigate',
      })
      expect(result.label).toBe('Searched the web')
      expect(result.subject).toBe('"how bees navigate"')
    })

    it('falls back to the q key when query is absent', () => {
      expect(buildToolLabel('web_search', { q: 'pollination' }).subject).toBe(
        '"pollination"',
      )
    })

    it('skips an empty first key and takes the fallback', () => {
      expect(
        buildToolLabel('web_search', { query: '', q: 'fallback wins' }).subject,
      ).toBe('"fallback wins"')
    })
  })

  // ── buildToolLabel: element and keyboard subjects ──────────────────────

  describe('buildToolLabel names the element or key an input acted on', () => {
    it('joins fill target and text with a colon', () => {
      const result = buildToolLabel('fill', {
        element: '9',
        text: 'hello world',
      })
      expect(result.label).toBe('Filled field')
      expect(result.subject).toBe('9: hello world')
    })

    it('truncates fill text to 39 characters plus an ellipsis', () => {
      const result = buildToolLabel('fill', { text: 'x'.repeat(45) })
      expect(result.subject).toBe(`${'x'.repeat(39)}…`)
    })

    it('derives no subject from a non-string element id', () => {
      const result = buildToolLabel('click', { element: 17 })
      expect(result.label).toBe('Clicked')
      expect(result.subject).toBeUndefined()
    })

    it('names the key press_key pressed', () => {
      expect(buildToolLabel('press_key', { key: 'Meta+Shift+P' }).subject).toBe(
        'Meta+Shift+P',
      )
    })
  })

  // ── buildToolLabel: coordinate subjects ────────────────────────────────

  describe('buildToolLabel reports coordinates as rounded integers', () => {
    it('rounds x and y for click_at', () => {
      const result = buildToolLabel('click_at', { x: 10.4, y: 20.6 })
      expect(result.label).toBe('Clicked at coordinates')
      expect(result.subject).toBe('10, 21')
    })

    it('derives no subject when only one coordinate is present', () => {
      expect(buildToolLabel('click_at', { x: 5 }).subject).toBeUndefined()
    })

    it('joins drag start and end with an arrow', () => {
      const result = buildToolLabel('drag_at', {
        fromX: 1.2,
        fromY: 2.7,
        toX: 3.1,
        toY: 4.9,
      })
      expect(result.subject).toBe('1, 3 → 3, 5')
    })
  })

  // ── buildToolLabel: tab subjects ───────────────────────────────────────

  describe('buildToolLabel names the tab a tab operation touched', () => {
    it('prefixes a numeric page id with "tab"', () => {
      const result = buildToolLabel('close_page', { page: 7 })
      expect(result.label).toBe('Closed tab')
      expect(result.subject).toBe('tab 7')
    })

    it('uses a string page name as-is', () => {
      expect(buildToolLabel('move_page', { page: 'first' }).subject).toBe(
        'first',
      )
    })
  })

  // ── buildToolLabel: external action, filesystem, memory, bookmarks ─────

  describe('buildToolLabel names subjects from the remaining extractors', () => {
    it('joins an external action server and action with a middle dot', () => {
      const result = buildToolLabel('execute_action', {
        server_name: 'slack',
        action_name: 'send_message',
      })
      expect(result.label).toBe('Ran external action')
      expect(result.subject).toBe('slack · send_message')
    })

    it('uses the action alone when no server is named', () => {
      expect(
        buildToolLabel('execute_action', { action_name: 'send_message' })
          .subject,
      ).toBe('send_message')
    })

    it('reduces a file path to its basename', () => {
      const result = buildToolLabel('read_file', {
        path: '/workspace/project/README.md',
      })
      expect(result.label).toBe('Read file')
      expect(result.subject).toBe('README.md')
    })

    it('handles a Windows-style path separator', () => {
      expect(
        buildToolLabel('write_file', { path: 'C:\\Users\\bee\\notes.md' })
          .subject,
      ).toBe('notes.md')
    })

    it('shows the first characters of a memory write', () => {
      const result = buildToolLabel('update_core', {
        content: 'the user prefers plain text summaries',
      })
      expect(result.label).toBe('Updated core memory')
      expect(result.subject).toBe('the user prefers plain text summaries')
    })

    it('prefers a bookmark title over its URL', () => {
      expect(buildToolLabel('create_bookmark', { title: 'Docs' }).subject).toBe(
        'Docs',
      )
    })

    it('falls back to the bookmark URL host when no title is given', () => {
      expect(
        buildToolLabel('create_bookmark', { url: 'https://docs.example.com' })
          .subject,
      ).toBe('docs.example.com')
    })

    it('formats the URL of a deleted history entry', () => {
      const result = buildToolLabel('delete_history_url', {
        url: 'https://news.example/story',
      })
      expect(result.label).toBe('Deleted history entry')
      expect(result.subject).toBe('news.example/story')
    })
  })

  // ── buildToolLabel: deliberately absent subjects ───────────────────────

  describe('buildToolLabel omits subjects it decides not to show', () => {
    // Page-read tools (take_snapshot and friends) take only a numeric page
    // id that is internal to the agent; the module's own comment calls
    // "tab 4" meaningless to the user. The verb alone is the contract.
    it('omits a subject for take_snapshot even when a page id is passed', () => {
      const result = buildToolLabel('take_snapshot', { page: 3 })
      expect(result.label).toBe('Captured page snapshot')
      expect(result.subject).toBeUndefined()
    })

    it('omits a subject when a tool with an extractor is called with no input', () => {
      const result = buildToolLabel('web_search')
      expect(result.label).toBe('Searched the web')
      expect(result.subject).toBeUndefined()
    })
  })
})
