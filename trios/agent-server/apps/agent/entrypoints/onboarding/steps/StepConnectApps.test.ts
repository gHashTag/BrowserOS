/**
 * Contract suite for the exports of StepConnectApps.tsx.
 *
 * The module exports exactly one symbol: `StepConnectApps`. Every assertion
 * below renders or drives that export and asserts on what a user can
 * observe: the markup it emits, the connection states it shows, the OAuth
 * hand-off it performs when an app is connected, the analytics it reports,
 * and the `onContinue` callback it fires when the step is finished.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`StepConnectApps`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies - the agent server behind the
 * managed-server mutation and the integrations query, the extension
 * storage behind `useMcpServers`, the metrics adapter behind `track`, and
 * Sentry - are swapped for in-memory stubs via `mock.module`, so this
 * suite needs no network, no database and no container.
 *
 * Not pinned, and why: two `useEffect` behaviours cannot be observed with
 * the renderers this project ships. `renderToString` from
 * `react-dom/server` is the only renderer available to `bun test` here -
 * `@testing-library/react`, `happy-dom`, `jsdom` and `react-test-renderer`
 * are all absent from the lockfile - and server rendering never runs
 * effects. So the mount-time `onboarding.connect_apps.viewed` report and
 * the 3-second integrations polling loop (including its
 * stop-once-both-recommended-apps-are-connected rule) are unpinned. That
 * is a gap in effect coverage, not an export left unexercised: the export
 * itself is rendered, driven and asserted on, so no export belongs in the
 * blocked list above.
 *
 * Interactions are driven through the click handlers the component itself
 * attaches to its rendered controls, captured via the Button seam - the
 * same seam a real click travels. `window.open` is stubbed only around
 * the connect hand-off, because framer-motion's server render requires
 * `window` to be absent while the tree is being rendered.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

type Integration = { name: string; is_authenticated: boolean }

type ManagedServer = {
  id: string
  displayName: string
  type: 'managed' | 'custom'
  managedServerName?: string
  managedServerDescription?: string
}

// Hook results are held in variables so each scenario below can stage the
// world the component should react to before rendering it.
let integrations: Integration[] = []
let integrationsLoading = false
let servers: ManagedServer[] = []
let connectBehaviour: (arg: { serverName: string }) => Promise<{
  oauthUrl?: string
}>

const trackCalls: Array<[string, Record<string, unknown> | undefined]> = []
const sentryCalls: Array<[unknown, unknown]> = []
const addServerCalls: ManagedServer[] = []
const connectCalls: Array<{ serverName: string }> = []
const timeline: string[] = []
let onContinueCount = 0

// Each mock spreads the real module's exports and overrides only the
// members this suite needs to control, because Bun module mocks persist
// for the whole test run: later suites in the same process must still see
// every other export these modules ship. `@/lib/mcp/mcpServerStorage` is
// the one exception - its real module needs browser storage and cannot be
// imported under `bun test` at all - and no other suite's import graph
// reaches this module, so a full stub is safe there.
const realTrackModule = await import('@/lib/metrics/track')
const realSentryModule = await import('@/lib/sentry/sentry')
const realAddManagedServerModule = await import(
  '@/entrypoints/app/connect-mcp/useAddManagedServer'
)
const realIntegrationsModule = await import(
  '@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations'
)

mock.module('@/lib/metrics/track', () => ({
  ...realTrackModule,
  track: (eventName: string, properties?: Record<string, unknown>) => {
    trackCalls.push([eventName, properties])
    timeline.push(`track:${eventName}`)
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  ...realSentryModule,
  sentry: {
    ...realSentryModule.sentry,
    captureException: (error: unknown, hint?: unknown) => {
      sentryCalls.push([error, hint])
    },
  },
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  useMcpServers: () => ({
    servers,
    addServer: async (server: ManagedServer) => {
      addServerCalls.push(server)
    },
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useAddManagedServer', () => ({
  ...realAddManagedServerModule,
  useAddManagedServer: () => ({
    trigger: (arg: { serverName: string }) => {
      connectCalls.push(arg)
      return connectBehaviour(arg)
    },
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  ...realIntegrationsModule,
  useGetUserMCPIntegrations: () => ({
    data: { integrations },
    isLoading: integrationsLoading,
    mutate: () => {},
  }),
}))

type CapturedButton = {
  children?: ReactNode
  disabled?: boolean
  onClick?: () => void | Promise<void>
}

type ButtonProps = CapturedButton & {
  variant?: string
  size?: string
  [key: string]: unknown
}

const renderedButtons: CapturedButton[] = []

// The Button seam both renders a real control - forwarding every prop the
// component attaches, so markup assertions hold for this suite and for any
// later suite in the same run - and records the handlers the component
// attaches, so controls can be driven the way a click would. The real
// module's other exports, such as `buttonVariants` used by sibling UI
// widgets, pass through untouched.
const realButtonModule = await import('@/components/ui/button')

mock.module('@/components/ui/button', () => ({
  ...realButtonModule,
  Button: (props: ButtonProps) => {
    renderedButtons.push(props)
    const { variant: _variant, size: _size, ...rest } = props
    return createElement('button', { type: 'button', ...rest })
  },
}))

const { StepConnectApps } = await import('./StepConnectApps')

const labelOf = (button: CapturedButton): string =>
  typeof button.children === 'string' ? button.children : '<spinner>'

const controlsLabelled = (text: string): CapturedButton[] =>
  renderedButtons.filter((button) => labelOf(button) === text)

const renderStep = (direction: -1 | 1): string => {
  renderedButtons.length = 0
  return renderToString(
    createElement(StepConnectApps, {
      direction,
      onContinue: () => {
        onContinueCount += 1
        timeline.push('on-continue')
      },
    }),
  )
}

const spinnerCount = (html: string): number =>
  (html.match(/animate-spin/g) ?? []).length

const connectedBadgeCount = (html: string): number =>
  (html.match(/Connected/g) ?? []).length

// React renders a disabled control as disabled=""; the word "disabled" also
// appears inside Tailwind class names (disabled:opacity-60), so the empty
// attribute value is what identifies a genuinely locked control.
const disabledControlCount = (html: string): number =>
  (html.match(/<button[^>]* disabled=""/g) ?? []).length

const trackedEvents = (eventName: string): number =>
  trackCalls.filter(([name]) => name === eventName).length

describe('StepConnectAppsTsxContract', () => {
  it('pins the exported StepConnectApps component: rendered layout, connection states, the connect hand-off, and the Continue/Skip flow controls', async () => {
    // --- Layout: nothing connected yet ---
    integrations = []
    integrationsLoading = false
    servers = []
    const plain = renderStep(1)

    expect(plain).toContain('Connect your apps')
    expect(plain).toContain(
      'Let your assistant work with your email, calendar, and more',
    )
    expect(plain).toContain('Recommended')
    expect(plain).toContain('Gmail')
    expect(plain).toContain('Read and send emails')
    expect(plain).toContain('Google Calendar')
    expect(plain).toContain('View and manage events')
    expect(plain).toContain('More apps')
    for (const appName of [
      'Notion',
      'Slack',
      'GitHub',
      'Linear',
      'Jira',
      'Google Docs',
    ]) {
      expect(plain).toContain(appName)
    }
    expect(plain).toContain('40+ apps available in Settings')
    // Every app row carries its branded icon.
    expect(plain).toContain('alt="Gmail"')
    expect(plain).toContain('alt="Google Calendar"')
    expect(plain).toContain('alt="Slack"')
    // A Connect control per recommended app, plus the flow controls.
    expect(controlsLabelled('Connect').length).toBe(2)
    expect(controlsLabelled('Continue').length).toBe(1)
    expect(controlsLabelled('Skip for now').length).toBe(1)
    expect(connectedBadgeCount(plain)).toBe(0)
    expect(spinnerCount(plain)).toBe(0)
    expect(disabledControlCount(plain)).toBe(0)
    // The step slides in from the right for a forward direction...
    expect(plain).toContain('translateX(1000px)')

    // --- Direction: the same step slides in from the left going back ---
    const backwards = renderStep(-1)
    expect(backwards).toContain('translateX(-1000px)')
    expect(backwards).not.toContain('translateX(1000px)')

    // --- Loading: spinners stand in for the Connect controls ---
    integrationsLoading = true
    const loading = renderStep(1)
    expect(spinnerCount(loading)).toBe(2)
    expect(controlsLabelled('Connect').length).toBe(0)
    expect(controlsLabelled('Continue').length).toBe(1)
    expect(loading).toContain('Connect your apps')
    integrationsLoading = false

    // --- Connected: an authenticated recommended app shows its badge and
    // --- loses its Connect control
    integrations = [{ name: 'Gmail', is_authenticated: true }]
    const gmailConnected = renderStep(1)
    expect(connectedBadgeCount(gmailConnected)).toBe(1)
    expect(controlsLabelled('Connect').length).toBe(1)

    // --- A signed-out integration does not count as connected ---
    integrations = [{ name: 'Gmail', is_authenticated: false }]
    const signedOut = renderStep(1)
    expect(connectedBadgeCount(signedOut)).toBe(0)
    expect(controlsLabelled('Connect').length).toBe(2)

    // --- A connected app in the More-apps grid is locked ---
    integrations = [{ name: 'Notion', is_authenticated: true }]
    const notionConnected = renderStep(1)
    expect(disabledControlCount(notionConnected)).toBe(1)
    expect(controlsLabelled('Connect').length).toBe(2)

    // --- Connect hand-off: full OAuth path for a recommended app ---
    integrations = []
    connectBehaviour = async () => ({ oauthUrl: 'https://oauth.example/gmail' })
    renderStep(1)
    const openCalls: Array<[string, string]> = []
    let focusCount = 0
    // framer-motion's server render needs `window` absent, so the stub is
    // installed only around the interaction itself.
    ;(globalThis as { window?: unknown }).window = {
      open: (url: string, target: string) => {
        openCalls.push([url, target])
        return { focus: () => (focusCount += 1) }
      },
    }
    try {
      await controlsLabelled('Connect')[0].onClick?.()
    } finally {
      delete (globalThis as { window?: unknown }).window
    }

    expect(connectCalls).toEqual([{ serverName: 'Gmail' }])
    expect(addServerCalls.length).toBe(1)
    expect(typeof addServerCalls[0].id).toBe('string')
    expect(addServerCalls[0].displayName).toBe('Gmail')
    expect(addServerCalls[0].type).toBe('managed')
    expect(addServerCalls[0].managedServerName).toBe('Gmail')
    expect(addServerCalls[0].managedServerDescription).toBe(
      'Read and send emails',
    )
    expect(openCalls).toEqual([['https://oauth.example/gmail', '_blank']])
    expect(focusCount).toBe(1)
    expect(trackedEvents('onboarding.app.connected')).toBe(1)
    expect(sentryCalls.length).toBe(0)
    // Connecting an app does not finish the step.
    expect(onContinueCount).toBe(0)

    // --- The server registration is skipped when the managed server
    // --- already exists, and a response without an OAuth URL opens no tab
    servers = [
      {
        id: 'existing',
        displayName: 'Gmail',
        type: 'managed',
        managedServerName: 'Gmail',
      },
    ]
    connectBehaviour = async () => ({})
    renderStep(1)
    await controlsLabelled('Connect')[0].onClick?.()
    expect(connectCalls).toEqual([
      { serverName: 'Gmail' },
      { serverName: 'Gmail' },
    ])
    expect(addServerCalls.length).toBe(1)
    expect(trackedEvents('onboarding.app.connected')).toBe(2)
    expect(openCalls.length).toBe(1)

    // --- A failed hand-off is contained: reported to Sentry, no analytics,
    // --- no crash
    servers = []
    const handshakeFailure = new Error('klavis rejected the handshake')
    connectBehaviour = async () => {
      throw handshakeFailure
    }
    renderStep(1)
    await controlsLabelled('Connect')[1].onClick?.()
    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0][0]).toBe(handshakeFailure)
    expect(sentryCalls[0][1]).toEqual({
      extra: {
        message: 'Failed to connect app during onboarding',
        appName: 'Google Calendar',
      },
    })
    expect(trackedEvents('onboarding.app.connected')).toBe(2)
    expect(onContinueCount).toBe(0)

    // --- Continue: reports the step with its connection state, then
    // --- advances
    integrations = [{ name: 'Gmail', is_authenticated: true }]
    renderStep(1)
    await controlsLabelled('Continue')[0].onClick?.()
    expect(trackCalls.at(-1)).toEqual([
      'onboarding.step.completed',
      {
        step: 3,
        step_name: 'connect_apps',
        gmail_connected: true,
        calendar_connected: false,
      },
    ])
    expect(timeline.at(-2)).toBe('track:onboarding.step.completed')
    expect(timeline.at(-1)).toBe('on-continue')
    expect(onContinueCount).toBe(1)

    // --- Skip: reports the skip, then advances ---
    integrations = []
    renderStep(1)
    await controlsLabelled('Skip for now')[0].onClick?.()
    expect(trackCalls.at(-2)?.[0]).toBe('onboarding.connect_apps.skipped')
    expect(trackCalls.at(-1)).toEqual([
      'onboarding.step.completed',
      { step: 3, step_name: 'connect_apps', skipped: true },
    ])
    expect(timeline.slice(-3)).toEqual([
      'track:onboarding.connect_apps.skipped',
      'track:onboarding.step.completed',
      'on-continue',
    ])
    expect(onContinueCount).toBe(2)
  })
})
