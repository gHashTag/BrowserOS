/**
 * Pins the current behaviour of src/browser/snapshot.ts.
 *
 * Until this file existed, none of that module's four exports was named by
 * any test in the repository: the accessibility-tree renderers that every
 * "take a snapshot" tool call depends on were green only in the sense that
 * nothing looked at them. This suite does not redesign anything - it pins
 * the behaviour that already exists so the next change to snapshot.ts has
 * something to fail against.
 *
 * Coverage map - every export is exercised, none is blocked:
 *
 *   buildInteractiveTree          pure function over AX nodes  -> fixtures below
 *   buildEnhancedTree             pure function over AX nodes  -> fixtures below
 *   findCursorInteractiveElements CDP session is a parameter   -> scripted session below
 *   extractLinkNodes              pure function over AX nodes  -> fixtures below
 *
 * Exercised: 4, blocked by a live dependency: 0, total exports: 4.
 *
 * findCursorInteractiveElements is the one export that talks to a browser,
 * but the session it needs arrives as an argument - that parameter is the
 * module's own seam, so the page side is scripted here and the suite needs
 * no browser, no network, no database and no container. What is NOT pinned
 * is the embedded page script itself (which elements a real DOM reports as
 * cursor-interactive): observing that requires a live page, and it is not
 * observable through the session parameter. The mapping from a found
 * element to its backend node, the dropping of unresolvable elements, and
 * the empty-page cases are observable here and are pinned.
 */

import { describe, expect, it } from 'bun:test'
import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import {
  type AXNode,
  buildEnhancedTree,
  buildInteractiveTree,
  extractLinkNodes,
  findCursorInteractiveElements,
} from '../../src/browser/snapshot'

/**
 * A page with one of everything the renderers have opinions about:
 *
 *   RootWebArea "Example page"
 *   └─ main
 *      ├─ heading "Sign in" (level 2)           [10]
 *      │  └─ StaticText "Sign in"
 *      ├─ link "Home"                           [20]
 *      ├─ textbox "Email", value "a@b.c"        [30]
 *      ├─ checkbox "Remember me" (checked)      [40]
 *      ├─ button "Submit" (disabled)            [50]
 *      ├─ button "Ghost"                        (no backend id)
 *      ├─ ignored wrapper
 *      │  └─ link "Hidden link"                 [60]
 *      ├─ presentation wrapper
 *      │  └─ link "Wrapped link"                [70]
 *      ├─ checkbox "Maybe" (mixed), value "on"  [45]
 *      ├─ link "No id link"                     (no backend id)
 *      ├─ link with a numeric name              [80]
 *      └─ button "Menu" (collapsed, required)   [90]
 */
