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
import type {
  A2aAgentCard,
  A2aMessage,
  A2aRegistryService,
  A2aTask,
} from '../services/a2a/a2a-registry-service'
import type { Env } from '../types'
import { requireLocalAuth } from '../utils/require-local-auth'

interface A2aRouteDeps {
  service: A2aRegistryService
  localAuth?: import('../utils/require-local-auth').LocalAuthValidator
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

  // Per-agent ring buffer for SSE replay (Last-Event-ID support).
  const messageBuffers = new Map<string, { id: number; payload: string }[]>()
  const nextEventIds = new Map<string, number>()

  function bufferMessage(agentId: string, normalized: A2aMessage): number {
    let buffer = messageBuffers.get(agentId)
    if (!buffer) {
      buffer = []
      messageBuffers.set(agentId, buffer)
    }

    const id = nextEventIds.get(agentId) ?? 0
    nextEventIds.set(agentId, id + 1)
    buffer.push({ id, payload: JSON.stringify(normalized) })

    if (buffer.length > 100) {
      buffer.shift()
    }

    return id
  }

  return new Hono<Env>()
    .post('/register', requireLocalAuth(deps.localAuth), async (c) => {
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

    .post('/message', requireLocalAuth(deps.localAuth), async (c) => {
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

      const lastEventIdHeader = c.req.header('Last-Event-ID')
      const lastEventId =
        lastEventIdHeader !== undefined ? parseInt(lastEventIdHeader, 10) : null

      return stream(c, async (s) => {
        const encoder = new TextEncoder()
        const pendingDuringReplay: A2aMessage[] = []
        let replaying = true

        const sendMessage = (msg: A2aMessage) => {
          const normalized = normalizePayloadForSwift(msg)
          const id = bufferMessage(agentId, normalized)
          s.write(
            encoder.encode(
              `id: ${id}\ndata: ${JSON.stringify(normalized)}\n\n`,
            ),
          ).catch(() => {})
        }

        service.subscribe(agentId, (msg) => {
          if (replaying) {
            pendingDuringReplay.push(msg)
            return
          }
          sendMessage(msg)
        })

        // Replay buffered events newer than the client's Last-Event-ID.
        if (lastEventId !== null && !Number.isNaN(lastEventId)) {
          const buffer = messageBuffers.get(agentId) ?? []
          for (const entry of buffer) {
            if (entry.id > lastEventId) {
              s.write(
                encoder.encode(`id: ${entry.id}\ndata: ${entry.payload}\n\n`),
              ).catch(() => {})
            }
          }
        }

        replaying = false
        for (const msg of pendingDuringReplay) {
          sendMessage(msg)
        }

        await s.write(encoder.encode(':heartbeat\n\n'))

        const heartbeat = setInterval(() => {
          s.write(encoder.encode(':heartbeat\n\n')).catch(() => {})
        }, 15_000)

        // This waits on onAbort rather than on a write throwing, because on this
        // runtime a write cannot throw. hono@4.12.3 dist/utils/stream.js is
        // `async write(input) { try { await this.writer.write(input) } catch {} }`,
        // and dist/helper/streaming/stream.js registers the c.req.raw.signal
        // abort listener only `if (isOldBunVersion())` - true only for Bun
        // "1.1", "1.0" or "0.x", while the image is oven/bun:1.3.6. Measured on
        // two routes in this codebase: nine heartbeats after the client had
        // gone, still writing, with the teardown never reached. onAbort fires
        // from the `cancel` handler of responseReadable, which is the one
        // disconnect signal that survives here.
        try {
          await new Promise<void>((resolve) => {
            s.onAbort(() => resolve())
          })
        } finally {
          service.unsubscribe(agentId)
          clearInterval(heartbeat)
        }
      })
    })
}
