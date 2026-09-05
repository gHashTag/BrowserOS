/**
 * First contract suite for tab-picker-popover.tsx.
 *
 * Exported symbols of the module under test:
 *   - TabPickerPopover  (exercised below: variant dispatch, rendering,
 *     loading/empty/filter/selection copy, aria roles, keyboard navigation,
 *     close behaviour, item selection - via a real react-dom/client render)
 *
 * No export is dependency-blocked: none had to be left untested, so there is
 * no blocked-export list for this file. The count of exports exercised by an
 * assertion is 1, the count listed as blocked is 0, and they sum to 1.
 *
 * Environment: this suite needs no network, no database and no container.
 * The DOM comes from linkedom, which is present in the lockfile as a pinned
 * transitive dependency of wxt (a declared devDependency of this package),
 * so it is resolved locally from the install store and never fetched.
 * chrome.tabs.query is replaced with an in-memory stub before the component
 * mounts, which is the only live dependency the component composes.
 *
 * The suite is a .ts file (not .tsx) and therefore builds its elements with
 * createElement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentProps, ReactElement } from 'react'
import type { Root } from 'react-dom/client'

type PickerProps = ComponentProps<typeof TabPickerPopover>

/**
 * Resolve linkedom without it being a direct dependency of this package:
 * 1. a bare import, for the day it is declared;
 * 2. beside wxt in the bun isolated-linker store (wxt is a declared
 *    devDependency and carries linkedom);
 * 3. by scanning the store for any linkedom entry.
 */
async function loadLinkedom(): Promise<Record<string, unknown>> {
  try {
    return (await import('linkedom')) as Record<string, unknown>
  } catch {
    // fall through to the store lookups below
  }
  try {
    const wxtUrl = import.meta.resolve(
      'wxt/package.json',
      import.meta.url,
    )
    const wxtDir = dirname(
      realpathSync(fileURLToPath(wxtUrl)),
    )
    return (await import(join(dirname(wxtDir), 'linkedom'))) as Record<
      string,
      unknown
    >
  } catch {
    // fall through to the store scan below
  }
  const store = realpathSync(
    join(import.meta.dir, '../../../../..', 'node_modules/.bun'),
  )
  const hit = readdirSync(store).find((name) => /^linkedom@/.test(name))
  if (!hit) {
    throw new Error('linkedom not found in the local install store')
  }
  return (await import(join(store, hit, 'node_modules', 'linkedom'))) as Record<
    string,
    unknown
  >
}

/**
 * Install the linkedom DOM plus the handful of browser APIs the component's
 * dependency tree dereferences but linkedom does not provide. Returns a
 * restore function so the shared bun test process is left as we found it.
 */
type Saved = {
  defined: Array<[string, unknown]>
  ownKeys: string[]
  prototypes: Array<[object, string, unknown]>
  reactActEnv: boolean | undefined
  chrome: unknown
  hadChrome: boolean
}