const PAGE: AXNode[] = [
  {
    nodeId: 'root',
    role: { type: 'internalRole', value: 'RootWebArea' },
    name: { type: 'string', value: 'Example page' },
    childIds: ['main'],
  },
  {
    nodeId: 'main',
    role: { type: 'internalRole', value: 'main' },
    childIds: [
      'heading',
      'home-link',
      'email',
      'remember',
      'submit',
      'ghost',
      'ignored-wrap',
      'presentation-wrap',
      'maybe',
      'no-id-link',
      'numeric-name-link',
      'menu',
    ],
  },
  {
    nodeId: 'heading',
    role: { type: 'internalRole', value: 'heading' },
    name: { type: 'string', value: 'Sign in' },
    backendDOMNodeId: 10,
    properties: [{ name: 'level', value: { type: 'integer', value: 2 } }],
    childIds: ['heading-text'],
  },
  {
    nodeId: 'heading-text',
    role: { type: 'internalRole', value: 'StaticText' },
    name: { type: 'string', value: 'Sign in' },
  },
  {
    nodeId: 'home-link',
    role: { type: 'role', value: 'link' },
    name: { type: 'string', value: 'Home' },
    backendDOMNodeId: 20,
  },
  {
    nodeId: 'email',
    role: { type: 'role', value: 'textbox' },
    name: { type: 'string', value: 'Email' },
    value: { type: 'string', value: 'a@b.c' },
    backendDOMNodeId: 30,
  },
  {
    nodeId: 'remember',
    role: { type: 'role', value: 'checkbox' },
    name: { type: 'string', value: 'Remember me' },
    backendDOMNodeId: 40,
    properties: [{ name: 'checked', value: { type: 'boolean', value: true } }],
  },
  {
    nodeId: 'submit',
    role: { type: 'role', value: 'button' },
    name: { type: 'string', value: 'Submit' },
    backendDOMNodeId: 50,
    properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }],
  },
  {
    // Interactive, but no backendDOMNodeId: named in the enhanced tree,
    // absent from the interactive tree and from the link list.
    nodeId: 'ghost',
    role: { type: 'role', value: 'button' },
    name: { type: 'string', value: 'Ghost' },
  },
  {
    // Ignored nodes are transparent: their own role is dropped, children kept.
    nodeId: 'ignored-wrap',
    ignored: true,
    childIds: ['hidden-link'],
  },
  {
    nodeId: 'hidden-link',
    role: { type: 'role', value: 'link' },
    name: { type: 'string', value: 'Hidden link' },
    backendDOMNodeId: 60,
  },
  {
    // Presentation wrappers are transparent too.
    nodeId: 'presentation-wrap',
    role: { type: 'internalRole', value: 'presentation' },
    childIds: ['wrapped-link'],
  },
  {
    nodeId: 'wrapped-link',
    role: { type: 'role', value: 'link' },
    name: { type: 'string', value: 'Wrapped link' },
    backendDOMNodeId: 70,
  },
  {
    // A checkbox holds its state as a property; its value attribute ("on")
    // is not rendered - only text-entry roles show a value.
    nodeId: 'maybe',
    role: { type: 'role', value: 'checkbox' },
    name: { type: 'string', value: 'Maybe' },
    value: { type: 'string', value: 'on' },
    backendDOMNodeId: 45,
    properties: [
      { name: 'checked', value: { type: 'tristate', value: 'mixed' } },
    ],
  },
  {
    nodeId: 'no-id-link',
    role: { type: 'role', value: 'link' },
    name: { type: 'string', value: 'No id link' },
  },
  {
    // A name that is not a string renders as no name at all.
    nodeId: 'numeric-name-link',
    role: { type: 'role', value: 'link' },
    name: { type: 'integer', value: 42 },
    backendDOMNodeId: 80,
  },
  {
    nodeId: 'menu',
    role: { type: 'role', value: 'button' },
    name: { type: 'string', value: 'Menu' },
    backendDOMNodeId: 90,
    properties: [
      { name: 'expanded', value: { type: 'boolean', value: false } },
      { name: 'required', value: { type: 'boolean', value: true } },
    ],
  },
]

/**
 * A tree with no RootWebArea and no WebArea: the renderers fall back to the
 * children of the first node. The dangling child id has no node - walking it
 * must be a no-op, not a crash.
 */
const ORPHAN_TREE: AXNode[] = [
  {
    nodeId: 'body',
    role: { type: 'internalRole', value: 'generic' },
    childIds: ['fallback-button', 'fallback-link', 'dangling'],
  },
  {
    nodeId: 'fallback-button',
    role: { type: 'role', value: 'button' },
    name: { type: 'string', value: 'Fallback button' },
    backendDOMNodeId: 1,
  },
  {
    nodeId: 'fallback-link',
    role: { type: 'role', value: 'link' },
    name: { type: 'string', value: 'Fallback link' },
    backendDOMNodeId: 2,
  },
]

/** A page with nothing interactive on it. */
const PROSE_ONLY: AXNode[] = [
  {
    nodeId: 'root',
    role: { type: 'internalRole', value: 'WebArea' },
    childIds: ['para'],
  },
  {
    nodeId: 'para',
    role: { type: 'internalRole', value: 'paragraph' },
    childIds: ['para-text'],
  },
  {
    nodeId: 'para-text',
    role: { type: 'internalRole', value: 'StaticText' },
    name: { type: 'string', value: 'Just words' },
  },
]

/**
 * A scripted stand-in for the Chrome DevTools Protocol session that
 * findCursorInteractiveElements takes as its only argument.
 *
 * Runtime.evaluate answers from a queue: the first call is the page scan,
 * whose by-value result is the marker list the embedded page script would
 * have returned; every later call is a marker lookup, answered from
 * `lookups` in call order (an entry without an objectId is a marker the
 * page can no longer resolve). DOM.describeNode answers from
 * `backendNodeIds`, or throws for the object ids named in
 * `describeThrowsFor` - the two ways a live page can fail to describe a
 * node. Nothing here matches on the subject's script text: responses are
 * driven by the call sequence, so the assertions stay on the returned
 * value and not on how the subject talks to the session.
 */
