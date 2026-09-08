/**
 * Contract suite for the exports of AclSettingsPage.tsx.
 *
 * The module exports exactly one symbol: `AclSettingsPage`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`AclSettingsPage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies are the agent server that
 * `@/lib/acl/api` talks to over HTTP, the extension storage backing
 * `@/lib/acl/storage`, and the `useAgentServerUrl` provider hook. All three
 * are swapped for in-memory stubs via `mock.module`, so this suite needs no
 * network, no database and no container.
 *
 * Not pinned, and why: the module's effect-driven behaviour - loading rules
 * from extension storage, bootstrapping an empty server rule list from
 * local rules, and the add/toggle/delete handlers persisting through
 * `saveRules` - lives inside `useEffect` callbacks. There is no DOM
 * environment available to `bun test` in this project - `@testing-library`,
 * `happy-dom` and `jsdom` are all absent from the lockfile - and React's
 * server renderer never runs effects, so only the component's first-paint
 * output can be pinned: the shell a user sees while rules are still empty
 * and before any effect has fired. That is a gap in behaviour coverage, not
 * an export left unexercised: the export itself is rendered and asserted
 * on, so no export belongs in the blocked list above.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AclRule } from '@browseros/shared/types/acl'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type AgentServerUrlState = {
  baseUrl: string | null
  isLoading: boolean
  error: Error | null
}

let agentServerUrlState: AgentServerUrlState

// The provider hook is stubbed so the component renders against a
// controllable view of agent-server connectivity, without loading the
// browser-messaging stack that sits under the real implementation.
mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => agentServerUrlState,
}))

// Extension-storage stub: rules live in memory and watchers are notified on
// write, mirroring the watched storage item the real module exports.
let storedRules: AclRule[] = []
const ruleWatchers = new Set<(rules: AclRule[]) => void>()

mock.module('@/lib/acl/storage', () => ({
  aclRulesStorage: {
    getValue: () => Promise.resolve([...storedRules]),
    setValue: (next: AclRule[]) => {
      storedRules = [...next]
      for (const notify of ruleWatchers) notify([...storedRules])
      return Promise.resolve()
    },
    watch: (onChange: (rules: AclRule[]) => void) => {
      ruleWatchers.add(onChange)
      return () => ruleWatchers.delete(onChange)
    },
  },
}))

// Agent-server API stub: no HTTP leaves the process; every call is served
// from memory.
let serverRules: AclRule[] = []
const aclApiCalls: Array<{ endpoint: string }> = []

mock.module('@/lib/acl/api', () => ({
  fetchServerAclRules: async (_baseUrl: string) => {
    aclApiCalls.push({ endpoint: 'GET /acl-rules' })
    return [...serverRules]
  },
  updateServerAclRules: async (_baseUrl: string, next: AclRule[]) => {
    aclApiCalls.push({ endpoint: 'PUT /acl-rules' })
    serverRules = [...next]
    return [...serverRules]
  },
}))

const { AclSettingsPage } = await import('./AclSettingsPage')

const renderPage = (): string => renderToString(createElement(AclSettingsPage))

describe('AclSettingsPageTsxContract', () => {
  beforeEach(() => {
    agentServerUrlState = { baseUrl: null, isLoading: false, error: null }
    storedRules = []
    serverRules = []
    ruleWatchers.clear()
    aclApiCalls.length = 0
  })

  it('AclSettingsPage renders the page header with its add-rule affordance', () => {
    const html = renderPage()

    expect(html).toContain('>ACL Rules</h1>')
    expect(html).toContain(
      'Describe what the agent should avoid on a site and BrowserOS will block matching actions.',
    )
    expect(html).toContain('Add Rule')
    expect((html.match(/<h1/g) ?? []).length).toBe(1)
  })

  it('AclSettingsPage renders the empty-state card when no rules are defined', () => {
    const html = renderPage()

    expect(html).toContain('No ACL rules defined')
    // The guidance copy quotes its examples with typographic quotes.
    expect(html).toContain('“payments and checkout”')
    expect(html).toContain('“send email”')
    expect(html).toContain('will apply broad safety blocking on that site.')
    expect(html).toContain('Add your first rule')
  })

  it('AclSettingsPage shows no rule cards and keeps the creation dialog closed on first paint', () => {
    const html = renderPage()

    // No rule has loaded yet, so no rule-card switch is rendered and the
    // new-rule dialog has not been opened.
    expect(html).not.toContain('role="switch"')
    expect(html).not.toContain('Add ACL Rule')
    expect(html).not.toContain('Matches the domain and all subdomains.')
  })

  it('AclSettingsPage paints the full shell while the agent server URL is unresolved', () => {
    agentServerUrlState = { baseUrl: null, isLoading: true, error: null }

    const html = renderPage()

    expect(html).toContain('>ACL Rules</h1>')
    expect(html).toContain('No ACL rules defined')
    expect(html).toContain('Add Rule')
    expect(html).toContain('Add your first rule')
  })
})
