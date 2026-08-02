/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * Unified test environment orchestrator.
 *
 * Ensures the browser (CDP) is ready and — when the Rust `trios-server`
 * binary is available (TRIOS_SERVER_BIN or PATH) — the production agent
 * server as well. The TS server surface was retired in wave 7; the Rust
 * server is the only server this environment knows how to spawn.
 */
import {
  type BrowserConfig,
  getBrowserState,
  killBrowser,
  spawnBrowser,
} from './browser'
import { createTestRuntimePlan, type TestRuntimePlan } from './test-runtime'
import {
  getServerState,
  killServer,
  resolveTriosServerBin,
  spawnServer,
} from './trios-server'
import { killProcessOnPort } from './utils'

export interface TestEnvironmentConfig {
  cdpPort: number
  serverPort: number
  extensionPort: number
}

let runtimePlan: TestRuntimePlan | null = null
let warnedNoServer = false

function configsMatch(
  a: TestEnvironmentConfig,
  b: TestEnvironmentConfig,
): boolean {
  return (
    a.cdpPort === b.cdpPort &&
    a.serverPort === b.serverPort &&
    a.extensionPort === b.extensionPort
  )
}

/**
 * Ensures the BrowserOS test environment is ready:
 * 1. Browser running with CDP available
 * 2. Rust trios-server running and healthy (when the binary is available;
 *    otherwise browser-only, and server-dependent tests should skip)
 *
 * Reuses existing processes if already running with same config.
 */
export async function ensureBrowserOS(
  options?: Partial<TestEnvironmentConfig>,
): Promise<TestEnvironmentConfig> {
  if (!runtimePlan) {
    runtimePlan = await createTestRuntimePlan()
  }

  const config: TestEnvironmentConfig = {
    cdpPort: options?.cdpPort ?? runtimePlan.ports.cdp,
    serverPort: options?.serverPort ?? runtimePlan.ports.server,
    extensionPort: options?.extensionPort ?? runtimePlan.ports.extension,
  }

  const serverBin = resolveTriosServerBin()
  if (!serverBin && !warnedNoServer) {
    warnedNoServer = true
    console.warn(
      'trios-server binary not found (set TRIOS_SERVER_BIN or add to PATH) — browser-only test environment.',
    )
  }

  // Fast path: already running with same config
  const serverState = getServerState()
  const browserState = getBrowserState()
  const serverReady = serverBin ? serverState !== null : true
  if (
    browserState &&
    serverReady &&
    configsMatch(browserState.config, config) &&
    (!serverState || configsMatch(serverState.config, config))
  ) {
    console.log('Reusing existing test environment')
    return config
  }

  // Config changed or not running: full setup
  console.log('\n=== Setting up BrowserOS test environment ===')

  // 1. Kill conflicting processes on ports
  await killProcessOnPort(config.serverPort)
  await killProcessOnPort(config.extensionPort)
  await killProcessOnPort(config.cdpPort)

  // 2. Start browser first so CDP is available before server startup.
  const browserConfig: BrowserConfig = {
    ...config,
    binaryPath: runtimePlan.binaryPath,
    userDataDir: runtimePlan.userDataDir,
    headless: runtimePlan.headless,
    extraArgs: runtimePlan.extraArgs,
  }
  await spawnBrowser(browserConfig)

  // 3. Start the Rust server once CDP is available (when binary present).
  if (serverBin) {
    await spawnServer(config)
  }

  console.log('=== Test environment ready ===\n')
  return config
}

/**
 * Cleans up the full BrowserOS test environment.
 */
export async function cleanupBrowserOS(): Promise<void> {
  console.log('\n=== Cleaning up BrowserOS test environment ===')
  await killBrowser()
  await killServer()
  runtimePlan = null
  console.log('=== Cleanup complete ===\n')
}
