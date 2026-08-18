/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * BrowserOS Server Application
 *
 * Manages server lifecycle: initialization, startup, and shutdown.
 */

import fs from 'node:fs'
import path from 'node:path'
import { EXIT_CODES } from '@browseros/shared/constants/exit-codes'
import { createHttpServer } from './api/server'
import {
  configureVmRuntime,
  getOpenClawService,
} from './api/services/openclaw/openclaw-service'
import { CdpBackend } from './browser/backends/cdp'
import { Browser } from './browser/browser'
import type { ServerConfig } from './config'
import { INLINED_ENV } from './env'
import {
  configureClaudeRuntime,
  configureCodexRuntime,
  getHermesRuntime,
  startHermesRuntimeBestEffort,
} from './lib/agents/runtime'
import {
  cleanOldSessions,
  ensureBrowserosDir,
  getDbPath,
  removeServerConfigSync,
  writeServerConfig,
} from './lib/browseros-dir'
import { closeDb, initializeDb } from './lib/db'
import { runPgMigrations } from './lib/db/pg-migrate'
import { identity } from './lib/identity'
import { logger } from './lib/logger'
import { metrics } from './lib/metrics'
import { isPortInUseError } from './lib/port-binding'
import { Sentry } from './lib/sentry'
import { seedSoulTemplate } from './lib/soul'
import { migrateBuiltinSkills } from './skills/migrate'
import {
  startSkillSync,
  stopSkillSync,
  syncBuiltinSkills,
} from './skills/remote-sync'
import { registry } from './tools/registry'
import { VERSION } from './version'

export class Application {
  private config: ServerConfig
  private httpServer: Awaited<ReturnType<typeof createHttpServer>> | null = null
  private a2aService:
    | Awaited<ReturnType<typeof createHttpServer>>['a2aService']
    | null = null
  private taskQueueService:
    | Awaited<ReturnType<typeof createHttpServer>>['taskQueueService']
    | null = null

