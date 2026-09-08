/**
 * Pins the current behaviour of src/browser/elements.ts.
 *
 * Until this file existed, none of that module's seven exports was named
 * by any test in the repository: the element-centre, scroll, focus and
 * click plumbing every pointer and form tool leans on was green only in
 * the sense that nothing looked at it. This suite does not redesign
 * anything - it pins the behaviour that already exists so the next change
 * to elements.ts has something to fail against.
 *
 * Coverage map - every export is exercised, none is blocked:
 *
 *   getElementCenter  three-tier centre lookup    -> scripted page below
 *   scrollIntoView    best-effort scroll command  -> scripted page below
 *   focusElement      focuses the pushed frontend node -> scripted page below
 *   jsClick           clicks the resolved element -> scripted page below
 *   resolveObjectId   backend node to remote object -> scripted page below
 *   getInputValue     reads value, else text content -> scripted page below
 *   callOnElement     runs a caller's function on the element -> below
 *
 * Exercised: 7, blocked by a live dependency: 0, total exports: 7.
 *
 * Every export talks to a browser, but the CDP session arrives as an
 * argument - that parameter is the module's own seam, so the page side is
 * scripted here and the suite needs no browser, no network, no database
 * and no container. The scripted page answers protocol commands from
 * plain data and actually evaluates the functions the subject sends it,
 * binding them to a stand-in page object: a click the subject dispatches
 * really runs against the element, so assertions land on returned values
 * and on what the fake page observed, never on the text of the scripts
 * the subject happens to send. What is NOT pinned is how a real layout
 * engine fills in those quads and rects: observing that needs a live
 * page, which is not reachable through the session parameter. The order
 * in which the tiers answer, and what each tier does when it cannot, are
 * observable here and are pinned.
 */

import { describe, expect, it } from 'bun:test'
import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import {
  callOnElement,
  focusElement,
  getElementCenter,
  getInputValue,
  jsClick,
  resolveObjectId,
  scrollIntoView,
} from '../../src/browser/elements'

/**
 * One element of the scripted page.
 *
 *   quads        what DOM.getContentQuads answers ([] when absent)
 *   boxContent   what DOM.getBoxModel answers as the model's content quad
 *   pageObject   bound as `this` when the subject runs a function on the
 *                element - a real JS object, so value/textContent reads and
 *                click/getBoundingClientRect dispatches are genuinely run
 *   frontendNodeId  what DOM.pushNodesByBackendIdsToFrontend maps the
 *                backend id to
 *
 * The *Throw flags model the failure modes a live page presents: the
 * command itself failing. `noObjectId` models resolveNode answering with
 * a remote object that carries no id, which is how a node that has just
 * been removed from the DOM shows up.
 */
interface PageElement {
  objectId: string
  pageObject: object
  quads?: number[][]
  quadsThrow?: boolean
  boxContent?: number[]
  boxThrow?: boolean
  noObjectId?: boolean
  resolveThrow?: boolean
  frontendNodeId?: number
}

/**
 * The session every export takes as its first argument, answering from the
 * element table. A function the subject sends that throws against the page
 * object comes back as exceptionDetails and no value - which is how the
 * real protocol reports a page-side exception - so the subject's own
 * "could not get bounds" branch is reachable without a live page.
 */