function installDomEnvironment(linkedom: Record<string, unknown>): {
  document: Document
  restore: () => void
} {
  const saved: Saved = {
    defined: [],
    ownKeys: Object.getOwnPropertyNames(globalThis),
    prototypes: [],
    reactActEnv: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
    chrome: (globalThis as { chrome?: unknown }).chrome,
    hadChrome: 'chrome' in globalThis,
  }

  // Bun ships native Event/CustomEvent/... classes; replace them wholesale so
  // every event the component tree dispatches is a linkedom event and linkedom
  // dispatchEvent can mutate its phase fields (native events are readonly).
  for (const [key, value] of Object.entries(linkedom)) {
    try {
      const previous = (globalThis as Record<string, unknown>)[key]
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true,
      })
      saved.defined.push([key, previous])
    } catch {
      // non-configurable globals are simply skipped
    }
  }

  const { window, document } = (
    linkedom as {
      parseHTML: (html: string) => {
        window: unknown
        document: Document
      }
    }
  ).parseHTML('<!doctype html><html><head></head><body></body></html>')
  const defineGlobal = (key: string, value: unknown) => {
    const previous = (globalThis as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    })
    saved.defined.push([key, previous])
  }
  defineGlobal('window', window)
  defineGlobal('document', document)
  defineGlobal('self', window)
  defineGlobal(
    'navigator',
    globalThis.navigator ?? {
      userAgent: 'bun-test',
      platform: 'linux',
      language: 'en-US',
      languages: ['en-US'],
    },
  )
  defineGlobal(
    'getComputedStyle',
    typeof getComputedStyle === 'function'
      ? getComputedStyle
      : () => ({
          getPropertyValue: () => '',
          display: 'block',
          visibility: 'visible',
          overflow: 'visible',
          position: 'static',
        }),
  )
  defineGlobal(
    'requestAnimationFrame',
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) =>
          setTimeout(() => cb(Date.now())) as unknown as number,
  )
  defineGlobal(
    'cancelAnimationFrame',
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id as number),
  )
  defineGlobal(
    'MutationObserver',
    typeof MutationObserver === 'function'
      ? MutationObserver
      : class {
          observe(): void {}
          disconnect(): void {}
          takeRecords(): Array<unknown> {
            return []
          }
        },
  )
  defineGlobal(
    'ResizeObserver',
    typeof ResizeObserver === 'function'
      ? ResizeObserver
      : class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        },
  )
  defineGlobal(
    'IntersectionObserver',
    typeof IntersectionObserver === 'function'
      ? IntersectionObserver
      : class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
          takeRecords(): Array<unknown> {
            return []
          }
        },
  )

  const elementProto = (globalThis as { Element?: { prototype: object } }).Element
    ?.prototype
  if (elementProto && !('scrollIntoView' in elementProto)) {
    saved.prototypes.push([
      elementProto,
      'scrollIntoView',
      (elementProto as Record<string, unknown>).scrollIntoView,
    ])
    ;(elementProto as Record<string, unknown>).scrollIntoView =
      function scrollIntoView(): void {}
  }

  // cmdk dereferences document.activeElement during mount; linkedom leaves it
  // undefined until focus is set, so give it an honest standing value.
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => document.body ?? document.documentElement ?? null,
  })

  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true

  const restore = () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      saved.reactActEnv
    for (const [proto, key, previous] of saved.prototypes) {
      ;(proto as Record<string, unknown>)[key] = previous
    }
    for (const [key, previous] of saved.defined.reverse()) {
      try {
        if (previous === undefined && !saved.ownKeys.includes(key)) {
          delete (globalThis as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, {
            value: previous,
            writable: true,
            configurable: true,
          })
        }
      } catch {
        // best-effort restore
      }
    }
    if (saved.hadChrome) {
      ;(globalThis as Record<string, unknown>).chrome = saved.chrome
    } else {
      delete (globalThis as Record<string, unknown>).chrome
    }
  }

  return { document, restore }
}

