/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract suite for src/api/routes/chat-history.ts
 *
 * The subject exports exactly one symbol, createChatHistoryRoutes, and this
 * suite covers it. The only surface that factory offers is the Hono app it
 * returns, so every assertion drives that app with in-process requests
 * (app.request) and checks a status code or a response body. Nothing here
 * opens a socket: no network, no database, no container.
 *
 * createChatHistoryRoutes builds its own ChatHistoryService from the deps it
 * is handed, and that service's real job is to talk to PostgreSQL. To keep
 * the contract observable over HTTP without a live database, the service
 * module is swapped (mock.module, registered before the subject is imported)
 * for a fake whose methods echo their inputs back inside their outputs; each
 * test may override a method to return a canned value or throw. The echoes
 * let request parsing and wiring be asserted from the response alone - no
 * assertion inspects how the route called the service.
 *
 * Exports of the subject not exercised by an assertion: none. The sole
 * export, createChatHistoryRoutes, is covered below (POST /, POST
 * /:conversationId/messages, GET /, GET /:conversationId, DELETE
 * /:conversationId, and the /search shadowing pinned in place). No export was
 * left out for lack of a live dependency, so there is nothing to list under
 * the issue's blocked-export rule. (ChatHistoryService is a collaborator, not
 * an export of the subject; it is faked here, not tested - its behaviour
 * belongs to its own suite.)
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ChatHistoryService } from '../../src/api/services/chat-history-service'

interface CreateConversationRequest {
  profileId: string
  title?: string
  metadata?: Record<string, unknown>
}

interface AddMessageRequest {
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  orderIndex?: number
  metadata?: Record<string, unknown>
}

interface FakeOverrides {
  createConversation?: (input: CreateConversationRequest) => Promise<unknown>
  addMessage?: (input: AddMessageRequest) => Promise<unknown>
  listConversations?: (
    profileId: string,
    limit: unknown,
    offset: unknown,
  ) => Promise<unknown>
  getConversation?: (
    conversationId: string,
    limit: unknown,
    offset: unknown,
  ) => Promise<unknown>
  searchConversations?: (
    q: string,
    profileId: string,
    limit: unknown,
  ) => Promise<unknown>
  deleteConversation?: (
    conversationId: string,
    profileId: string | undefined,
  ) => Promise<unknown>
}

let overrides: FakeOverrides = {}

/**
 * A ChatHistoryService stand-in. Default methods echo their inputs into
 * their outputs, so what the route parsed and handed over comes back in the
 * response body - the one place a test is allowed to look.
 */
class FakeChatHistoryService {
  constructor(private readonly deps: { databaseUrl: string }) {}

  async createConversation(input: CreateConversationRequest) {
    if (overrides.createConversation) {
      return overrides.createConversation(input)
    }
    return {
      id: 'created-1',
      databaseUrl: this.deps.databaseUrl,
      request: input,
    }
  }

  async addMessage(input: AddMessageRequest) {
    if (overrides.addMessage) return overrides.addMessage(input)
    return { id: 'message-1', request: input }
  }

  async listConversations(profileId: string, limit: unknown, offset: unknown) {
    if (overrides.listConversations) {
      return overrides.listConversations(profileId, limit, offset)
    }
    return {
      conversations: [],
      totalCount: 0,
      hasMore: false,
      databaseUrl: this.deps.databaseUrl,
      resolved: { profileId, limit, offset },
    }
  }

  async getConversation(
    conversationId: string,
    limit: unknown,
    offset: unknown,
  ) {
    if (overrides.getConversation) {
      return overrides.getConversation(conversationId, limit, offset)
    }
    return { resolved: { conversationId, limit, offset } }
  }

  async searchConversations(q: string, profileId: string, limit: unknown) {
    if (overrides.searchConversations) {
      return overrides.searchConversations(q, profileId, limit)
    }
    return { matches: [], resolved: { q, profileId, limit } }
  }

  async deleteConversation(
    conversationId: string,
    profileId: string | undefined,
  ) {
    if (overrides.deleteConversation) {
      return overrides.deleteConversation(conversationId, profileId)
    }
    return true
  }

  async shutdown(): Promise<void> {}
}

const SERVICE_MODULE = '../../src/api/services/chat-history-service'