  constructor(config: ServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    logger.info(`Starting BrowserOS Server v${VERSION}`)
    logger.debug('Directory config', {
      executionDir: path.resolve(this.config.executionDir),
      resourcesDir: path.resolve(this.config.resourcesDir),
    })

    const resourcesDir = path.resolve(this.config.resourcesDir)
    configureClaudeRuntime()
    configureCodexRuntime()
    try {
      await this.initCoreServices()
    } catch (err) {
      logger.warn('Core service initialization failed, continuing', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await runPgMigrations()

    if (!this.config.cdpPort) {
      logger.error('CDP port is required (--cdp-port)')
      process.exit(EXIT_CODES.GENERAL_ERROR)
    }

    const cdp = new CdpBackend({ port: this.config.cdpPort })
    // A browser that is not there yet is not a reason to refuse to start.
    //
    // This used to exit. The asymmetry was the problem: once running, the
    // server tolerates losing CDP perfectly well - /health reports
    // cdpConnected:false and stays ok - but it would not START without it. So
    // after a reboot, with no browser up, the server died on launch, the
    // supervisor had nothing to talk to, and "it worked yesterday" and "it
    // refuses to start today" were both true.
    //
    // Now it starts, serves everything that needs no browser, and keeps trying
    // in the background. Tools that need a browser fail per-request, which is
    // the same thing that happens when the browser goes away mid-session.
    let cdpConnected = false
    try {
      logger.debug(`Connecting to CDP on port ${this.config.cdpPort}`)
      await cdp.connect()
      cdpConnected = true
      logger.info(`Connected to CDP on port ${this.config.cdpPort}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(
        `CDP is not reachable on port ${this.config.cdpPort}; starting without a browser and retrying in the background`,
        { error: message },
      )
      void (async () => {
        while (!cdpConnected) {
          await new Promise((resolve) => setTimeout(resolve, 10_000))
          try {
            await cdp.connect()
            cdpConnected = true
            logger.info(
              `Connected to CDP on port ${this.config.cdpPort} after retrying`,
            )
          } catch {
            // Still nothing. The next tick will try again.
          }
        }
      })()
    }

    const browser = new Browser(cdp)

    logger.info(`Loaded ${registry.names().length} unified tools`)

    try {
      this.httpServer = await createHttpServer({
        port: this.config.serverPort,
        host: '127.0.0.1',
        version: VERSION,
        browser,
        registry,
        browserosId: identity.getBrowserOSId(),
        executionDir: this.config.executionDir,
        resourcesDir: this.config.resourcesDir,
        codegenServiceUrl: this.config.codegenServiceUrl,
        aiSdkDevtoolsEnabled: this.config.aiSdkDevtoolsEnabled,

        onShutdown: () => this.stop('shutdown-endpoint'),
      })
      this.a2aService = this.httpServer.a2aService
      this.taskQueueService = this.httpServer.taskQueueService
    } catch (error) {
      logger.warn('HTTP server failed to start, continuing without it', {
        error: error instanceof Error ? error.message : String(error),
      })
      this.httpServer = null
    }

    try {
      await writeServerConfig({
        server_port: this.config.serverPort,
        url: `http://127.0.0.1:${this.config.serverPort}`,
        server_version: VERSION,
        browseros_version: this.config.instanceBrowserosVersion,
        chromium_version: this.config.instanceChromiumVersion,
        browseros_id: identity.getBrowserOSId(),
      })
    } catch (error) {
      logger.warn('Failed to write server config for auto-discovery', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    this.logStartupSummary()
    startSkillSync()

    // OpenClaw is best-effort; a failure here must not crash the server.
    // The container runtime constructor throws synchronously on non-darwin
    // (e.g. Linux CI runners), and the .catch() on tryAutoStart() only
    // handles async throws inside auto-start. Wrap both in try/catch so the
    // process keeps running even when OpenClaw can't initialize at all.
    try {
      const openClawService = configureVmRuntime({ resourcesDir })
      // The service may expose configure synchronously (production) or be a
      // minimal stub in tests. Guard the call so tests don't trigger a spurious
      // best-effort warning when the method is absent.
      if (typeof openClawService.configure === 'function') {
        openClawService.configure({
          browserosServerPort: this.config.serverPort,
        })
      }
      void openClawService.prewarm().catch((err) =>
        logger.warn('OpenClaw prewarm failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      void openClawService.tryAutoStart().catch((err) =>
        logger.warn('OpenClaw auto-start failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } catch (err) {
      logger.warn('OpenClaw configuration failed, continuing without it', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    startHermesRuntimeBestEffort({ resourcesDir })

    metrics.log('http_server.started', { version: VERSION })
  }

  async stop(reason?: string): Promise<void> {
    logger.info('Shutting down server...', { reason })
    stopSkillSync()
    getOpenClawService()
      .shutdown()
      .catch(() => {})
    getHermesRuntime()
      ?.executeAction({ type: 'stop' })
      .catch(() => {})
    removeServerConfigSync()

    // Best-effort cleanup of DB and background services with a hard ceiling so
    // Chromium-triggered shutdowns do not hang waiting for a stuck connection.
    const drain = async () => {
      try {
        closeDb()
      } catch {
        // Ignore close errors during shutdown.
      }
      if (this.a2aService) {
        this.a2aService.destroy()
      }
      if (this.taskQueueService) {
        await this.taskQueueService.shutdown()
      }
    }

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))
    await Promise.race([drain(), sleep(2000)])

    // Immediate exit without graceful shutdown. Chromium may kill us on update/restart,
    // and we need to free the port instantly so the HTTP port doesn't keep switching.
    // Exit 0 only for managed shutdowns (POST /shutdown from Chromium).
    // Signal kills exit non-zero so Chromium's OnProcessExited restarts us.
    const code =
      reason === 'SIGTERM' || reason === 'SIGINT'
        ? EXIT_CODES.SIGNAL_KILL
        : EXIT_CODES.SUCCESS
    process.exit(code)
  }

  private async initCoreServices(): Promise<void> {
    this.configureLogDirectory()
    await ensureBrowserosDir()
    await cleanOldSessions()
    await seedSoulTemplate()
    await migrateBuiltinSkills()
    await syncBuiltinSkills()

    initializeDb({
      dbPath: getDbPath(),
      resourcesDir: this.config.resourcesDir,
    })

    identity.initialize({
      installId: this.config.instanceInstallId,
      statePath: path.join(
        this.config.executionDir,
        'identity',
        'browseros-id.json',
      ),
    })

    const browserosId = identity.getBrowserOSId()
    logger.info('BrowserOS ID initialized', {
      browserosId: browserosId.slice(0, 12),
      fromConfig: !!this.config.instanceInstallId,
    })

    metrics.initialize({
      client_id: this.config.instanceClientId,
      install_id: this.config.instanceInstallId,
      browseros_version: this.config.instanceBrowserosVersion,
      chromium_version: this.config.instanceChromiumVersion,
      server_version: VERSION,
    })

    if (!metrics.isEnabled()) {
      logger.warn('Metrics disabled: missing POSTHOG_API_KEY')
    }

    if (!INLINED_ENV.SENTRY_DSN) {
      logger.debug('Sentry disabled: missing SENTRY_DSN')
    }

    Sentry.setUser({ id: browserosId })
    Sentry.setContext('browseros', {
      client_id: this.config.instanceClientId,
      install_id: this.config.instanceInstallId,
      browseros_version: this.config.instanceBrowserosVersion,
      chromium_version: this.config.instanceChromiumVersion,
      server_version: VERSION,
    })
  }

  private configureLogDirectory(): void {
    const logDir = this.config.executionDir
    const resolvedDir = path.isAbsolute(logDir)
      ? logDir
      : path.resolve(process.cwd(), logDir)

    try {
      fs.mkdirSync(resolvedDir, { recursive: true })
      logger.setLogFile(resolvedDir)
    } catch (error) {
      console.warn(
        `Failed to configure log directory ${resolvedDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  private handleStartupError(
    serverName: string,
    port: number,
    error: unknown,
  ): never {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to start ${serverName}`, { port, error: errorMsg })
    console.error(
      `[FATAL] Failed to start ${serverName} on port ${port}: ${errorMsg}`,
    )

    if (isPortInUseError(error)) {
      console.error(
        `[FATAL] Port ${port} is already in use. Chromium should try a different port.`,
      )
      process.exit(EXIT_CODES.PORT_CONFLICT)
    }

    Sentry.captureException(error)
    process.exit(EXIT_CODES.GENERAL_ERROR)
  }

  private logStartupSummary(): void {
    logger.info('')
    logger.info('Services running:')
    if (this.httpServer?.server) {
      logger.info(`  HTTP Server: http://127.0.0.1:${this.config.serverPort}`)
      logger.info(
        `  Health endpoint: http://127.0.0.1:${this.config.serverPort}/health`,
      )
    } else {
      logger.info('  HTTP server unavailable')
    }
    logger.info('')
  }
}
