import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { SessionStore } from '../../agent/session-store'
import type { Browser } from '../../browser/browser'
import { logger } from '../../lib/logger'
import { metrics } from '../../lib/metrics'
import { Sentry } from '../../lib/sentry'
import type { ToolRegistry } from '../../tools/tool-registry'
import { ChatHistoryService } from '../services/chat-history-service'
import { ChatService } from '../services/chat-service'
import type { KlavisProxyRef } from '../services/klavis/strata-proxy'
import { ChatRequestSchema } from '../types'
import { requireLocalAuth } from '../utils/require-local-auth'
import {
  ConversationIdParamSchema,
  FeedbackBodySchema,
  MessageIdParamSchema,
} from '../utils/validation'

interface ChatRouteDeps {
  browser: Browser
  registry: ToolRegistry
  browserosId?: string
  klavisRef?: KlavisProxyRef
  aiSdkDevtoolsEnabled?: boolean
  databaseUrl?: string
  chatHistoryService?: ChatHistoryService
  localAuth?: import('../utils/require-local-auth').LocalAuthValidator
}

export function createChatRoutes(deps: ChatRouteDeps) {
  const { browserosId } = deps

  const sessionStore = new SessionStore()
  const service = new ChatService({
    sessionStore,
    klavisRef: deps.klavisRef,
    browser: deps.browser,
    registry: deps.registry,
    browserosId,
    aiSdkDevtoolsEnabled: deps.aiSdkDevtoolsEnabled,
  })

  const chatHistoryService =
    deps.chatHistoryService ??
    (deps.databaseUrl
      ? new ChatHistoryService({ databaseUrl: deps.databaseUrl })
      : null)

  function withSseHeartbeat(response: Response): Response {
    if (!response.body) return response

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const reader = response.body.getReader()
    const encoder = new TextEncoder()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      writer.close().catch(() => {})
    }

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writer.write(value)
        }
      } catch (error) {
        logger.warn('Chat SSE stream error', {
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        close()
      }
    }

    heartbeatTimer = setInterval(() => {
      if (closed) return
      writer.write(encoder.encode(':heartbeat\n\n')).catch(() => {})
    }, 15_000)

    pump()

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  return new Hono()
    .post(
      '/',
      requireLocalAuth(deps.localAuth),
      zValidator('json', ChatRequestSchema),
      async (c) => {
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

        logger.info('Chat request received', {
          conversationId: request.conversationId,
          provider: request.provider,
          model: request.model,
        })

        return withSseHeartbeat(
          await service.processMessage(request, c.req.raw.signal),
        )
      },
    )
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
    .post(
      '/:conversationId/messages/:messageId/feedback',
      zValidator(
        'param',
        ConversationIdParamSchema.merge(MessageIdParamSchema),
      ),
      zValidator('json', FeedbackBodySchema),
      async (c) => {
        if (!chatHistoryService) {
          return c.json(
            { success: false, message: 'Chat history not configured' },
            503,
          )
        }
        const { conversationId, messageId } = c.req.valid('param')
        const { isPositive } = c.req.valid('json')
        const { updated } = await chatHistoryService.storeFeedback(
          conversationId,
          messageId,
          isPositive,
        )
        if (!updated) {
          return c.json(
            { success: false, message: `Message ${messageId} not found` },
            404,
          )
        }
        return c.json({ success: true })
      },
    )
}