function scriptedCdpSession(page: {
  scanResult?: Array<{ marker: string; text: string; reasons: string[] }>
  lookups: Array<{ objectId?: string }>
  backendNodeIds: Record<string, number>
  describeThrowsFor?: string[]
}): ProtocolApi {
  let evaluateCalls = 0
  const session = {
    Runtime: {
      evaluate: async () => {
        evaluateCalls += 1
        if (evaluateCalls === 1) {
          return { result: { value: page.scanResult } }
        }
        const lookup = page.lookups[evaluateCalls - 2] ?? {}
        return lookup.objectId
          ? { result: { objectId: lookup.objectId } }
          : { result: {} }
      },
    },
    DOM: {
      describeNode: async (args: { objectId: string }) => {
        if (page.describeThrowsFor?.includes(args.objectId)) {
          throw new Error(`describeNode failed for ${args.objectId}`)
        }
        return { node: { backendNodeId: page.backendNodeIds[args.objectId] } }
      },
    },
  }
  return session as unknown as ProtocolApi
}

describe('snapshotContract', () => {
  describe('buildInteractiveTree', () => {
    it('lists every interactive element that has a backend id, as "[id] role", walking through wrappers', () => {
      expect(buildInteractiveTree(PAGE)).toEqual([
        '[20] link "Home"',
        '[30] textbox "Email" value="a@b.c"',
        '[40] checkbox "Remember me" (checked)',
        '[50] button "Submit" (disabled)',
        '[60] link "Hidden link"',
        '[70] link "Wrapped link"',
        '[45] checkbox "Maybe" (indeterminate)',
        '[80] link',
        '[90] button "Menu" (collapsed, required)',
      ])
    })

    it('omits interactive elements without a backend id and non-interactive content entirely', () => {
      const lines = buildInteractiveTree(PAGE)
      expect(lines).not.toContain('button "Ghost"')
      expect(lines).not.toContain('heading')
      expect(lines.some((line) => line.includes('Sign in'))).toBe(false)
      expect(lines.some((line) => line.includes('main'))).toBe(false)
    })

    it('shows a value only for text-entry roles, and no name when the name is not a string', () => {
      const lines = buildInteractiveTree(PAGE)
      expect(lines).toContain('[45] checkbox "Maybe" (indeterminate)')
      expect(lines.some((line) => line.includes('value="on"'))).toBe(false)
      expect(lines).toContain('[80] link')
      expect(lines.some((line) => line.includes('42'))).toBe(false)
    })

    it('walks the children of the first node when no RootWebArea or WebArea exists, and skips dangling child ids without crashing', () => {
      expect(buildInteractiveTree(ORPHAN_TREE)).toEqual([
        '[1] button "Fallback button"',
        '[2] link "Fallback link"',
      ])
    })

    it('returns an empty list for a page with nothing interactive on it', () => {
      expect(buildInteractiveTree(PROSE_ONLY)).toEqual([])
    })

    it('returns an empty list for an empty tree', () => {
      expect(buildInteractiveTree([])).toEqual([])
    })
  })

  describe('buildEnhancedTree', () => {
    it('indents by depth and marks interactive or named elements with their backend id, others with a dash', () => {
      expect(buildEnhancedTree(PAGE)).toEqual([
        '- main',
        '  [10] heading "Sign in" (level=2)',
        '    - StaticText "Sign in"',
        '  [20] link "Home"',
        '  [30] textbox "Email" value="a@b.c"',
        '  [40] checkbox "Remember me" (checked)',
        '  [50] button "Submit" (disabled)',
        '  - button "Ghost"',
        '  [60] link "Hidden link"',
        '  [70] link "Wrapped link"',
        '  [45] checkbox "Maybe" (indeterminate)',
        '  - link "No id link"',
        '  [80] link',
        '  [90] button "Menu" (collapsed, required)',
      ])
    })

    it("keeps ignored and presentation wrappers out of the output without changing their children's depth", () => {
      const lines = buildEnhancedTree(PAGE)
      // The links under the ignored and presentation wrappers sit at the same
      // depth as their siblings, at two spaces, not pushed down by a wrapper
      // line that does not exist.
      expect(lines).toContain('  [60] link "Hidden link"')
      expect(lines).toContain('  [70] link "Wrapped link"')
      expect(lines.some((line) => line.includes('presentation'))).toBe(false)
    })

    it('renders a named heading with a backend id, and plain content without one', () => {
      expect(buildEnhancedTree(PROSE_ONLY)).toEqual([
        '- paragraph',
        '  - StaticText "Just words"',
      ])
    })

    it('walks the children of the first node when no root role exists, and does not list that node itself', () => {
      const lines = buildEnhancedTree(ORPHAN_TREE)
      expect(lines).toEqual([
        '[1] button "Fallback button"',
        '[2] link "Fallback link"',
      ])
      expect(lines.some((line) => line.includes('generic'))).toBe(false)
    })

    it('returns an empty list for an empty tree', () => {
      expect(buildEnhancedTree([])).toEqual([])
    })
  })

  describe('findCursorInteractiveElements', () => {
    it('maps each element the page reports to the backend node its lookup resolves to, keeping its text and reasons', async () => {
      const session = scriptedCdpSession({
        scanResult: [
          { marker: '0', text: 'Alpha', reasons: ['cursor:pointer'] },
          { marker: '4', text: 'Beta beta', reasons: ['onclick', 'tabindex'] },
        ],
        lookups: [{ objectId: 'obj-0' }, { objectId: 'obj-4' }],
        backendNodeIds: { 'obj-0': 101, 'obj-4': 204 },
      })

      await expect(findCursorInteractiveElements(session)).resolves.toEqual([
        {
          backendNodeId: 101,
          text: 'Alpha',
          reasons: ['cursor:pointer'],
        },
        {
          backendNodeId: 204,
          text: 'Beta beta',
          reasons: ['onclick', 'tabindex'],
        },
      ])
    })

    it('drops an element whose lookup finds no object, and one that describes to no backend node', async () => {
      const session = scriptedCdpSession({
        scanResult: [
          { marker: '0', text: 'Alpha', reasons: ['cursor:pointer'] },
          { marker: '1', text: 'Beta', reasons: ['tabindex'] },
          { marker: '2', text: 'Gamma', reasons: ['onclick'] },
        ],
        lookups: [{}, { objectId: 'obj-1' }, { objectId: 'obj-2' }],
        // obj-2 describes to a node with no backendNodeId.
        backendNodeIds: { 'obj-1': 7 },
      })

      await expect(findCursorInteractiveElements(session)).resolves.toEqual([
        { backendNodeId: 7, text: 'Beta', reasons: ['tabindex'] },
      ])
    })

    it('drops an element whose node description fails mid-list and keeps the rest', async () => {
      const session = scriptedCdpSession({
        scanResult: [
          { marker: '0', text: 'Alpha', reasons: ['cursor:pointer'] },
          { marker: '1', text: 'Beta', reasons: ['onclick'] },
        ],
        lookups: [{ objectId: 'obj-0' }, { objectId: 'obj-1' }],
        backendNodeIds: { 'obj-0': 11, 'obj-1': 22 },
        describeThrowsFor: ['obj-0'],
      })

      await expect(findCursorInteractiveElements(session)).resolves.toEqual([
        { backendNodeId: 22, text: 'Beta', reasons: ['onclick'] },
      ])
    })

    it('returns an empty list when the page reports nothing, or reports no value at all', async () => {
      const empty = scriptedCdpSession({
        scanResult: [],
        lookups: [],
        backendNodeIds: {},
      })
      await expect(findCursorInteractiveElements(empty)).resolves.toEqual([])

      const silent = scriptedCdpSession({
        lookups: [],
        backendNodeIds: {},
      })
      await expect(findCursorInteractiveElements(silent)).resolves.toEqual([])
    })
  })

  describe('extractLinkNodes', () => {
    it('collects every link with a backend id, in tree order, with its accessible name', () => {
      expect(extractLinkNodes(PAGE)).toEqual([
        { backendDOMNodeId: 20, text: 'Home' },
        { backendDOMNodeId: 60, text: 'Hidden link' },
        { backendDOMNodeId: 70, text: 'Wrapped link' },
        { backendDOMNodeId: 80, text: '' },
      ])
    })

    it('ignores links without a backend id and nothing that is not a link', () => {
      const links = extractLinkNodes(PAGE)
      expect(links.some((link) => link.text === 'No id link')).toBe(false)
      expect(links.length).toBe(4)
    })

    it('walks the children of the first node when no root role exists, and skips dangling child ids without crashing', () => {
      expect(extractLinkNodes(ORPHAN_TREE)).toEqual([
        { backendDOMNodeId: 2, text: 'Fallback link' },
      ])
    })

    it('returns an empty list for a page with no links and for an empty tree', () => {
      expect(extractLinkNodes(PROSE_ONLY)).toEqual([])
      expect(extractLinkNodes([])).toEqual([])
    })
  })
})
