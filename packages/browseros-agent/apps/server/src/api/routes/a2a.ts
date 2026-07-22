/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A2A (Agent-to-Agent) HTTP Routes
 *
 * Endpoints for agent registration, heartbeat, messaging, task assignment,
 * real-time SSE streaming, and agent matrix dashboard.
 */

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { logger } from '../../lib/logger'
import type {
  A2aAgentCard,
  A2aMessage,
  A2aRegistryService,
  A2aTask,
} from '../services/a2a/a2a-registry-service'
import type { Env } from '../types'

interface A2aRouteDeps {
  service: A2aRegistryService
}

function normalizePayloadForSwift(msg: A2aMessage): A2aMessage {
  if (msg.payload === undefined || msg.payload === null) {
    return { ...msg, payload: '' }
  }
  if (typeof msg.payload === 'string') {
    return msg
  }
  // Serialize object payloads to a JSON string so Swift Data.from utf-8 works.
  try {
    return { ...msg, payload: JSON.stringify(msg.payload) }
  } catch {
    return { ...msg, payload: String(msg.payload) }
  }
}

export function createA2aRoutes(deps: A2aRouteDeps) {
  const { service } = deps

  return new Hono<Env>()
    .post('/register', async (c) => {
      const body = (await c.req.json()) as A2aAgentCard
      if (!body?.id || !body?.name) {
        return c.json({ error: 'Missing agent id or name' }, 400)
      }
      await service.register(body)
      return c.json({ success: true })
    })

    .post('/unregister', async (c) => {
      const body = (await c.req.json()) as { agentId?: string }
      if (!body?.agentId) {
        return c.json({ error: 'Missing agentId' }, 400)
      }
      const removed = await service.unregister(body.agentId)
      return c.json({ success: removed })
    })

    .post('/heartbeat', async (c) => {
      const body = (await c.req.json()) as {
        agentId?: string
        timestamp?: string
      }
      if (!body?.agentId) {
        return c.json({ error: 'Missing agentId' }, 400)
      }
      const ok = await service.heartbeat(body.agentId)
      return c.json({ success: ok })
    })

    .get('/agents', async (c) => {
      const agents = await service.listAgents()
      return c.json({ agents })
    })

    .get('/matrix', async (c) => {
      const rows = await service.listMatrix()
      return c.json({
        matrix: rows,
        canon: 'IGLA-SHORT-WAVE-MATRIX-2026',
        generated_at: new Date().toISOString(),
      })
    })

    .post('/message', async (c) => {
      const body = (await c.req.json()) as A2aMessage
      if (!body?.id || !body?.sender || !body?.type) {
        return c.json({ error: 'Invalid message' }, 400)
      }
      service.sendMessage(body)
      return c.json({ success: true })
    })

    .post('/task/assign', async (c) => {
      const body = (await c.req.json()) as { task?: A2aTask; agentId?: string }
      if (!body?.task || !body?.agentId) {
        return c.json({ error: 'Missing task or agentId' }, 400)
      }
      service.assignTask(body.task, body.agentId)
      return c.json({ success: true })
    })

    .post('/task/update', async (c) => {
      const body = (await c.req.json()) as { id?: string; state?: string }
      if (!body?.id || !body?.state) {
        return c.json({ error: 'Missing id or state' }, 400)
      }
      const ok = service.updateTaskState(body.id, body.state)
      if (!ok) {
        return c.json({ error: 'Task not found' }, 404)
      }
      return c.json({ success: true })
    })

    .get('/stream', (c) => {
      const agentId = c.req.query('agentId')
      if (!agentId) {
        return c.json({ error: 'Missing agentId query parameter' }, 400)
      }

      c.header('Content-Type', 'text/event-stream')
      c.header('Cache-Control', 'no-cache')
      c.header('Connection', 'keep-alive')

      return stream(c, async (s) => {
        const encoder = new TextEncoder()

        service.subscribe(agentId, (msg) => {
          // Swift A2AMessage.payload is Data and decodes from a base64 string.
          // Normalize task/object payloads so the SSE message is self-describing.
          const normalized = normalizePayloadForSwift(msg)
          s.write(
            encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`),
          ).catch(() => {})
        })

        try {
          while (true) {
            await s.write(encoder.encode(':keep-alive\n\n'))
            await new Promise((r) => setTimeout(r, 30_000))
          }
        } catch {
          // Client disconnected
        } finally {
          service.unsubscribe(agentId)
          logger.info('A2A stream closed', { agentId })
        }
      })
    })
}
