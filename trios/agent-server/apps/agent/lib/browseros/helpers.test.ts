import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { BROWSEROS_PREFS } from './prefs'

/**
 * Contract tests for `./helpers`, pinning the behaviour that exists today.
 *
 * The module exports seven symbols and each one has an assertion block of its
 * own below, named after the export so a reader can map assertions to
 * exports one-to-one: AgentPortError, McpPortError, ProxyPortError,
 * getAgentServerUrl, getMcpServerUrl, getProxyServerUrl and
 * getHealthCheckUrl.
 *
 * Exports left unexercised: none. Every export could be driven offline, so
 * nothing is silently omitted and the blocked-export count is zero.
 *
 * The module has three live dependencies and each is replaced by an offline
 * double for the duration of this suite:
 *
 * - `@/lib/env` is mocked with a mutable snapshot carrying the same defaults
 *   the real parse produces in a bare process, so the environment fallback
 *   branch can be switched on and off per scenario.
 * - `./capabilities` is mocked so version-gated feature support can be
 *   toggled per scenario. The double delegates to the real module whenever a
 *   toggle is unset and serves the real `Feature` values and the real
 *   `resolveStaticFeatureSupport`, so any importer that resolves the double
 *   still observes genuine behaviour.
 * - The BrowserOS host (`chrome.browserOS`) is a stub backed by an in-memory
 *   preference table, so the real adapter's `getPref` path runs offline.
 *   Withholding the API or serving a non-numeric preference value reproduces
 *   the "host absent" and "host misconfigured" cases.
 *
 * No network, database or container is involved: every URL below is produced
 * from the in-memory table and nothing listens on the ports it names.
 */

/** Snapshot double for `@/lib/env`; only the server port knob ever moves. */
const envDouble = {
  VITE_BROWSEROS_SERVER_PORT: undefined as number | undefined,
  VITE_ALPHA_FEATURES: false,
  VITE_PUBLIC_POSTHOG_KEY: undefined,
  VITE_PUBLIC_POSTHOG_HOST: undefined,
  VITE_PUBLIC_SENTRY_DSN: undefined,
  VITE_PUBLIC_BROWSEROS_API: undefined,
  PROD: false,
}

/**
 * Snapshot of the real capabilities module, captured by value before the
 * double below replaces it in the module registry: bun's mock.module swaps
 * the registry entry for every importer, earlier ones included, so the
 * double must hold direct references rather than live bindings.
 */
const realCapabilities = await import('./capabilities')
const realSupports = realCapabilities.Capabilities.supports.bind(
  realCapabilities.Capabilities,
)
const realResolveStaticFeatureSupport =
  realCapabilities.resolveStaticFeatureSupport
const realFeature: Record<string, string> = { ...realCapabilities.Feature }

/**
 * Feature toggles for the Capabilities double. Undefined means "not pinned
 * by this scenario" and delegates to the real module.
 */
let unifiedPortSupport: boolean | undefined
let proxySupport: boolean | undefined

mock.module('@/lib/env', () => ({ env: envDouble }))

mock.module('./capabilities', () => ({
  Feature: realFeature,
  resolveStaticFeatureSupport: realResolveStaticFeatureSupport,
  Capabilities: {
    supports: async (feature: string): Promise<boolean> => {
      if (feature === realFeature.UNIFIED_PORT_SUPPORT) {
        return unifiedPortSupport ?? realSupports(feature)
      }
      if (feature === realFeature.PROXY_SUPPORT) {
        return proxySupport ?? realSupports(feature)
      }
      return realSupports(feature)
    },
  },
}))

/** A preference value as the host may serve one: numeric, junk, or absent. */
type PrefValue = number | string | undefined

/**
 * Per-scenario knobs. `prefApiAvailable` false makes the host stub raise the
 * same error the real adapter raises when the preference API is missing.
 */
const state = {
  agentPort: undefined as PrefValue,
  mcpPort: undefined as PrefValue,
  proxyPort: undefined as PrefValue,
  prefApiAvailable: true,
}

function prefFor(name: string): { value: PrefValue } | undefined {
  if (name === BROWSEROS_PREFS.AGENT_PORT) {
    return state.agentPort === undefined
      ? undefined
      : { value: state.agentPort }
  }
  if (name === BROWSEROS_PREFS.MCP_PORT) {
    return state.mcpPort === undefined ? undefined : { value: state.mcpPort }
  }
  if (name === BROWSEROS_PREFS.PROXY_PORT) {
    return state.proxyPort === undefined
      ? undefined
      : { value: state.proxyPort }
  }
  return undefined
}

