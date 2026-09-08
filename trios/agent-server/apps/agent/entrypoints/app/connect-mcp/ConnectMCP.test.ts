/**
 * Contract suite for the single export of ConnectMCP.tsx (the ConnectMCP
 * component). The suite runs with no network, database or container: every
 * collaborator that would touch the browser extension APIs, the agent server
 * or analytics (useMcpServers, the SWR/react-query hooks, toast, sentry,
 * track, and the dialog/list child components) is replaced by an in-memory
 * stand-in, and the component is rendered through react-dom/server.
 *
 * The export ConnectMCP is exercised end-to-end below: what it renders for a
 * given storage/integration state, what it passes to its children, and what
 * its handed-out callbacks do to storage, analytics and the toast channel.
 * Flows that can only be started by a real click inside a live dialog (which
 * needs a DOM event loop) are pinned at the level of the callbacks the
 * component itself passes to those dialogs, which is the same code path a
 * click would take.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CUSTOM_MCP_ADDED_EVENT,
  MANAGED_MCP_ADDED_EVENT,
} from '@/lib/constants/analyticsEvents'
import type { McpServer } from '@/lib/mcp/mcpServerStorage'

type PropBag = Record<string, unknown>

const availableProps: PropBag[] = []
const managedDialogProps: PropBag[] = []
const customDialogProps: PropBag[] = []
const apiKeyDialogProps: PropBag[] = []

const trackCalls: Array<[string, Record<string, unknown> | undefined]> = []
const toastErrors: string[] = []
const toastSuccesses: string[] = []
const capturedErrors: unknown[] = []
const openedWindows: Array<{ url: string; target: string; focused: boolean }> =
  []

let storedServers: McpServer[] = []
let catalogueData:
  | { servers: Array<{ name: string; description: string }> }
  | undefined
let integrationsData:
  | { integrations: Array<{ name: string; is_authenticated: boolean }> }
  | undefined
let integrationsLoading = true
let addManagedResponse: { apiKeyUrl?: string; oauthUrl?: string } = {}
let addManagedError: Error | null = null

function stubComponent(log: PropBag[], marker: string) {
  return function Stubbed(props: PropBag) {
    log.push(props)
    return createElement('div', { 'data-stub': marker })
  }
}

mock.module('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message)
    },
    success: (message: string) => {
      toastSuccesses.push(message)
    },
  },
}))

mock.module('@/lib/metrics/track', () => ({
  track: (eventName: string, properties?: Record<string, unknown>) => {
    trackCalls.push([eventName, properties])
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (error: unknown) => {
      capturedErrors.push(error)
    },
  },
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  useMcpServers: () => ({
    servers: storedServers,
    addServer: async (server: McpServer) => {
      storedServers = [...storedServers, server]
    },
    removeServer: async (id: string) => {
      storedServers = storedServers.filter((server) => server.id !== id)
    },
  }),
}))

mock.module('@/lib/mcp/useSyncRemoteIntegrations', () => ({
  useSyncRemoteIntegrations: () => ({ isSyncing: false, hasSynced: true }),
}))

mock.module('./useAddManagedServer', () => ({
  useAddManagedServer: () => ({
    trigger: async (arg: { serverName: string }) => {
      if (addManagedError) throw addManagedError
      return {
        success: true,
        serverName: arg.serverName,
        strataId: 'test',
        addedServers: [],
        ...addManagedResponse,
      }
    },
  }),
}))

mock.module('./useRemoveManagedServer', () => ({
  useRemoveManagedServer: () => ({
    trigger: async () => ({ success: true, serverName: 'test' }),
  }),
}))

mock.module('./useSubmitApiKey', () => ({
  useSubmitApiKey: () => ({
    trigger: async () => ({ success: true, serverName: 'test' }),
    isMutating: false,
  }),
}))

mock.module('./useGetMCPServersList', () => ({
  useGetMCPServersList: () => ({ data: catalogueData }),
}))

mock.module('./useGetUserMCPIntegrations', () => ({
  useGetUserMCPIntegrations: () => ({
    data: integrationsData,
    isLoading: integrationsLoading,
    mutate: () => {},
  }),
}))

mock.module('./AvailableManagedServers', () => ({
  AvailableManagedServers: stubComponent(
    availableProps,
    'available-managed-servers',
  ),
}))

mock.module('./AddManagedMCPDialog', () => ({
  AddManagedMCPDialog: stubComponent(
    managedDialogProps,
    'add-managed-mcp-dialog',
  ),
}))

mock.module('./AddCustomMCPDialog', () => ({
  AddCustomMCPDialog: stubComponent(customDialogProps, 'add-custom-mcp-dialog'),
}))

mock.module('./ApiKeyDialog', () => ({
  ApiKeyDialog: stubComponent(apiKeyDialogProps, 'api-key-dialog'),
}))

mock.module('./McpServerIcon', () => ({
  McpServerIcon: (props: { serverName: string }) =>
    createElement('span', { 'data-server-icon': props.serverName }),
}))

const { ConnectMCP } = await import('./ConnectMCP')

function clearRenderLogs() {
  availableProps.length = 0
  managedDialogProps.length = 0
  customDialogProps.length = 0
  apiKeyDialogProps.length = 0
}

function renderScreen() {
  clearRenderLogs()
  return renderToStaticMarkup(createElement(ConnectMCP))
}

function lastOf(log: PropBag[]): PropBag {
  const entry = log.at(-1)
  if (!entry) throw new Error('no render recorded yet')
  return entry
}

describe('ConnectMCPTsxContract', () => {
  it('ConnectMCP renders the connected-apps screen, filters the catalogue against stored apps, reflects remote auth state, and persists added apps through storage and analytics', async () => {
    const previousWindow = Reflect.get(globalThis, 'window')
    Reflect.set(globalThis, 'window', {
      open: (url: string, target: string) => {
        const entry = { url, target, focused: false }
        openedWindows.push(entry)
        return {
          focus: () => {
            entry.focused = true
          },
        }
      },
    })

    try {
      // Fresh screen: header and both entry points, no connected list yet,
      // and every dialog starts closed.
      const emptyScreen = renderScreen()
      expect(emptyScreen).toContain('Connected Apps')
      expect(emptyScreen).toContain('Add built-in app')
      expect(emptyScreen).toContain('Add custom app')
      expect(emptyScreen).not.toContain('Your Connected Apps')
      expect(lastOf(customDialogProps).open).toBe(false)
      expect(lastOf(managedDialogProps).open).toBe(false)
      expect(lastOf(apiKeyDialogProps).open).toBe(false)
      expect(lastOf(apiKeyDialogProps).serverName).toBe('')
      expect(lastOf(apiKeyDialogProps).isSubmitting).toBe(false)
      expect(lastOf(availableProps).isLoading).toBe(false)

      // A populated screen: rows for each stored app, catalogue entries the
      // user already has are withheld, remote auth state drives each row.
      catalogueData = {
        servers: [
          { name: 'gmail', description: 'Email' },
          { name: 'notion', description: 'Notes' },
        ],
      }
      integrationsLoading = false
      integrationsData = {
        integrations: [{ name: 'slack', is_authenticated: true }],
      }
      storedServers = [
        {
          id: 'srv-gmail',
          displayName: 'Gmail',
          type: 'managed',
          managedServerName: 'gmail',
          managedServerDescription: 'Google Mail',
        },
        {
          id: 'srv-slack',
          displayName: 'Slack',
          type: 'managed',
          managedServerName: 'slack',
          managedServerDescription: '',
        },
        {
          id: 'srv-relay',
          displayName: 'Local Relay',
          type: 'custom',
          config: { url: 'https://relay.internal/mcp', description: '' },
        },
      ]

      const populatedScreen = renderScreen()
      expect(populatedScreen).toContain('Your Connected Apps')
      expect(populatedScreen).toContain('Gmail')
      expect(populatedScreen).toContain('Built-in')
      expect(populatedScreen).toContain('Custom')
      expect(populatedScreen).toContain('Google Mail')
      expect(populatedScreen).toContain('data-server-icon="gmail"')
      // A custom row with an empty description falls back to showing its URL.
      expect(populatedScreen).toContain('https://relay.internal/mcp')
      // Slack is authenticated remotely; Gmail is not and offers the action.
      expect(populatedScreen).toContain('Authenticated')
      expect(populatedScreen).toContain('>Authenticate<')
      // The catalogue and the re-auth list only mention apps that qualify.
      expect(lastOf(availableProps).availableServers).toEqual([
        { name: 'notion', description: 'Notes' },
      ])
      expect(lastOf(managedDialogProps).serversList).toEqual([
        { name: 'notion', description: 'Notes' },
      ])
      expect(lastOf(managedDialogProps).unauthenticatedServers).toEqual([
        { name: 'gmail', description: 'Google Mail' },
      ])

      // While remote auth state is still loading, no verdict is rendered.
      integrationsLoading = true
      const loadingScreen = renderScreen()
      expect(loadingScreen).not.toContain('>Authenticate<')
      expect(loadingScreen).not.toContain('Authenticated')
      expect(loadingScreen).toContain('animate-spin')
      integrationsLoading = false

      // Adding a custom app through the callback handed to the custom dialog
      // persists the server, reports the analytics event, and the next render
      // shows the row.
      storedServers = []
      trackCalls.length = 0
      const addCustomApp = lastOf(customDialogProps).onAddServer as (
        config: { name: string; url: string; description: string },
      ) => void
      addCustomApp({
        name: 'Local Relay',
        url: 'https://relay.internal/mcp',
        description: 'Dev relay',
      })
      expect(storedServers).toEqual([
        expect.objectContaining({
          displayName: 'Local Relay',
          type: 'custom',
          config: {
            url: 'https://relay.internal/mcp',
            description: 'Dev relay',
          },
        }),
      ])
      expect(trackCalls.map(([name]) => name)).toEqual([
        CUSTOM_MCP_ADDED_EVENT,
      ])
      const afterCustomAdd = renderScreen()
      expect(afterCustomAdd).toContain('Your Connected Apps')
      expect(afterCustomAdd).toContain('Local Relay')
      expect(afterCustomAdd).toContain('Dev relay')

      // Adding a built-in app through the catalogue callback persists the
      // managed server, reports the event with the server name, and opens the
      // OAuth URL in a focused new tab.
      trackCalls.length = 0
      addManagedResponse = { oauthUrl: 'https://auth.example/start' }
      const addManagedApp = lastOf(availableProps).onAddServer as (
        server: { name: string; description: string },
      ) => Promise<void>
      await addManagedApp({ name: 'notion', description: 'Notes' })
      expect(storedServers.at(-1)).toEqual(
        expect.objectContaining({
          displayName: 'notion',
          type: 'managed',
          managedServerName: 'notion',
          managedServerDescription: 'Notes',
        }),
      )
      expect(trackCalls.map(([name]) => name)).toEqual([
        MANAGED_MCP_ADDED_EVENT,
      ])
      expect(trackCalls[0]?.[1]).toEqual({ server_name: 'notion' })
      expect(openedWindows).toEqual([
        { url: 'https://auth.example/start', target: '_blank', focused: true },
      ])
      const afterManagedAdd = renderScreen()
      expect(afterManagedAdd).toContain('notion')

      // A failed add reports the failure and leaves storage untouched.
      const storedBeforeFailure = storedServers.length
      trackCalls.length = 0
      addManagedError = new Error('server exploded')
      await addManagedApp({ name: 'linear', description: 'Issues' })
      expect(storedServers.length).toBe(storedBeforeFailure)
      expect(toastErrors).toEqual(['Failed to add app: linear'])
      expect(capturedErrors).toEqual([addManagedError])
      expect(trackCalls).toEqual([])
      addManagedError = null

      // Re-authenticating an app opens its OAuth URL without persisting or
      // reporting anything new.
      const authenticateApp = lastOf(managedDialogProps).onAuthenticate as (
        name: string,
      ) => Promise<void>
      await authenticateApp('gmail')
      expect(openedWindows.at(-1)).toEqual({
        url: 'https://auth.example/start',
        target: '_blank',
        focused: true,
      })
      expect(storedServers.length).toBe(storedBeforeFailure)
      expect(trackCalls).toEqual([])

      // An add that returns no auth URL at all is reported as a failure.
      addManagedResponse = {}
      await authenticateApp('gmail')
      expect(toastErrors.at(-1)).toBe('Failed to add app: gmail')
      expect(capturedErrors.at(-1)).toBe('No auth URL returned')
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, 'window')
      } else {
        Reflect.set(globalThis, 'window', previousWindow)
      }
    }
  })
})
