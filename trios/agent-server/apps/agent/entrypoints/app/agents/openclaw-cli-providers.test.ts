/**
 * Contract suite for the exports of openclaw-cli-providers.tsx.
 *
 * The module exports five symbols: OPENCLAW_CLI_PROVIDERS,
 * findOpenClawCliProviderById, buildOpenClawCliProviderOptions,
 * useOpenClawCliProviderAuthStatus and OpenClawCliProviderStatusPanel.
 * Every `it` block below is named for the export whose behaviour it pins,
 * so a reader can map assertions to exports one-for-one.
 *
 * Export accounting (the module has 5 exports in total):
 *   - exercised by assertions below: 5 (all five named above)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 5 + 0 = 5, matching the export count of the module.
 *
 * The module's live dependencies are the local agent server that the auth
 * status hook fetches from over HTTP, and the browser-extension messaging
 * layer (`useAgentServerUrl`) that discovers that server's base URL. Both
 * are swapped for in-process stubs - `mock.module` supplies the base URL
 * and a captured `globalThis.fetch` answers the HTTP calls - so this suite
 * needs no network, no database and no container.
 *
 * Not pinned, and why: user interactions (clicking the Connect button)
 * dispatch real DOM events, and the 2-second polling cadence of
 * `useOpenClawCliProviderAuthStatus` only runs once a React tree is
 * subscribed to the query observer. `bun test` in this project has no DOM
 * environment - `@testing-library`, `happy-dom` and `jsdom` are all absent
 * from the lockfile - so only rendered markup, returned data and returned
 * errors are pinned. Those are gaps in interaction and timer coverage, not
 * exports left unexercised: every export is called or rendered and asserted
 * on, so no export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  OpenClawCliProvider,
  OpenClawCliProviderAuthStatus,
} from './openclaw-cli-providers'

type AgentServerUrlResult = {
  baseUrl: string | null
  isLoading: boolean
  error: Error | null
}

let agentServerUrlResult: AgentServerUrlResult = {
  baseUrl: null,
  isLoading: false,
  error: null,
}

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => agentServerUrlResult,
}))

const {
  OPENCLAW_CLI_PROVIDERS,
  findOpenClawCliProviderById,
  buildOpenClawCliProviderOptions,
  useOpenClawCliProviderAuthStatus,
  OpenClawCliProviderStatusPanel,
} = await import('./openclaw-cli-providers')

// The panel is exercised against a synthetic provider rather than the real
// catalogue, so that its assertions pin the panel's own branching and
// interpolation, not the catalogue data pinned separately below.
const PANEL_PROVIDER: OpenClawCliProvider = {
  id: 'test-cli',
  displayName: 'Test CLI',
  description: 'A synthetic provider used only by this suite',
  models: ['test-model-a', 'test-model-b'],
  authLoginCommand: 'test-cli /login',
}

const renderPanel = (props: {
  status?: OpenClawCliProviderAuthStatus
  loading?: boolean
  fetchError?: Error | null
}): string =>
  renderToString(
    createElement(OpenClawCliProviderStatusPanel, {
      provider: PANEL_PROVIDER,
      status: props.status,
      loading: props.loading ?? false,
      fetchError: props.fetchError ?? null,
      onConnect: () => {},
    }),
  )

// React's server renderer separates adjacent text and expression segments
// with `<!-- -->` placeholders. Stripping them leaves the text a user
// actually sees, so assertions below pin visible copy rather than React's
// internal segment markers.
const visibleText = (html: string): string => html.replaceAll('<!-- -->', '')

type AuthStatusHookResult = ReturnType<typeof useOpenClawCliProviderAuthStatus>

let capturedHookResult: AuthStatusHookResult | undefined

function AuthStatusProbe({
  providerId,
  enabled,
}: {
  providerId: string
  enabled: boolean
}) {
  capturedHookResult = useOpenClawCliProviderAuthStatus(providerId, enabled)
  return null
}

const renderAuthStatusHook = (
  providerId: string,
  enabled: boolean,
): AuthStatusHookResult => {
  const client = new QueryClient()
  renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AuthStatusProbe, { providerId, enabled }),
    ),
  )
  if (!capturedHookResult) throw new Error('auth status probe did not run')
  return capturedHookResult
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('openclawCliProvidersTsxContract', () => {
  it('OPENCLAW_CLI_PROVIDERS pins the CLI provider catalogue as it stands today', () => {
    expect([...OPENCLAW_CLI_PROVIDERS]).toEqual([
      {
        id: 'claude-cli',
        displayName: 'Anthropic Claude CLI',
        description: 'Uses your Claude.ai subscription via the Claude Code CLI',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
        authLoginCommand: 'claude /login',
      },
    ])

    // Every entry carries the fields the rest of the app renders or shells
    // out to, so a malformed entry is a contract break even one field at a
    // time.
    for (const provider of OPENCLAW_CLI_PROVIDERS) {
      expect(provider.id.length).toBeGreaterThan(0)
      expect(provider.displayName.length).toBeGreaterThan(0)
      expect(provider.description.length).toBeGreaterThan(0)
      expect(provider.authLoginCommand.length).toBeGreaterThan(0)
      expect(provider.models.length).toBeGreaterThan(0)
    }
    expect(
      new Set(OPENCLAW_CLI_PROVIDERS.map((provider) => provider.id)).size,
    ).toBe(OPENCLAW_CLI_PROVIDERS.length)
  })

  it('findOpenClawCliProviderById resolves a known id and reports an unknown one', () => {
    const found = findOpenClawCliProviderById('claude-cli')
    expect(found?.displayName).toBe('Anthropic Claude CLI')
    expect(found?.authLoginCommand).toBe('claude /login')

    // The finder hands back the very catalogue entry, so callers always see
    // one source of truth per provider id.
    for (const provider of OPENCLAW_CLI_PROVIDERS) {
      expect(findOpenClawCliProviderById(provider.id)).toBe(provider)
    }
    expect(findOpenClawCliProviderById('no-such-cli')).toBeUndefined()
  })

  it('buildOpenClawCliProviderOptions expands every provider into one option per model', () => {
    const options = buildOpenClawCliProviderOptions()

    // One option per provider/model pair, keyed `provider/model`, in
    // catalogue order then model order.
    expect(options.map((option) => option.id)).toEqual([
      'claude-cli/claude-sonnet-4-6',
      'claude-cli/claude-opus-4-6',
      'claude-cli/claude-haiku-4-5',
    ])

    // The rule generalises beyond today's data: each option points back at
    // its provider and its model, and the counts match the catalogue.
    expect(options.length).toBe(
      OPENCLAW_CLI_PROVIDERS.reduce(
        (total, provider) => total + provider.models.length,
        0,
      ),
    )
    for (const option of options) {
      const provider = findOpenClawCliProviderById(option.type)
      expect(provider).toBeDefined()
      expect(option.id).toBe(`${option.type}/${option.modelId}`)
      expect(option.name).toBe(provider?.displayName)
      expect(provider?.models).toContain(option.modelId)
    }
  })

  it('useOpenClawCliProviderAuthStatus polls the agent server and surfaces its status or error', async () => {
    const requestedUrls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input))
      if (requestedUrls.length === 1) {
        return jsonResponse({
          installed: true,
          loggedIn: true,
          accountLabel: 'ava@browseros.dev',
          subscriptionLabel: 'Pro',
        })
      }
      if (requestedUrls.length === 2) {
        return jsonResponse({ error: 'gateway did not start' }, 500)
      }
      return new Response('<html>not json</html>', { status: 503 })
    }) as typeof fetch

    try {
      // With a known base URL and enabled, the query is live: it reports
      // itself as fetching from the very first render.
      agentServerUrlResult = {
        baseUrl: 'http://agent.local:1',
        isLoading: false,
        error: null,
      }
      const live = renderAuthStatusHook('claude-cli', true)
      expect(live.fetchStatus).toBe('fetching')
      expect(live.data).toBeUndefined()

      // The first fetch lands on the provider's auth-status route under the
      // agent server base URL, and the server's verdict comes back as data.
      const succeeded = await live.refetch()
      expect(succeeded.status).toBe('success')
      expect(succeeded.data).toEqual({
        installed: true,
        loggedIn: true,
        accountLabel: 'ava@browseros.dev',
        subscriptionLabel: 'Pro',
      })
      expect(requestedUrls).toEqual([
        'http://agent.local:1/claw/providers/claude-cli/auth-status',
      ])

      // A server-side error body is surfaced as the query error, message
      // and all, rather than a generic status line.
      const serverError = await live.refetch()
      expect(serverError.status).toBe('error')
      expect(serverError.error?.message).toBe('gateway did not start')

      // A body the server cannot describe as JSON falls back to the
      // human-readable status line.
      const unparseable = await live.refetch()
      expect(unparseable.status).toBe('error')
      expect(unparseable.error?.message).toBe(
        'Auth status request failed (503)',
      )

      // The query stays dormant while the base URL is still loading, and
      // while the caller has not asked for polling.
      agentServerUrlResult = {
        baseUrl: null,
        isLoading: true,
        error: null,
      }
      const urlPending = renderAuthStatusHook('claude-cli', true)
      expect(urlPending.fetchStatus).toBe('idle')
      expect(urlPending.isPending).toBe(true)

      agentServerUrlResult = {
        baseUrl: 'http://agent.local:1',
        isLoading: false,
        error: null,
      }
      const dormant = renderAuthStatusHook('claude-cli', false)
      expect(dormant.fetchStatus).toBe('idle')
      expect(dormant.isPending).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('OpenClawCliProviderStatusPanel renders one user-visible state per status', () => {
    // While the first check is in flight, the panel says so and offers no
    // connect affordance yet.
    const checking = visibleText(
      renderPanel({ status: undefined, loading: true }),
    )
    expect(checking).toContain('Checking Test CLI status…')
    expect(checking).toContain('animate-spin')
    expect(checking).not.toContain('Connect')

    // A failed check names the provider and the reason.
    const failed = visibleText(
      renderPanel({
        status: undefined,
        loading: false,
        fetchError: new Error('agent server unreachable'),
      }),
    )
    expect(failed).toContain('Could not read Test CLI status')
    expect(failed).toContain('agent server unreachable')

    // No status, no error, not loading: the panel renders nothing at all.
    expect(renderPanel({ status: undefined })).toBe('')

    // A missing binary is reported as a not-installed provider.
    const missing = visibleText(
      renderPanel({ status: { installed: false, loggedIn: false } }),
    )
    expect(missing).toContain('Test CLI not installed')
    expect(missing).toContain(
      'The gateway will try to install it on the next restart.',
    )
    expect(missing).not.toContain('Connect')

    // Logged in, with both labels: the panel names the account and its
    // subscription, and keeps showing them while a re-check runs.
    const connected = visibleText(
      renderPanel({
        status: {
          installed: true,
          loggedIn: true,
          accountLabel: 'ava@browseros.dev',
          subscriptionLabel: 'Pro',
        },
      }),
    )
    expect(connected).toContain('Connected to Test CLI')
    expect(connected).toContain('ava@browseros.dev (Pro)')
    expect(connected).not.toContain('not set up')
    const rechecking = visibleText(
      renderPanel({
        status: {
          installed: true,
          loggedIn: true,
          accountLabel: 'ava@browseros.dev',
          subscriptionLabel: 'Pro',
        },
        loading: true,
      }),
    )
    expect(rechecking).toContain('Connected to Test CLI')
    expect(rechecking).not.toContain('Checking')

    // Logged in, with no labels to show: the panel falls back to Ready.
    const ready = visibleText(
      renderPanel({ status: { installed: true, loggedIn: true } }),
    )
    expect(ready).toContain('Connected to Test CLI')
    expect(ready).toContain('>Ready<')

    // Installed but not logged in: the panel pitches setup, surfaces any
    // provider-reported error, and offers the connect command affordance.
    const setup = visibleText(
      renderPanel({
        status: { installed: true, loggedIn: false, error: 'login timed out' },
      }),
    )
    expect(setup).toContain('Test CLI not set up')
    expect(setup).toContain('A synthetic provider used only by this suite')
    expect(setup).toContain('login timed out')
    expect(setup).toContain('<button')
    expect(setup).toContain('Connect Test CLI')
  })
})