describe('tabPickerPopoverTsxContract', () => {
  // react-dom detects its execution environment at module scope, and the
  // component's own module graph pulls react-dom in through the radix
  // portal, so every runtime import happens here, after the DOM globals
  // are in place. Type-only imports above are erased and stay static.
  let React: typeof import('react')
  let createRoot: typeof import('react-dom/client')['createRoot']
  let act: typeof import('react')['act']
  let createElement: typeof import('react')['createElement']
  let TabPickerPopover: typeof import('./tab-picker-popover')['TabPickerPopover']
  let document: Document
  let restoreDom: () => void
  let root: Root
  let container: HTMLDivElement
  let anchor: HTMLDivElement

  const newsTab = {
    id: 1,
    title: 'News Site',
    url: 'https://news.example.com/world',
    lastAccessed: 50,
  }
  const docsTab = {
    id: 2,
    title: 'API Docs',
    url: 'https://docs.example.com/api',
    lastAccessed: 30,
  }
  const mailTab = {
    id: 3,
    title: 'Inbox',
    url: 'https://mail.example.com/inbox',
    lastAccessed: 10,
  }
  const allTabs = [newsTab, docsTab, mailTab]

  let queryResponses: Array<
    (query: { currentWindow: boolean }) => Promise<Array<typeof allTabs[number]>>
  >
  let queryCalls: Array<{ currentWindow: boolean }>

  const bodyHtml = () => document.body.innerHTML

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

  const renderPicker = (props: PickerProps): Promise<void> =>
    act(async () => {
      root.render(createElement(TabPickerPopover, props))
    })

  const pressKey = (key: string) => {
    const linkedom = (globalThis as { Event: new (type: string, init: {
      bubbles?: boolean
      cancelable?: boolean
    }) => Event & { key?: string } }).Event
    const event = new linkedom('keydown', {
      bubbles: true,
      cancelable: true,
    })
    event.key = key
    document.dispatchEvent(event)
  }

  // A browser flushes React state between two discrete key presses; give each
  // press its own act so the document listener re-binds to fresh state, just
  // like the next tick of a real event loop would.
  const pressKeyAlone = async (key: string) => {
    await act(async () => {
      pressKey(key)
    })
  }

  const clickElement = (element: Element) => {
    const linkedom = (globalThis as { Event: new (type: string, init: {
      bubbles?: boolean
      cancelable?: boolean
    }) => Event & { button?: number } }).Event
    const pointerUp = new linkedom('pointerup', {
      bubbles: true,
      cancelable: true,
    })
    pointerUp.button = 0
    element.dispatchEvent(pointerUp)
    const click = new linkedom('click', { bubbles: true, cancelable: true })
    click.button = 0
    element.dispatchEvent(click)
  }

  const findOptionByText = (text: string): Element | undefined =>
    Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      (option.textContent ?? '').includes(text),
    )

  beforeAll(async () => {
    const linkedom = await loadLinkedom()
    const env = installDomEnvironment(linkedom)
    document = env.document
    restoreDom = env.restore

    React = await import('react')
    act = React.act
    createElement = React.createElement
    createRoot = (await import('react-dom/client')).createRoot
    TabPickerPopover = (await import('./tab-picker-popover')).TabPickerPopover

    queryResponses = []
    queryCalls = []
    ;(globalThis as Record<string, unknown>).chrome = {
      tabs: {
        query: (query: { currentWindow: boolean }) => {
          queryCalls.push(query)
          const responder = queryResponses.shift()
          return responder
            ? responder(query)
            : Promise.resolve([] as Array<typeof allTabs[number]>)
        },
      },
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    anchor = document.createElement('div')
    document.body.appendChild(anchor)
    root = createRoot(container)
  })

  afterAll(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      // radix schedules focus restoration in a setTimeout(0); let it run
      // while the linkedom event classes are still the globals, so no native
      // event can reach a linkedom dispatchEvent afterwards.
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    if (document) {
      document.body.innerHTML = ''
    }
    restoreDom?.()
  })

  it('pins the TabPickerPopover contract for the mention and selector variants', async () => {
    // ---- mention variant: closed popover ----
    await renderPicker({
      variant: 'mention',
      isOpen: false,
      filterText: '',
      selectedTabs: [],
      onToggleTab: () => {},
      onClose: () => {},
      anchorRef: { current: anchor },
    })
    await settle()
    expect(container.innerHTML).toBe('')
    expect(bodyHtml()).not.toContain('Attach Tabs')
    // the closed popover must not have queried the browser for tabs
    expect(queryCalls).toHaveLength(0)

    // ---- mention variant: open popover, loading then populated ----
    let resolveTabs: (tabs: Array<typeof allTabs[number]>) => void = () => {}
    queryResponses.push(
      () =>
        new Promise((resolve) => {
          resolveTabs = resolve
        }),
    )
    const toggled: Array<number | undefined> = []
    let closeCount = 0
    await renderPicker({
      variant: 'mention',
      isOpen: true,
      filterText: '',
      selectedTabs: [],
      onToggleTab: (tab) => toggled.push(tab.id),
      onClose: () => {
        closeCount += 1
      },
      anchorRef: { current: anchor },
    })
    await settle()
    // while the tab query is pending the popover shows its loading state
    expect(queryCalls).toHaveLength(1)
    expect(bodyHtml()).toContain('Loading tabs…')
    expect(findOptionByText('News Site')).toBeUndefined()
    await act(async () => {
      resolveTabs(allTabs)
    })
    await settle()
    // once the query resolves the popover shows its header and every tab
    expect(bodyHtml()).toContain('Attach Tabs')
    expect(bodyHtml()).toContain('Type to filter')
    expect(findOptionByText('News Site')).toBeDefined()
    expect(findOptionByText('API Docs')).toBeDefined()
    expect(findOptionByText('Inbox')).toBeDefined()
    expect(bodyHtml()).toContain(newsTab.url)
    expect(bodyHtml()).toContain(docsTab.url)
    expect(bodyHtml()).toContain(mailTab.url)
    // aria contract of the open popover
    expect(
      document.querySelector('[role="dialog"][aria-label="Select tabs to attach"]'),
    ).not.toBeNull()
    // cmdk renders the list with its own default aria-label, so the label the
    // component passes is not what reaches the DOM; the role and the
    // multi-selectable flag are the observable parts of the contract.
    const listBox = document.querySelector('[role="listbox"]')
    expect(listBox).not.toBeNull()
    expect(listBox?.getAttribute('aria-multiselectable')).toBe('true')

    // ---- mention variant: keyboard navigation and selection ----
    // ArrowDown twice moves the focus to the third tab, Enter selects it
    await pressKeyAlone('ArrowDown')
    await pressKeyAlone('ArrowDown')
    await pressKeyAlone('Enter')
    expect(toggled).toEqual([mailTab.id])
    // ArrowUp moves back up, Enter selects the now-focused tab
    await pressKeyAlone('ArrowUp')
    await pressKeyAlone('Enter')
    expect(toggled).toEqual([mailTab.id, docsTab.id])

    // ---- mention variant: filtering, focus reset, empty results ----
    // a new filterText narrows the list and resets the focus to the top
    await renderPicker({
      variant: 'mention',
      isOpen: true,
      filterText: 'api',
      selectedTabs: [],
      onToggleTab: (tab) => toggled.push(tab.id),
      onClose: () => {
        closeCount += 1
      },
      anchorRef: { current: anchor },
    })
    await settle()
    expect(bodyHtml()).toContain('Filtering: "api"')
    expect(findOptionByText('API Docs')).toBeDefined()
    expect(findOptionByText('News Site')).toBeUndefined()
    expect(findOptionByText('Inbox')).toBeUndefined()
    await pressKeyAlone('Enter')
    expect(toggled).toEqual([mailTab.id, docsTab.id, docsTab.id])
    // a filter that matches nothing shows the no-match copy, not the tabs
    await renderPicker({
      variant: 'mention',
      isOpen: true,
      filterText: 'zzz',
      selectedTabs: [],
      onToggleTab: (tab) => toggled.push(tab.id),
      onClose: () => {
        closeCount += 1
      },
      anchorRef: { current: anchor },
    })
    await settle()
    expect(bodyHtml()).toContain('No tabs matching "zzz"')
    expect(bodyHtml()).toContain('Try a different search term')
    await pressKeyAlone('Enter')
    expect(toggled).toEqual([mailTab.id, docsTab.id, docsTab.id])

    // ---- mention variant: selection count copy ----
    await renderPicker({
      variant: 'mention',
      isOpen: true,
      filterText: '',
      selectedTabs: [newsTab],
      onToggleTab: (tab) => toggled.push(tab.id),
      onClose: () => {
        closeCount += 1
      },
      anchorRef: { current: anchor },
    })
    await settle()
    expect(bodyHtml()).toContain('1 tab selected')
    await renderPicker({
      variant: 'mention',
      isOpen: true,
      filterText: '',
      selectedTabs: [newsTab, docsTab],
      onToggleTab: (tab) => toggled.push(tab.id),
      onClose: () => {
        closeCount += 1
      },
      anchorRef: { current: anchor },
    })
    await settle()
    expect(bodyHtml()).toContain('2 tabs selected')

    // ---- mention variant: closing keys and disinterested keys ----
    const toggledBefore = toggled.length
    const closedBefore = closeCount
    await pressKeyAlone('a')
    expect(closeCount).toBe(closedBefore)
    expect(toggled.length).toBe(toggledBefore)
    await pressKeyAlone('Tab')
    })
    expect(closeCount).toBeGreaterThan(closedBefore)
    const closedAfterTab = closeCount
    await pressKeyAlone('Escape')
    expect(closeCount).toBeGreaterThan(closedAfterTab)

    // ---- mention variant: picking an item with the pointer ----
    const inboxOption = findOptionByText('Inbox')
    expect(inboxOption).toBeDefined()
    await act(async () => {
      clickElement(inboxOption as Element)
    })
    expect(toggled[toggled.length - 1]).toBe(mailTab.id)

    // ---- mention variant: the no-tabs-at-all empty state ----
    queryResponses.push(() => Promise.resolve([]))
    await renderPicker({
      variant: 'mention',
      isOpen: true,
      filterText: '',
      selectedTabs: [],
      onToggleTab: (tab) => toggled.push(tab.id),
      onClose: () => {
        closeCount += 1
      },
      anchorRef: { current: anchor },
    })
    await settle()
    expect(bodyHtml()).toContain('No active tabs')
    expect(bodyHtml()).toContain('Open some web pages to attach them')

    // ---- selector variant: closed state renders the trigger only ----
    queryResponses.push(() => Promise.resolve(allTabs))
    const selectorToggled: Array<number | undefined> = []
    await renderPicker({
      variant: 'selector',
      selectedTabs: [newsTab],
      onToggleTab: (tab) => selectorToggled.push(tab.id),
      children: createElement(
        'button',
        { type: 'button' },
        'Attach tabs to this message',
      ) as ReactElement,
    })
    await settle()
    const trigger = document.querySelector('button[type="button"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('Attach tabs to this message')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(bodyHtml()).not.toContain('Search tabs...')

    // ---- selector variant: opening and picking from the list ----
    await act(async () => {
      clickElement(trigger as Element)
    })
    await settle()
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(bodyHtml()).toContain('Search tabs...')
    expect(bodyHtml()).toContain('1 selected')
    expect(findOptionByText('News Site')).toBeDefined()
    expect(findOptionByText('API Docs')).toBeDefined()
    expect(findOptionByText('Inbox')).toBeDefined()
    const docsOption = findOptionByText('API Docs')
    expect(docsOption).toBeDefined()
    await act(async () => {
      clickElement(docsOption as Element)
    })
    expect(selectorToggled).toEqual([docsTab.id])
  })
})
