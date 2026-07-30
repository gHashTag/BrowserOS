/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Chat History HTTP Routes
 *
 * Endpoints for reading and searching conversation history
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { ChatHistoryService } from '../services/chat-history-service'

interface ChatHistoryRouteDeps {
  databaseUrl: string
}

// Query parameter schemas
const ListConversationsQuerySchema = z.object({
  profileId: z.string().min(1, 'profileId is required'),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().min(1).max(100))
    .optional()
    .default('50'),
  offset: z
    .string()
    .transform(Number)
    .pipe(z.number().min(0))
    .optional()
    .default('0'),
})

const GetConversationQuerySchema = z.object({
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().min(1).max(500))
    .optional()
    .default('100'),
  offset: z
    .string()
    .transform(Number)
    .pipe(z.number().min(0))
    .optional()
    .default('0'),
})

const SearchConversationsQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  profileId: z.string().min(1, 'profileId is required'),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().min(1).max(100))
    .optional()
    .default('20'),
})

const ConversationIdParamSchema = z.object({
  conversationId: z.string().min(1, 'Conversation ID is required'),
})

// Request body schemas
const CreateConversationBodySchema = z.object({
  profileId: z.string().min(1, 'profileId is required'),
  title: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

const AddMessageBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1, 'Message content is required'),
  orderIndex: z.number().optional(),
  metadata: z.record(z.any()).optional(),
})

export function createChatHistoryRoutes(deps: ChatHistoryRouteDeps) {
  const service = new ChatHistoryService(deps)

  // Graceful shutdown handler
  process.on('SIGTERM', async () => {
    await service.shutdown()
  })
  process.on('SIGINT', async () => {
    await service.shutdown()
  })

  return (
    new Hono()
      // POST /api/chats - Create a new conversation
      .post(
        '/',
        zValidator('json', CreateConversationBodySchema),
        async (c) => {
          const { profileId, title, metadata } = c.req.valid('json')

          try {
            const conversation = await service.createConversation({
              profileId,
              title,
              metadata,
            })
            return c.json(
              {
                success: true,
                conversation,
              },
              201,
            )
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to create conversation',
              },
              500,
            )
          }
        },
      )

      // POST /api/chats/:conversationId/messages - Add a message to a conversation
      .post(
        '/:conversationId/messages',
        zValidator('param', ConversationIdParamSchema),
        zValidator('json', AddMessageBodySchema),
        async (c) => {
          const { conversationId } = c.req.valid('param')
          const { role, content, orderIndex, metadata } = c.req.valid('json')

          try {
            const message = await service.addMessage({
              conversationId,
              role,
              content,
              orderIndex,
              metadata,
            })
            return c.json(
              {
                success: true,
                message,
              },
              201,
            )
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Failed to add message'

            if (
              errorMessage.includes('not found') ||
              errorMessage.includes('conversation')
            ) {
              return c.json({ error: errorMessage }, 404)
            }

            return c.json({ error: errorMessage }, 500)
          }
        },
      )

      // GET /api/chats - List all conversations
      .get(
        '/',
        zValidator('query', ListConversationsQuerySchema),
        async (c) => {
          const { profileId, limit, offset } = c.req.valid('query')

          try {
            const result = await service.listConversations(
              profileId,
              limit,
              offset,
            )
            return c.json(result)
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to list conversations',
              },
              500,
            )
          }
        },
      )

      // GET /api/chats/:conversationId - Get full transcript
      .get(
        '/:conversationId',
        zValidator('param', ConversationIdParamSchema),
        zValidator('query', GetConversationQuerySchema),
        async (c) => {
          const { conversationId } = c.req.valid('param')
          const { limit, offset } = c.req.valid('query')

          try {
            const conversation = await service.getConversation(
              conversationId,
              limit,
              offset,
            )
            return c.json({ conversation })
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : 'Failed to get conversation'

            if (errorMessage.includes('not found')) {
              return c.json({ error: errorMessage }, 404)
            }

            return c.json({ error: errorMessage }, 500)
          }
        },
      )

      // GET /api/chats/search - Search across conversations
      .get(
        '/search',
        zValidator('query', SearchConversationsQuerySchema),
        async (c) => {
          const { q, profileId, limit } = c.req.valid('query')

          try {
            const result = await service.searchConversations(
              q,
              profileId,
              limit,
            )
            return c.json(result)
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to search conversations',
              },
              500,
            )
          }
        },
      )

      // DELETE /api/chats/:conversationId - Delete a conversation
      .delete(
        '/:conversationId',
        zValidator('param', ConversationIdParamSchema),
        async (c) => {
          const { conversationId } = c.req.valid('param')

          const { profileId } = c.req.query()

          try {
            const deleted = await service.deleteConversation(
              conversationId,
              profileId,
            )

            if (deleted) {
              return c.json({
                success: true,
                message: `Conversation ${conversationId} deleted`,
              })
            }

            return c.json(
              {
                success: false,
                message: `Conversation ${conversationId} not found or could not be deleted`,
              },
              404,
            )
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to delete conversation',
              },
              500,
            )
          }
        },
      )
  )
}