function scriptedPage(
  elements: Record<number, PageElement>,
  page?: { scrollThrows?: boolean },
) {
  const scrolls: number[] = []
  const focusTargets: number[] = []

  const element = (backendNodeId: number): PageElement => {
    const found = elements[backendNodeId]
    if (!found) throw new Error(`No node #${backendNodeId} on this page`)
    return found
  }
  const elementByObjectId = (objectId: string): PageElement => {
    const found = Object.values(elements).find(
      (candidate) => candidate.objectId === objectId,
    )
    if (!found) throw new Error(`No remote object ${objectId} on this page`)
    return found
  }

  const session = {
    DOM: {
      getContentQuads: async ({ backendNodeId }: { backendNodeId: number }) => {
        const el = element(backendNodeId)
        if (el.quadsThrow) throw new Error('Could not compute content quads')
        return { quads: el.quads ?? [] }
      },
      getBoxModel: async ({ backendNodeId }: { backendNodeId: number }) => {
        const el = element(backendNodeId)
        if (el.boxThrow) throw new Error('Could not compute box model')
        return { model: { content: el.boxContent ?? [] } }
      },
      resolveNode: async ({ backendNodeId }: { backendNodeId: number }) => {
        const el = element(backendNodeId)
        if (el.resolveThrow) throw new Error('Could not resolve node')
        return el.noObjectId
          ? { object: {} }
          : { object: { objectId: el.objectId } }
      },
      pushNodesByBackendIdsToFrontend: async ({
        backendNodeIds,
      }: {
        backendNodeIds: number[]
      }) => ({
        nodeIds: backendNodeIds.map((id) => element(id).frontendNodeId ?? id),
      }),
      focus: async ({ nodeId }: { nodeId: number }) => {
        focusTargets.push(nodeId)
      },
      scrollIntoViewIfNeeded: async ({
        backendNodeId,
      }: {
        backendNodeId: number
      }) => {
        if (page?.scrollThrows) {
          throw new Error('Node does not have a layout object')
        }
        scrolls.push(backendNodeId)
      },
    },
    Runtime: {
      callFunctionOn: async (call: {
        functionDeclaration: string
        objectId: string
        arguments?: Array<{ value: unknown }>
      }) => {
        const el = elementByObjectId(call.objectId)
        const fn = new Function(`return (${call.functionDeclaration})`)() as (
          ...fnArgs: unknown[]
        ) => unknown
        const args = (call.arguments ?? []).map((remote) => remote.value)
        try {
          return { result: { value: fn.apply(el.pageObject, args) } }
        } catch (err) {
          return { exceptionDetails: { text: String(err) } }
        }
      },
    },
  }
  return { session: session as unknown as ProtocolApi, scrolls, focusTargets }
}

