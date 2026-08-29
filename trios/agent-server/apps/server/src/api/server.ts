/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Consolidated HTTP Server
 *
 * This server combines:
 * - Agent HTTP routes (chat, klavis, provider)
 * - MCP HTTP routes (using @hono/mcp transport)
 */

import { join } from 'node:path'
import { OPENCLAW_GATEWAY_CONTAINER_NAME } from '@browseros/shared/constants/openclaw'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { HttpAgentError } from '../agent/errors'
import { INLINED_ENV } from '../env'
import { KlavisClient } from '../lib/clients/klavis/klavis-client'
import { initializeOAuth, shutdownOAuth } from '../lib/clients/oauth'
import type { OAuthTokenManager } from '../lib/clients/oauth/token-manager'
import { getDb } from '../lib/db'
import { logger } from '../lib/logger'
import { Sentry } from '../lib/sentry'
import { getLimaHomeDir, resolveBundledLimactl, VM_NAME } from '../lib/vm'
import { createA2aRoutes } from './routes/a2a'
import { createAclRoutes } from './routes/acl'
import { createAgentRoutes } from './routes/agents'
import { createChatRoutes } from './routes/chat'
import { createChatHistoryRoutes } from './routes/chat-history'
import { createCreditsRoutes } from './routes/credits'
import { createHealthRoute } from './routes/health'
import { createKlavisRoutes } from './routes/klavis'
import { createLocalAuthRoutes } from './routes/local-auth'
import { createMcpRoutes } from './routes/mcp'
import { createMemoryRoutes } from './routes/memory'
import { createMonitoringRoutes } from './routes/monitoring'
import { createOAuthRoutes } from './routes/oauth'
import { createOpenClawRoutes } from './routes/openclaw'
import { createProviderRoutes } from './routes/provider'
import { createQueenLeaseRoute } from './routes/queen-lease'
import { createQueenRegistryRoute } from './routes/queen-registry'
import { createRefinePromptRoutes } from './routes/refine-prompt'
import { createShutdownRoute } from './routes/shutdown'
import { createSkillsRoutes } from './routes/skills'
import { createSoulRoutes } from './routes/soul'
import { createStatusRoute } from './routes/status'
import { createTaskQueueRoutes } from './routes/tasks'
import { createTerminalRoutes } from './routes/terminal'
import { A2aRegistryService } from './services/a2a/a2a-registry-service'
import { GlobalAclPolicyService } from './services/acl/global-acl-policy'
import {
  connectKlavisInBackground,
  type KlavisProxyRef,
} from './services/klavis/strata-proxy'
import { LocalAuthService } from './services/local-auth-service'
import { convertOpenClawHistoryToAgentHistory } from './services/openclaw/history-mapper'
import { getOpenClawService } from './services/openclaw/openclaw-service'
import { TaskQueueService } from './services/task-queue-service'
import type { Env, HttpServerConfig } from './types'
import { trustedCorsMiddleware } from './utils/cors'
import { requireTrustedAppOrigin } from './utils/request-auth'

async function assertPortAvailable(port: number): Promise<void> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const probe = net.createServer()

    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          Object.assign(new Error(`Port ${port} is already in use`), {
            code: 'EADDRINUSE',
          }),
        )
      } else {
        reject(err)
      }
    })

    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve())
    })
  })
}