// Registered before the subject is imported so createChatHistoryRoutes
// constructs the fake rather than the real PostgreSQL-backed service. The
// fake is wanted for the lifetime of this file, and mock.restore() does not
// undo mock.module in bun 1.3 anyway - neither matters here.
mock.module(SERVICE_MODULE, () => ({
  ChatHistoryService:
    FakeChatHistoryService as unknown as typeof ChatHistoryService,
}))

const { createChatHistoryRoutes } = await import(
  '../../src/api/routes/chat-history'
)

// The URL is never dialed - the fake opens no pool. It is echoed back so the
// suite can pin that the factory wires the deps it was given into the
// service it builds.
const DATABASE_URL = 'postgres://chat-history-contract.invalid/db'

// Built once for the whole suite: createChatHistoryRoutes registers a
// SIGTERM/SIGINT listener pair on every call, and a fresh app per test would
// only pile signal listeners onto the test process.
const app = createChatHistoryRoutes({ databaseUrl: DATABASE_URL })

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('chatHistoryContract', () => {
  // The subject exports exactly one symbol: createChatHistoryRoutes(deps),
  // which returns a Hono app. Every test below exercises that one export
  // through the HTTP surface of the app it returns.

  beforeEach(() => {
    overrides = {}
  })

  describe('createChatHistoryRoutes: POST / (create conversation)', () => {
    it('answers 201 with the created conversation', async () => {
      const res = await post('/', {
        profileId: 'profile-1',
        title: 'Planning',
        metadata: { tab: 3 },
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.conversation).toEqual({
        id: 'created-1',
        databaseUrl: DATABASE_URL,
        request: {
          profileId: 'profile-1',
          title: 'Planning',
          metadata: { tab: 3 },
        },
      })
    })

    it('leaves optional title and metadata out when absent', async () => {
      const res = await post('/', { profileId: 'profile-1' })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.conversation.request).toEqual({ profileId: 'profile-1' })
    })

    it('answers 400 when profileId is missing', async () => {
      const res = await post('/', {})

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(
        body.error.issues.some((issue) => issue.path.includes('profileId')),
      ).toBe(true)
    })

    it('answers 400 when profileId is an empty string', async () => {
      const res = await post('/', { profileId: '' })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(
        body.error.issues.some((issue) => issue.path.includes('profileId')),
      ).toBe(true)
    })

    it('maps a service failure to 500 with the error message', async () => {
      overrides.createConversation = async () => {
        throw new Error('insert rejected')
      }

      const res = await post('/', { profileId: 'profile-1' })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'insert rejected' })
    })

    it('maps a non-Error throw to 500 with the fallback message', async () => {
      overrides.createConversation = async () => {
        throw 'connection gone'
      }

      const res = await post('/', { profileId: 'profile-1' })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({
        error: 'Failed to create conversation',
      })
    })
  })

  describe('createChatHistoryRoutes: POST /:conversationId/messages', () => {
    it('answers 201 with the stored message', async () => {
      const res = await post('/conv-9/messages', {
        role: 'assistant',
        content: 'hello there',
        orderIndex: 4,
        metadata: { model: 'x' },
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.message).toEqual({
        id: 'message-1',
        request: {
          conversationId: 'conv-9',
          role: 'assistant',
          content: 'hello there',
          orderIndex: 4,
          metadata: { model: 'x' },
        },
      })
    })

    it('answers 400 when the role is outside the enum', async () => {
      const res = await post('/conv-9/messages', {
        role: 'robot',
        content: 'hello there',
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(
        body.error.issues.some((issue) => issue.path.includes('role')),
      ).toBe(true)
    })

    it('answers 400 when the content is empty', async () => {
      const res = await post('/conv-9/messages', {
        role: 'user',
        content: '',
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(
        body.error.issues.some((issue) => issue.path.includes('content')),
      ).toBe(true)
    })

    it('maps a not-found service error to 404', async () => {
      overrides.addMessage = async () => {
        throw new Error('Conversation conv-9 not found')
      }

      const res = await post('/conv-9/messages', {
        role: 'user',
        content: 'hello there',
      })

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: 'Conversation conv-9 not found',
      })
    })

    // The route's predicate is `message.includes('not found') ||
    // message.includes('conversation')`, so any error that merely mentions
    // the word "conversation" is also a 404. Pinned as it stands.
    it('maps any error mentioning "conversation" to 404, not just not-found', async () => {
      overrides.addMessage = async () => {
        throw new Error('conversation table is locked')
      }

      const res = await post('/conv-9/messages', {
        role: 'user',
        content: 'hello there',
      })

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: 'conversation table is locked',
      })
    })

    it('maps other service errors to 500 with the message', async () => {
      overrides.addMessage = async () => {
        throw new Error('write-ahead log is full')
      }

      const res = await post('/conv-9/messages', {
        role: 'user',
        content: 'hello there',
      })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'write-ahead log is full' })
    })
  })

  describe('createChatHistoryRoutes: GET / (list conversations)', () => {
    it('lists conversations with the schema defaults applied', async () => {
      const res = await app.request('/?profileId=profile-1')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversations).toEqual([])
      // The paging query params are strings transformed through Number, and
      // the defaults ('50' / '0') parse through the same transform, so the
      // service receives numbers either way. Pinned as the route behaves
      // today.
      expect(body.resolved).toEqual({
        profileId: 'profile-1',
        limit: 50,
        offset: 0,
      })
    })

    it('coerces explicit limit and offset strings to numbers', async () => {
      const res = await app.request('/?profileId=profile-1&limit=7&offset=3')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resolved).toEqual({
        profileId: 'profile-1',
        limit: 7,
        offset: 3,
      })
    })

    it('answers 400 when profileId is missing', async () => {
      const res = await app.request('/')

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(
        body.error.issues.some((issue) => issue.path.includes('profileId')),
      ).toBe(true)
    })

    it('answers 400 for a non-numeric, zero or over-maximum limit', async () => {
      const notANumber = await app.request('/?profileId=p&limit=abc')
      expect(notANumber.status).toBe(400)

      const tooSmall = await app.request('/?profileId=p&limit=0')
      expect(tooSmall.status).toBe(400)

      const tooLarge = await app.request('/?profileId=p&limit=101')
      expect(tooLarge.status).toBe(400)
    })

    it('maps a service failure to 500 with the error message', async () => {
      overrides.listConversations = async () => {
        throw new Error('pool drained')
      }

      const res = await app.request('/?profileId=profile-1')

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'pool drained' })
    })
  })

  describe('createChatHistoryRoutes: GET /:conversationId (transcript)', () => {
    it('returns the conversation transcript with default paging', async () => {
      const res = await app.request('/conv-1')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversation).toEqual({
        resolved: { conversationId: 'conv-1', limit: 100, offset: 0 },
      })
    })

    it('answers 400 when the transcript limit exceeds 500', async () => {
      const res = await app.request('/conv-1?limit=501')

      expect(res.status).toBe(400)
    })

    it('maps a not-found conversation to 404 with the service message', async () => {
      overrides.getConversation = async () => {
        throw new Error('Conversation conv-1 not found')
      }

      const res = await app.request('/conv-1')

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: 'Conversation conv-1 not found',
      })
    })

    it('maps other service errors to 500 with the message', async () => {
      overrides.getConversation = async () => {
        throw new Error('lock timeout')
      }

      const res = await app.request('/conv-1')

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'lock timeout' })
    })
  })

  describe('createChatHistoryRoutes: GET /search', () => {
    // Measured behaviour: Hono answers in registration order, and the
    // transcript route ('/:conversationId', registered earlier in the
    // subject) claims the literal path segment 'search' before the search
    // route can. The search handler - and its "q is required" validation -
    // is therefore unreachable as written. Pinned as-is: the issue asks for
    // today's behaviour, not a redesign.
    it('serves /search through the earlier transcript route', async () => {
      const res = await app.request('/search?q=hello&profileId=profile-1')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversation.resolved).toEqual({
        conversationId: 'search',
        limit: 100,
        offset: 0,
      })
    })

    it('does not enforce the search schema, because the transcript route answers instead', async () => {
      const res = await app.request('/search')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversation.resolved.conversationId).toBe('search')
    })
  })

  describe('createChatHistoryRoutes: DELETE /:conversationId', () => {
    it('deletes and reports which conversation', async () => {
      const res = await app.request('/conv-2?profileId=profile-1', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        success: true,
        message: 'Conversation conv-2 deleted',
      })
    })

    it('answers 404 when the service deletes nothing', async () => {
      overrides.deleteConversation = async () => false

      const res = await app.request('/conv-2', { method: 'DELETE' })

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        success: false,
        message: 'Conversation conv-2 not found or could not be deleted',
      })
    })

    it('maps a service failure to 500 with the error message', async () => {
      overrides.deleteConversation = async () => {
        throw new Error('cascade blocked')
      }

      const res = await app.request('/conv-2', { method: 'DELETE' })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'cascade blocked' })
    })
  })
})
