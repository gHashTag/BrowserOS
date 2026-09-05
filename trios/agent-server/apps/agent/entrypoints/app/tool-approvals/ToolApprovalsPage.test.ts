/**
 * Contract suite for the exports of ToolApprovalsPage.tsx.
 *
 * The module exports exactly one symbol: `ToolApprovalsPage`. The single
 * test below renders that export and asserts on the markup it emits, so
 * the suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ToolApprovalsPage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The module's only live dependency is the web-extension storage API
 * behind `@wxt-dev/storage`: the `toolApprovalConfigStorage` item from
 * `@/lib/tool-approvals/storage` probes `browser.runtime` the moment its
 * module loads. An in-memory stand-in is installed on globalThis before
 * the subject is imported, so this suite needs no network, no database
 * and no container.
 *
 * Not pinned, and why: user interactions (flipping a category switch or
 * the master toggle, the immediate write-back through
 * `toolApprovalConfigStorage`, and the watch-driven re-render) dispatch
 * DOM events through Radix widgets and run the mount effect. There is no
 * DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the component's rendered output is pinned. That is
 * a gap in interaction coverage, not an export left unexercised: the
 * export itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type StorageChange = { newValue: unknown; oldValue: unknown }
type StorageListener = (changes: Record<string, StorageChange>) => void

/**
 * Minimal in-memory `browser.storage.local`. `@wxt-dev/browser` reads
 * `globalThis.browser` at import time, and `@wxt-dev/storage` touches
 * `browser.runtime` the moment a storage item is defined, so the fake
 * has to be in place before the subject module is imported.
 */
const createFakeStorageArea = () => {
  const values = new Map<string, unknown>()
  const listeners = new Set<StorageListener>()
  const announce = (changes: Record<string, StorageChange>) => {
    for (const listener of listeners) listener(changes)
  }
  return {
    get: async (keys?: null | string | string[] | Record<string, unknown>) => {
      if (keys == null) return Object.fromEntries(values)
      if (typeof keys === 'string') return { [keys]: values.get(keys) }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, values.get(key)]))
      }
      return Object.fromEntries(
        Object.keys(keys).map((key) => [key, values.get(key) ?? keys[key]]),
      )
    },
    set: async (items: Record<string, unknown>) => {
      const changes: Record<string, StorageChange> = {}
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { newValue: value, oldValue: values.get(key) }
        values.set(key, value)
      }
      announce(changes)
    },
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys]
      const changes: Record<string, StorageChange> = {}
      for (const key of list) {
        changes[key] = { newValue: undefined, oldValue: values.get(key) }
        values.delete(key)
      }
      announce(changes)
    },
    clear: async () => {
      values.clear()
      announce({})
    },
    onChanged: {
      addListener: (listener: StorageListener) => listeners.add(listener),
      removeListener: (listener: StorageListener) => listeners.delete(listener),
    },
  }
}

Object.assign(globalThis, {
  browser: {
    runtime: { id: 'tool-approvals-contract-suite' },
    storage: { local: createFakeStorageArea() },
  },
})

const { ToolApprovalsPage } = await import('./ToolApprovalsPage')
const { TOOL_CATEGORIES } = await import('@/lib/tool-approvals/types')

// React escapes `&`, `<`, `>`, quotes and apostrophes inside text nodes,
// so expected copy has to be escaped before searching the markup for it.
const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

describe('ToolApprovalsPageTsxContract', () => {
  it('ToolApprovalsPage renders the approval page: heading, master toggle, one card per category in order, every switch off', () => {
    const html = renderToString(createElement(ToolApprovalsPage))

    // The page header names the feature and explains what approval means.
    expect(html).toContain('Tool Approvals</h2>')
    expect(html).toContain(
      'Require human approval before the agent executes certain actions.',
    )
    expect(html).toContain('Changes apply immediately.')

    // The master toggle offers to flip every category at once.
    expect(html).toContain('Require approval for all')
    expect(html).toContain('Toggle all categories at once')

    // One card per approval category, in the order the shared constants
    // define them, each naming the category and quoting its description.
    let previousPosition = -1
    for (const category of TOOL_CATEGORIES) {
      const at = html.indexOf(escapeHtml(category.name))
      expect(at).toBeGreaterThan(previousPosition)
      previousPosition = at
      expect(html).toContain(escapeHtml(category.description))
    }

    // The master toggle plus one switch per category, and nothing is
    // approved on first paint: the empty initial config leaves every
    // switch unchecked.
    const switchTotal = TOOL_CATEGORIES.length + 1
    expect((html.match(/role="switch"/g) ?? []).length).toBe(switchTotal)
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(0)
    expect((html.match(/aria-checked="false"/g) ?? []).length).toBe(switchTotal)
  })
})