export async function createHttpServer(config: HttpServerConfig) {
  const {
    port,
    host = '0.0.0.0',
    browserosId,
    executionDir,
    resourcesDir,
    version,
    browser,
    registry,
  } = config

  const { onShutdown } = config

  // OAuth provider registration is optional; a failure here must not prevent
  // the rest of the server from starting.
  let tokenManager: OAuthTokenManager | null = null
  if (browserosId) {
    try {
      tokenManager = initializeOAuth(getDb(), browserosId)
    } catch (err) {
      logger.warn('OAuth provider registration failed, continuing without it', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else {
    shutdownOAuth()
  }

  const aclPolicyService = new GlobalAclPolicyService()
  try {
    await aclPolicyService.load()
  } catch (err) {
    logger.warn('ACL policy load failed, continuing with default-deny policy', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // A2A registry is optional; fall back to a memory-only service if construction
  // of the PostgreSQL-backed registry fails synchronously.
  let a2aService: A2aRegistryService
  try {
    a2aService = new A2aRegistryService(
      process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined,
    )
  } catch (err) {
    logger.warn(
      'A2A registry construction failed, continuing with memory-only registry',
      {
        error: err instanceof Error ? err.message : String(err),
      },
    )
    a2aService = new A2aRegistryService(undefined)
  }

  // Task queue service is shared across routes and shutdown so the pool can be closed cleanly.
  const taskQueueService = new TaskQueueService({
    databaseUrl: process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || '',
  })

  // Connect Klavis proxy in background with retry — browser tools available immediately
  const klavisRef: KlavisProxyRef = { handle: null }
  let stopKlavisBackground = () => {}
  if (browserosId) {
    try {
      stopKlavisBackground = connectKlavisInBackground(klavisRef, {
        klavisClient: new KlavisClient(),
        browserosId,
      })
    } catch (err) {
      logger.warn('Klavis client connection failed, continuing without it', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // The BrowserOS server package is nested under trios/agent-server;
  // trios state lives in a sibling project root directory.
  const triosStateDir = join(
    executionDir,
    '..',
    '..',
    'trios',
    '.trinity',
    'state',
  )
  // Scoped by port because three variant servers (9105/9205/9305) run at
  // once and issueInitialTokens revokes every family in its store. On a
  // shared file that revocation crossed lanes: the release and dev apps
  // each killed the other's token family every access-token TTL, and both
  // logged "Token refresh failed; bootstrapping a new local-auth family"
  // every ~14 minutes, all night. One file per port keeps the single-tenant
  // contract inside the lane it was designed for.
  const localAuthService = new LocalAuthService({
    dbPath: join(triosStateDir, `local-auth-${port}.sqlite`),
  })
  // The route-audit trail has the same cross-lane problem: all three servers
  // appended to one JSONL, so a reader counting outcomes was reading three
  // servers as one. Same treatment, honoring an explicit override.
  process.env.LOCAL_AUTH_AUDIT_PATH ??= join(
    triosStateDir,
    `local-auth-audit-${port}.jsonl`,
  )

  // The Queen's registry carries every task title, branch and issue the swarm
  // has touched. Mounted unguarded it answered 200 to anyone who asked - I
  // measured it from the open internet minutes after adding it, which is the
  // second time in this deployment that a route was written without the guard
  // its neighbours all carry. The guard is not a detail of the route; it is
  // the reason the route may exist at all.
  const queenLeaseRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route('/', createQueenLeaseRoute())

  const queenRegistryRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route('/', createQueenRegistryRoute())

  const clawRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route('/', createOpenClawRoutes())

  const terminalRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route(
      '/',
      createTerminalRoutes({
        containerName: OPENCLAW_GATEWAY_CONTAINER_NAME,
        limaHome: getLimaHomeDir(),
        limactlPath: () => resolveBundledLimactl(resourcesDir),
        vmName: VM_NAME,
      }),
    )

  const aclRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route('/', createAclRoutes({ policyService: aclPolicyService }))

  const monitoringRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route('/', createMonitoringRoutes())

  const agentRoutes = new Hono<Env>()
    .use('/*', requireTrustedAppOrigin())
    .route(
      '/',
      createAgentRoutes({
        browserosServerPort: port,
        browser,
        openclawGateway: {
          getContainerName: () => OPENCLAW_GATEWAY_CONTAINER_NAME,
          getLimaHomeDir: () => getLimaHomeDir(),
          getLimactlPath: () => resolveBundledLimactl(resourcesDir),
          getVmName: () => VM_NAME,
        },
        openclawProvisioner: {
          createAgent: (input) => getOpenClawService().createAgent(input),
          removeAgent: (agentId) => getOpenClawService().removeAgent(agentId),
          listAgents: async () => {
            const agents = await getOpenClawService().listAgents()
            return agents.map((agent) => ({
              agentId: agent.agentId,
              name: agent.name,
              model: agent.model,
            }))
          },
          getStatus: () => getOpenClawService().getStatus(),
          getAgentHistory: async (agentId) => {
            // Aggregated across the agent's main + every sub-session
            // (cron / hook / channel) so autonomous turns surface in
            // the chat panel alongside user-initiated ones.
            const raw = await getOpenClawService().getSessionHistory(
              `agent:${agentId}:main`,
            )
            return convertOpenClawHistoryToAgentHistory(agentId, raw)
          },
        },
        onTurnLifecycle: (agent, event) => {
          if (agent.adapter !== 'openclaw') return
          getOpenClawService().recordAgentTurnEvent(
            agent.id,
            agent.sessionKey,
            event,
          )
        },
        localAuth: localAuthService,
      }),
    )

  const app = new Hono<Env>()
    .use('/*', trustedCorsMiddleware())
    .route('/health', createHealthRoute({ browser, stateBackend: a2aService }))
    .route('/queen/registry', queenRegistryRoutes)
    .route('/queen/lease', queenLeaseRoutes)
    .use('/shutdown/*', requireTrustedAppOrigin())
    .route(
      '/shutdown',
      createShutdownRoute({
        localAuth: localAuthService,
        onShutdown: () => {
          a2aService.destroy()
          shutdownOAuth()
          stopKlavisBackground()
          klavisRef.handle?.close().catch((err) =>
            logger.warn('Failed to close Klavis proxy transport', {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
          taskQueueService.shutdown().catch((err) =>
            logger.warn('Failed to shut down task queue service', {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
          onShutdown?.()
        },
      }),
    )
    .use('/status/*', requireTrustedAppOrigin())
    .route('/status', createStatusRoute({ browser }))
    .use('/auth/*', requireTrustedAppOrigin())
    .route('/auth', createLocalAuthRoutes({ service: localAuthService }))
    .use('/soul/*', requireTrustedAppOrigin())
    .route('/soul', createSoulRoutes({ localAuth: localAuthService }))
    .use('/memory/*', requireTrustedAppOrigin())
    .route('/memory', createMemoryRoutes())
    .use('/skills/*', requireTrustedAppOrigin())
    .route('/skills', createSkillsRoutes({ localAuth: localAuthService }))
    .use('/monitoring/*', requireTrustedAppOrigin())
    .route('/monitoring', monitoringRoutes)
    .use('/acl-rules/*', requireTrustedAppOrigin())
    .route('/acl-rules', aclRoutes)
    .use('/test-provider/*', requireTrustedAppOrigin())
    .route('/test-provider', createProviderRoutes({ browserosId }))
    .use('/refine-prompt/*', requireTrustedAppOrigin())
    .route('/refine-prompt', createRefinePromptRoutes({ browserosId }))
    .use('/oauth/*', requireTrustedAppOrigin())
    .route(
      '/oauth',
      tokenManager
        ? createOAuthRoutes({ tokenManager })
        : new Hono().all('/*', (c) =>
            c.json({ error: 'OAuth not available' }, 503),
          ),
    )
    .use('/klavis/*', requireTrustedAppOrigin())
    .route('/klavis', createKlavisRoutes({ browserosId: browserosId || '' }))
    .use('/credits/*', requireTrustedAppOrigin())
    .route(
      '/credits',
      createCreditsRoutes({
        browserosId,
        gatewayBaseUrl: INLINED_ENV.BROWSEROS_CONFIG_URL
          ? new URL(INLINED_ENV.BROWSEROS_CONFIG_URL).origin
          : undefined,
      }),
    )
    .use('/mcp/*', requireTrustedAppOrigin())
    .route(
      '/mcp',
      createMcpRoutes({
        version,
        registry,
        browser,
        executionDir,
        resourcesDir,
        policyService: aclPolicyService,
        klavisRef,
      }),
    )
    .use('/chat/*', requireTrustedAppOrigin())
    .route(
      '/chat',
      createChatRoutes({
        browser,
        registry,
        browserosId,
        klavisRef,
        aiSdkDevtoolsEnabled: config.aiSdkDevtoolsEnabled,
        databaseUrl:
          process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || '',
        localAuth: localAuthService,
      }),
    )
    .use('/agents/*', requireTrustedAppOrigin())
    .route('/agents', agentRoutes)
    .use('/a2a/*', requireTrustedAppOrigin())
    .route(
      '/a2a',
      createA2aRoutes({ service: a2aService, localAuth: localAuthService }),
    )
    .route(
      '/chats',
      new Hono().use('/*', requireTrustedAppOrigin()).route(
        '/',
        createChatHistoryRoutes({
          databaseUrl:
            process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || '',
        }),
      ),
    )
    .route(
      '/tasks',
      new Hono()
        .use('/*', requireTrustedAppOrigin())
        .route('/', createTaskQueueRoutes({ service: taskQueueService })),
    )
    .use('/claw/*', requireTrustedAppOrigin())
    .route('/claw', clawRoutes)

  // Error handler
  app.onError((err, c) => {
    const error = err as Error

    if (error instanceof HttpAgentError) {
      logger.warn('HTTP Agent Error', {
        name: error.name,
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
      })
      return c.json(error.toJSON(), error.statusCode as ContentfulStatusCode)
    }

    Sentry.withScope((scope) => {
      scope.setTag('route', c.req.path)
      scope.setTag('method', c.req.method)
      Sentry.captureException(error)
    })

    logger.error('Unhandled Error', {
      message: error.message,
      stack: error.stack,
    })

    return c.json(
      {
        error: {
          name: 'InternalServerError',
          message: error.message || 'An unexpected error occurred',
          code: 'INTERNAL_SERVER_ERROR',
          statusCode: 500,
        },
      },
      500,
    )
  })

  await assertPortAvailable(port)

  app.route('/terminal', terminalRoutes)

  const server = Bun.serve({
    fetch: (request, server) => app.fetch(request, { server }),
    port,
    hostname: host,
    idleTimeout: 0,
    websocket,
  })

  logger.info('Consolidated HTTP Server started', { port, host })

  if (config.aiSdkDevtoolsEnabled) {
    logger.info(
      'AI SDK DevTools enabled — run `npx @ai-sdk/devtools` to open the viewer',
    )
  }

  return {
    app,
    server,
    config,
    a2aService,
    taskQueueService,
  }
}