describe('elementsContract', () => {
  describe('getElementCenter', () => {
    it('centres on the content quad, falls back to the box model and then the bounding rect, and rejects when no tier can answer', async () => {
      const { session } = scriptedPage({
        // All three tiers available and disagreeing: the quad must win.
        1: {
          objectId: 'quads-1',
          pageObject: {
            getBoundingClientRect: () => ({
              left: 500,
              top: 500,
              width: 50,
              height: 50,
            }),
          },
          quads: [[0, 0, 40, 0, 40, 20, 0, 20]],
          boxContent: [0, 0, 80, 0, 80, 40, 0, 40],
        },
        // No quads for this node: the box model's content quad answers.
        2: {
          objectId: 'box-2',
          pageObject: {},
          boxContent: [0, 0, 8, 0, 8, 4, 0, 4],
        },
        // A malformed quad (fewer than 8 numbers) must not produce a
        // centre: the box model answers instead.
        3: {
          objectId: 'short-quad-3',
          pageObject: {},
          quads: [[1, 2, 3]],
          boxContent: [0, 0, 8, 0, 8, 4, 0, 4],
        },
        // Both DOM commands fail: the centre comes from the rect the page
        // reports for the resolved object.
        4: {
          objectId: 'rect-4',
          pageObject: {
            getBoundingClientRect: () => ({
              left: 100,
              top: 50,
              width: 20,
              height: 10,
            }),
          },
          quadsThrow: true,
          boxThrow: true,
        },
        // The node resolves to a remote object with no id - the page just
        // removed it. Nothing can answer, and that must surface.
        5: {
          objectId: 'removed-5',
          pageObject: {},
          quadsThrow: true,
          boxThrow: true,
          noObjectId: true,
        },
        // The rect read itself blows up on the page: tier three cannot
        // answer either, and that must surface too.
        6: {
          objectId: 'broken-rect-6',
          pageObject: {
            getBoundingClientRect: () => {
              throw new Error('element is detached')
            },
          },
          quadsThrow: true,
          boxThrow: true,
        },
      })

      await expect(getElementCenter(session, 1)).resolves.toEqual({
        x: 20,
        y: 10,
      })
      await expect(getElementCenter(session, 2)).resolves.toEqual({
        x: 4,
        y: 2,
      })
      await expect(getElementCenter(session, 3)).resolves.toEqual({
        x: 4,
        y: 2,
      })
      await expect(getElementCenter(session, 4)).resolves.toEqual({
        x: 110,
        y: 55,
      })
      await expect(getElementCenter(session, 5)).rejects.toThrow(
        'Could not resolve element — it may have been removed from the page.',
      )
      await expect(getElementCenter(session, 6)).rejects.toThrow(
        'Could not get element bounds.',
      )
    })
  })

  describe('scrollIntoView', () => {
    it('scrolls the named node into view, and a session that cannot scroll is a no-op rather than an error', async () => {
      const healthy = scriptedPage({
        42: { objectId: 'scroll-me', pageObject: {} },
      })
      await scrollIntoView(healthy.session, 42)
      expect(healthy.scrolls).toEqual([42])

      const hostile = scriptedPage(
        { 43: { objectId: 'detached', pageObject: {} } },
        { scrollThrows: true },
      )
      await scrollIntoView(hostile.session, 43)
      expect(hostile.scrolls).toEqual([])
    })
  })

  describe('focusElement', () => {
    it('focuses the frontend node the session hands back for the backend id', async () => {
      const { session, focusTargets } = scriptedPage({
        42: { objectId: 'first', pageObject: {}, frontendNodeId: 999 },
        7: { objectId: 'second', pageObject: {}, frontendNodeId: 1001 },
      })
      await focusElement(session, 42)
      await focusElement(session, 7)
      expect(focusTargets).toEqual([999, 1001])
    })
  })

  describe('jsClick', () => {
    it('clicks the element the backend id resolves to, and only that element', async () => {
      const clicks: string[] = []
      const { session } = scriptedPage({
        42: {
          objectId: 'submit-button',
          pageObject: {
            click: () => clicks.push('submit-button'),
          },
        },
        7: {
          objectId: 'other-button',
          pageObject: {
            click: () => clicks.push('other-button'),
          },
        },
      })
      await jsClick(session, 42)
      expect(clicks).toEqual(['submit-button'])
    })
  })

  describe('resolveObjectId', () => {
    it('returns the remote object id of the node, and rejects when the page has none for it', async () => {
      const { session } = scriptedPage({
        42: { objectId: 'obj-42', pageObject: {} },
        7: { objectId: 'obj-7', pageObject: {}, noObjectId: true },
      })
      await expect(resolveObjectId(session, 42)).resolves.toBe('obj-42')
      await expect(resolveObjectId(session, 7)).rejects.toThrow(
        'Element not found in DOM. Take a new snapshot.',
      )
    })
  })

  describe('getInputValue', () => {
    it("reads the element's value, else its text content, and yields an empty string whenever the read cannot happen", async () => {
      const { session } = scriptedPage({
        1: { objectId: 'input', pageObject: { value: 'typed text' } },
        2: { objectId: 'editable-div', pageObject: { textContent: 'read me' } },
        3: { objectId: 'nothing-to-read', pageObject: {} },
        4: { objectId: 'gone', pageObject: {}, resolveThrow: true },
      })
      await expect(getInputValue(session, 1)).resolves.toBe('typed text')
      await expect(getInputValue(session, 2)).resolves.toBe('read me')
      await expect(getInputValue(session, 3)).resolves.toBe('')
      await expect(getInputValue(session, 4)).resolves.toBe('')
    })
  })

  describe('callOnElement', () => {
    it("runs the caller's function on the element with the given arguments by value, and lets resolution failures surface", async () => {
      const { session } = scriptedPage({
        1: { objectId: 'button', pageObject: { tagName: 'BUTTON' } },
        2: { objectId: 'calculator', pageObject: {} },
        3: { objectId: 'unresolvable', pageObject: {}, resolveThrow: true },
      })
      await expect(
        callOnElement(session, 1, 'function(){return this.tagName}'),
      ).resolves.toBe('BUTTON')
      await expect(
        callOnElement(session, 2, 'function(a,b){return a+b}', [2, 3]),
      ).resolves.toBe(5)
      await expect(
        callOnElement(session, 3, 'function(){return this.tagName}'),
      ).rejects.toThrow('Could not resolve node')
    })
  })
})
