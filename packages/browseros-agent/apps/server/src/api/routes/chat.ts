import { zValidator } from '@hono/zod-validator'
import { DEFAULT_PORTS } from '@trios/shared/constants/ports'
import { Hono } from 'hono'
import { SessionStore } from '../../agent/session-store'
import type { Browser } from '../../browser/browser'
import { KlavisClient } from '../../lib/clients/klavis/klavis-client'
import { logger } from '../../lib/logger'
import { metrics } from '../../lib/metrics'
import { Sentry } from '../../lib/sentry'
import type { ToolRegistry } from '../../tools/tool-registry'
import { ChatService } from '../services/chat-service'
import { ChatRequestSchema } from '../types'
import { ConversationIdParamSchema } from '../utils/validation'

interface ChatRouteDeps {
  browser: Browser
  registry: ToolRegistry
  triosId?: string
  aiSdkDevtoolsEnabled?: boolean
  port?: number
}

export function createChatRoutes(deps: ChatRouteDeps) {
  const { triosId, port = DEFAULT_PORTS.server } = deps

  logger.info('Chat routes initialized', { port })

  const sessionStore = new SessionStore()
  const klavisClient = new KlavisClient()
  const service = new ChatService({
    sessionStore,
    klavisClient,
    browser: deps.browser,
    registry: deps.registry,
    triosId,
    aiSdkDevtoolsEnabled: deps.aiSdkDevtoolsEnabled,
  })

  return new Hono()
    .post('/', zValidator('json', ChatRequestSchema), async (c) => {
      const request = c.req.valid('json')

      // Sentry + metrics (HTTP concerns only)
      Sentry.getCurrentScope().setTag(
        'request-type',
        request.isScheduledTask ? 'schedule' : 'chat',
      )
      Sentry.setContext('request', {
        provider: request.provider,
        model: request.model,
        baseUrl: request.baseUrl
          ? (() => {
              try {
                return new URL(request.baseUrl).origin
              } catch {
                return undefined
              }
            })()
          : undefined,
      })

      metrics.log('chat.request', {
        provider: request.provider,
        model: request.model,
      })

      logger.info('[Step 7] Chat request received at server', {
        conversationId: request.conversationId,
        provider: request.provider,
        model: request.model,
        mode: request.mode,
        hasMessage: !!request.message,
        hasBrowserContext: !!request.browserContext,
      })
      try {
        return await service.processMessage(request, c.req.raw.signal)
      } catch (error) {
        logger.error('Chat request failed', {
          conversationId: request.conversationId,
          provider: request.provider,
          model: request.model,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        })
        throw error
      }
    })
    .delete(
      '/:conversationId',
      zValidator('param', ConversationIdParamSchema),
      async (c) => {
        const { conversationId } = c.req.valid('param')
        const result = await service.deleteSession(conversationId)

        if (result.deleted) {
          return c.json({
            success: true,
            message: `Session ${conversationId} deleted`,
            sessionCount: result.sessionCount,
          })
        }

        return c.json(
          { success: false, message: `Session ${conversationId} not found` },
          404,
        )
      },
    )
}