/** Stand-in for the chrome global the real adapter reads preferences from. */
const chromeDouble = {
  runtime: {},
  browserOS: {
    getPref: (name: string, callback: (pref: unknown) => void): void => {
      if (!state.prefApiAvailable) {
        throw new Error('getPref API not available')
      }
      callback(prefFor(name))
    },
  },
}

;(globalThis as { chrome?: unknown }).chrome = chromeDouble

const {
  AgentPortError,
  McpPortError,
  ProxyPortError,
  getAgentServerUrl,
  getMcpServerUrl,
  getProxyServerUrl,
  getHealthCheckUrl,
} = await import('./helpers')

/** Restore the pristine no-host, no-env, everything-delegated baseline. */
function resetState(): void {
  envDouble.VITE_BROWSEROS_SERVER_PORT = undefined
  unifiedPortSupport = undefined
  proxySupport = undefined
  state.agentPort = undefined
  state.mcpPort = undefined
  state.proxyPort = undefined
  state.prefApiAvailable = true
}

describe('helpersContract', () => {
  beforeEach(() => {
    resetState()
  })

  // Leave the process as this suite found it, for the test files that run
  // after this one in the same bun process.
  afterAll(() => {
    resetState()
    delete (globalThis as { chrome?: unknown }).chrome
  })

  describe('getAgentServerUrl', () => {
    it('serves the MCP port while the unified port is supported and the agent port otherwise, failing closed with a typed error when nothing is configured', async () => {
      // Unified port supported: the environment variable wins.
      unifiedPortSupport = true
      envDouble.VITE_BROWSEROS_SERVER_PORT = 41000
      state.mcpPort = 41001
      expect(await getAgentServerUrl()).toBe('http://127.0.0.1:41000')

      // Unified port supported: the MCP preference is the fallback.
      resetState()
      unifiedPortSupport = true
      state.mcpPort = 41002
      expect(await getAgentServerUrl()).toBe('http://127.0.0.1:41002')

      // Unified port supported and the preference host is gone entirely.
      resetState()
      unifiedPortSupport = true
      state.prefApiAvailable = false
      await expect(getAgentServerUrl()).rejects.toBeInstanceOf(McpPortError)

      // Unified port unsupported: the agent preference is used instead.
      resetState()
      unifiedPortSupport = false
      state.agentPort = 41003
      expect(await getAgentServerUrl()).toBe('http://127.0.0.1:41003')

      // Unified port unsupported: the environment variable feeds the agent
      // port too and outranks the preference.
      resetState()
      unifiedPortSupport = false
      envDouble.VITE_BROWSEROS_SERVER_PORT = 41004
      state.agentPort = 41005
      expect(await getAgentServerUrl()).toBe('http://127.0.0.1:41004')

      // Unified port unsupported and nothing configured.
      resetState()
      unifiedPortSupport = false
      await expect(getAgentServerUrl()).rejects.toBeInstanceOf(AgentPortError)

      // Unified port supported but nothing configured.
      resetState()
      unifiedPortSupport = true
      await expect(getAgentServerUrl()).rejects.toBeInstanceOf(McpPortError)

      // A preference that is not a number counts as unconfigured.
      resetState()
      unifiedPortSupport = false
      state.agentPort = 'not-a-port'
      await expect(getAgentServerUrl()).rejects.toBeInstanceOf(AgentPortError)
    })
  })

  describe('getMcpServerUrl', () => {
    it('serves the proxy port under /mcp while proxy support exists and the MCP port otherwise, failing closed with a typed error', async () => {
      // Proxy supported: the proxy preference carries the URL.
      proxySupport = true
      state.proxyPort = 42001
      expect(await getMcpServerUrl()).toBe('http://127.0.0.1:42001/mcp')

      // Proxy supported: the environment variable does not feed the proxy
      // port, so an unset proxy preference still fails closed.
      resetState()
      proxySupport = true
      envDouble.VITE_BROWSEROS_SERVER_PORT = 42002
      await expect(getMcpServerUrl()).rejects.toBeInstanceOf(ProxyPortError)

      // Proxy unsupported: the environment variable feeds the MCP port.
      resetState()
      proxySupport = false
      envDouble.VITE_BROWSEROS_SERVER_PORT = 42003
      expect(await getMcpServerUrl()).toBe('http://127.0.0.1:42003/mcp')

      // Proxy unsupported: the environment variable outranks the MCP
      // preference.
      resetState()
      proxySupport = false
      envDouble.VITE_BROWSEROS_SERVER_PORT = 42004
      state.mcpPort = 42005
      expect(await getMcpServerUrl()).toBe('http://127.0.0.1:42004/mcp')

      // Proxy unsupported: the MCP preference is the fallback.
      resetState()
      proxySupport = false
      state.mcpPort = 42006
      expect(await getMcpServerUrl()).toBe('http://127.0.0.1:42006/mcp')

      // Proxy supported but nothing configured.
      resetState()
      proxySupport = true
      await expect(getMcpServerUrl()).rejects.toBeInstanceOf(ProxyPortError)

      // Proxy unsupported and nothing configured.
      resetState()
      proxySupport = false
      await expect(getMcpServerUrl()).rejects.toBeInstanceOf(McpPortError)
    })
  })

  describe('getProxyServerUrl', () => {
    it('builds a bare URL from the proxy preference alone, ignoring env and MCP state, and fails closed otherwise', async () => {
      // The proxy preference carries a URL with no path suffix.
      state.proxyPort = 43001
      expect(await getProxyServerUrl()).toBe('http://127.0.0.1:43001')

      // Neither the environment variable nor the MCP preference is
      // consulted for the proxy port.
      resetState()
      envDouble.VITE_BROWSEROS_SERVER_PORT = 43002
      state.mcpPort = 43003
      await expect(getProxyServerUrl()).rejects.toBeInstanceOf(ProxyPortError)

      // A missing preference host fails closed the same way.
      resetState()
      state.prefApiAvailable = false
      await expect(getProxyServerUrl()).rejects.toBeInstanceOf(ProxyPortError)

      // A non-numeric preference value counts as unconfigured.
      resetState()
      state.proxyPort = 'not-a-port'
      await expect(getProxyServerUrl()).rejects.toBeInstanceOf(ProxyPortError)

      // A numeric zero preference counts as unconfigured too.
      resetState()
      state.proxyPort = 0
      await expect(getProxyServerUrl()).rejects.toBeInstanceOf(ProxyPortError)
    })
  })

  describe('getHealthCheckUrl', () => {
    it('targets the proxy port under /health while proxy support exists and the MCP port otherwise', async () => {
      // Proxy supported: the health endpoint lives on the proxy port.
      proxySupport = true
      state.proxyPort = 44001
      expect(await getHealthCheckUrl()).toBe('http://127.0.0.1:44001/health')

      // Proxy unsupported: the health endpoint lives on the MCP port.
      resetState()
      proxySupport = false
      state.mcpPort = 44002
      expect(await getHealthCheckUrl()).toBe('http://127.0.0.1:44002/health')

      // Proxy unsupported: the environment variable feeds the MCP port.
      resetState()
      proxySupport = false
      envDouble.VITE_BROWSEROS_SERVER_PORT = 44003
      expect(await getHealthCheckUrl()).toBe('http://127.0.0.1:44003/health')

      // Proxy supported but nothing configured.
      resetState()
      proxySupport = true
      await expect(getHealthCheckUrl()).rejects.toBeInstanceOf(ProxyPortError)

      // Proxy unsupported and nothing configured.
      resetState()
      proxySupport = false
      await expect(getHealthCheckUrl()).rejects.toBeInstanceOf(McpPortError)
    })
  })

  describe('AgentPortError', () => {
    it('is an Error that names itself and says the agent port is missing', () => {
      const error = new AgentPortError()
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('AgentPortError')
      expect(error.message).toBe('Agent server port not configured.')
    })
  })

  describe('McpPortError', () => {
    it('is an Error that names itself and says the MCP port is missing', () => {
      const error = new McpPortError()
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('McpPortError')
      expect(error.message).toBe('MCP server port not configured.')
    })
  })

  describe('ProxyPortError', () => {
    it('is an Error that names itself and says the proxy port is missing', () => {
      const error = new ProxyPortError()
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('ProxyPortError')
      expect(error.message).toBe('Proxy server port not configured.')
    })
  })
})
