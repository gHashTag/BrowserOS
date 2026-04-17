/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Browser } from '@browseros/shared/schemas/browser'
import type { ToolSet } from 'ai'
import { Hono } from 'hono'
import type {
  AgentLogEntry,
  AgentStatusResponse,
  AgentTask,
} from '../../agent/portable/config-schema'
import {
  ErrorCode,
  getStatusCodeForError,
  PortableAgentError,
} from '../../agent/portable/errors'
import { logger } from '../../lib/logger'
import { AgentBridgeService } from '../services/agent-bridge/agent-bridge-service'

export interface AgentBridgeRoutesConfig {
  browser: Browser
  registry: ToolSet
  browserosId: string
  browserContext?: Record<string, unknown>
}

export function createAgentBridgeRoutes(config: AgentBridgeRoutesConfig) {
  const service = new AgentBridgeService(config)

  return new Hono()
    .post('/start', async (c) => {
      try {
        const body = await c.req.json()
        const { name, options } = body
        if (!name || typeof name !== 'string') {
          return c.json(
            { error: { message: 'Agent name is required', code: 'INVALID_INPUT' } },
            400,
          )
        }
        const status = await service.startAgent(name, options)
        return c.json(status)
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .post('/stop', async (c) => {
      try {
        const body = await c.req.json()
        const { name, graceful = true } = body
        if (!name || typeof name !== 'string') {
          return c.json(
            { error: { message: 'Agent name is required', code: 'INVALID_INPUT' } },
            400,
          )
        }
        await service.stopAgent(name, graceful)
        return c.json({ success: true })
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .post('/restart', async (c) => {
      try {
        const body = await c.req.json()
        const { name } = body
        if (!name || typeof name !== 'string') {
          return c.json(
            { error: { message: 'Agent name is required', code: 'INVALID_INPUT' } },
            400,
          )
        }
        const status = await service.restartAgent(name)
        return c.json(status)
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .get('/status', async (c) => {
      try {
        const statuses = service.getAllAgentsStatus()
        return c.json(Object.fromEntries(statuses))
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .get('/status/:name', async (c) => {
      try {
        const name = c.req.param('name')
        const status = service.getAgentStatus(name)
        if (!status) {
          return c.json(
            { error: { message: 'Agent not found', code: 'AGENT_NOT_FOUND' } },
            404,
          )
        }
        return c.json(status)
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .post('/:name/task', async (c) => {
      try {
        const name = c.req.param('name')
        const body = await c.req.json()
        const task: AgentTask = { message: body.message, context: body.context }
        if (!task.message || typeof task.message !== 'string') {
          return c.json(
            { error: { message: 'Message is required', code: 'INVALID_INPUT' } },
            400,
          )
        }
        const stream = await service.sendTask(name, task)
        return new Response(stream as ReadableStream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .get('/:name/logs', async (c) => {
      try {
        const name = c.req.param('name')
        const tail = c.req.query('tail')
          ? Number.parseInt(c.req.query('tail')!, 10)
          : undefined
        const since = c.req.query('since')
        const logs = service.getAgentLogs(name, { tail, since })
        return c.json(logs)
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .get('/:name/logs/stream', async (c) => {
      try {
        const name = c.req.param('name')
        const stream = service.getAgentLogsStream(name)
        if (!stream) {
          return c.json(
            { error: { message: 'Agent not found', code: 'AGENT_NOT_FOUND' } },
            404,
          )
        }
        return new Response(stream as ReadableStream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .get('/config', async (c) => {
      try {
        const configs = service.listConfigs()
        return c.json(Object.fromEntries(configs))
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .get('/config/:name', async (c) => {
      try {
        const name = c.req.param('name')
        const cfg = service.getConfig(name)
        if (!cfg) {
          return c.json(
            { error: { message: 'Agent config not found', code: 'CONFIG_NOT_FOUND' } },
            404,
          )
        }
        return c.json(cfg)
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
    .delete('/config/:name', async (c) => {
      try {
        const name = c.req.param('name')
        await service.deleteConfig(name)
        return c.json({ success: true })
      } catch (error) {
        return handleAgentError(c, error)
      }
    })
}

function handleAgentError(c: any, error: unknown) {
  if (error instanceof PortableAgentError) {
    const statusCode = getStatusCodeForError(error.code)
    logger.warn('Agent bridge error', {
      code: error.code,
      message: error.message,
      agentName: error.agentName,
      statusCode,
    })
    return c.json(
      {
        error: {
          message: error.message,
          code: error.code,
        },
      },
      statusCode,
    )
  }

  logger.error('Unexpected agent bridge error', {
    error: error instanceof Error ? error.message : String(error),
  })
  return c.json(
    {
      error: {
        message: 'An unexpected error occurred',
        code: 'INTERNAL_SERVER_ERROR',
      },
    },
    500,
  )
}
