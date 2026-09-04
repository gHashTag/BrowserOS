/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Contract suite for src/api/routes/tasks.ts.
 *
 * Export coverage (the module exports exactly one symbol):
 *   - createTaskQueueRoutes ... exercised below (HTTP contract + shutdown wiring)
 *   - blocked by a live dependency ... none
 *   1 exercised + 0 blocked = 1 export
 *
 * The suite pins the behaviour that exists today, unmodified: every
 * endpoint's success shape, its validation failures, its dispatch to the
 * TaskQueueService dependency, its error mapping, and the SIGTERM/SIGINT
 * graceful-shutdown wiring. It needs no network, no database and no
 * container — the service is an in-memory stand-in.
 *
 * Why some assertions inspect `service.calls`: this module is a thin HTTP
 * adapter, and the effect it has on the outside world beyond status codes
 * and bodies is precisely which service operation it hands a request to and
 * with which arguments. That is the contract, not the implementation.
 */

import { describe, expect, it } from 'bun:test'

import { createTaskQueueRoutes } from '../../src/api/routes/tasks'
import type {
  CreateTaskInput,
  TaskItem,
  TaskQueueService,
} from '../../src/api/services/task-queue-service'

/**
 * Every call to createTaskQueueRoutes registers fresh SIGTERM/SIGINT
 * listeners on the real process and never removes them, so a suite with many
 * calls would trip the EventEmitter max-listeners warning. Raising the
 * ceiling here is test scaffolding, not a behavioural claim.
 */
process.setMaxListeners?.(0)

type ServiceCall = { method: keyof TaskQueueService; args: unknown[] }

type ServiceOverrides = {
  [K in keyof TaskQueueService]?: (
    ...args: Parameters<TaskQueueService[K]>
  ) => Awaited<ReturnType<TaskQueueService[K]>>
}

const CHECK_PAYLOAD = {
  type: 'browser-check',
  data: { url: 'https://example.test' },
} as const

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    agentId: 'agent-1',
    taskType: 'browser-check',
    payload: { type: CHECK_PAYLOAD.type, data: { ...CHECK_PAYLOAD.data } },
    priority: 0,
    status: 'pending',
    retryCount: 0,
    maxRetries: 3,
    createdAt: '2025-01-01T00:00:00.000Z',
    assignedBy: 'queen',
    metadata: {},
    ...overrides,
  }
}

/**
 * An in-memory TaskQueueService that records every call and answers from
 * per-method overrides, falling back to quiet defaults (empty lists, null
 * lookups, true mutations, zeroed stats). Only the methods the routes use
 * ever fire, but the full public surface is implemented so the object can be
 * handed to createTaskQueueRoutes.
 */
function makeService(
  overrides: ServiceOverrides = {},
): TaskQueueService & { calls: ServiceCall[] } {
  const calls: ServiceCall[] = []

  const defaults: ServiceOverrides = {
    shutdown: () => undefined,
    createTask: (input: CreateTaskInput) =>
      makeTask({
        id: 'task-created',
        agentId: input.agentId,
        taskType: input.taskType,
        payload: input.payload,
        priority: input.priority ?? 0,
        maxRetries: input.maxRetries ?? 3,
        assignedBy: input.assignedBy,
        metadata: input.metadata,
      }),
    dequeueNextTask: () => null,
    renewLease: () => true,
    reclaimStaleLeases: () => 0,
    updateTaskStatus: () => true,
    retryTask: () => true,
    getTasksByStatus: () => [],
    getTask: () => null,
    cancelTask: () => true,
    deleteTask: () => true,
    getTaskHistory: () => [],
    getQueueStats: () => ({
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    }),
  }

  const service: Record<string, unknown> = { calls }
  for (const method of Object.keys(defaults) as (keyof TaskQueueService)[]) {
    service[method] = async (...args: unknown[]) => {
      calls.push({ method, args })
      const handler = (overrides[method] ?? defaults[method]) as (
        ...a: unknown[]
      ) => unknown
      return handler(...args)
    }
  }
  return service as unknown as TaskQueueService & { calls: ServiceCall[] }
}

function callsOf(
  service: { calls: ServiceCall[] },
  method: keyof TaskQueueService,
): unknown[][] {
  return service.calls
    .filter((call) => call.method === method)
    .map((call) => call.args)
}

function makeRoutes(overrides: ServiceOverrides = {}) {
  const service = makeService(overrides)
  const app = createTaskQueueRoutes({ service })
  return { app, service }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('tasksContract', () => {
  describe('createTaskQueueRoutes', () => {
    describe('POST / — create a task', () => {
      it('returns 201 with success and the created task', async () => {
        const { app, service } = makeRoutes()
        const res = await app.request(
          '/',
          jsonInit('POST', {
            agentId: 'agent-7',
            taskType: 'browser-check',
            payload: CHECK_PAYLOAD,
            priority: 5,
            maxRetries: 2,
            assignedBy: 'queen',
            metadata: { origin: 'suite' },
          }),
        )

        expect(res.status).toBe(201)
        await expect(res.json()).resolves.toEqual({
          success: true,
          task: makeTask({
            id: 'task-created',
            agentId: 'agent-7',
            priority: 5,
            maxRetries: 2,
            metadata: { origin: 'suite' },
          }),
        })
        expect(callsOf(service, 'createTask')).toEqual([
          [
            {
              agentId: 'agent-7',
              taskType: 'browser-check',
              payload: CHECK_PAYLOAD,
              priority: 5,
              maxRetries: 2,
              assignedBy: 'queen',
              metadata: { origin: 'suite' },
            },
          ],
        ])
      })

      it('defaults priority to 0 and maxRetries to 3 when omitted', async () => {
        const { app, service } = makeRoutes()
        const res = await app.request(
          '/',
          jsonInit('POST', {
            agentId: 'agent-7',
            taskType: 'browser-check',
            payload: CHECK_PAYLOAD,
          }),
        )

        expect(res.status).toBe(201)
        const body = (await res.json()) as { task: TaskItem }
        expect(body.task.priority).toBe(0)
        expect(body.task.maxRetries).toBe(3)
        expect(callsOf(service, 'createTask')[0]?.[0]).toMatchObject({
          priority: 0,
          maxRetries: 3,
        })
      })

      it('rejects invalid create bodies with 400 before touching the service', async () => {
        const { app, service } = makeRoutes()
        const badBodies = [
          { taskType: 't', payload: { type: 't', data: {} } },
          { agentId: 'a', payload: { type: 't', data: {} } },
          { agentId: 'a', taskType: 't', payload: { type: 't' } },
          {
            agentId: 'a',
            taskType: 't',
            payload: { type: 't', data: {} },
            priority: 101,
          },
          {
            agentId: 'a',
            taskType: 't',
            payload: { type: 't', data: {} },
            maxRetries: 11,
          },
          {
            agentId: 'a',
            taskType: 't',
            payload: { type: 't', data: {} },
            priority: 1.5,
          },
        ]
        for (const body of badBodies) {
          const res = await app.request('/', jsonInit('POST', body))
          expect(res.status).toBe(400)
        }
        expect(service.calls).toEqual([])
      })

      it('maps a failing create to 500 with the error message', async () => {
        const { app } = makeRoutes({
          createTask: () => {
            throw new Error('agent is paused')
          },
        })
        const res = await app.request(
          '/',
          jsonInit('POST', {
            agentId: 'agent-7',
            taskType: 'browser-check',
            payload: CHECK_PAYLOAD,
          }),
        )

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({ error: 'agent is paused' })
      })

      it('maps a non-Error throw to the fallback create message', async () => {
        const { app } = makeRoutes({
          createTask: () => {
            throw 'kaboom'
          },
        })
        const res = await app.request(
          '/',
          jsonInit('POST', {
            agentId: 'agent-7',
            taskType: 'browser-check',
            payload: CHECK_PAYLOAD,
          }),
        )

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
          error: 'Failed to create task',
        })
      })
    })

    describe('GET / — list tasks', () => {
      it('returns queue stats when no filters are given', async () => {
        const stats = {
          total: 9,
          pending: 4,
          running: 1,
          completed: 3,
          failed: 1,
        }
        const { app, service } = makeRoutes({ getQueueStats: () => stats })

        const res = await app.request('/')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ stats })
        expect(callsOf(service, 'getQueueStats')).toEqual([[]])
      })

      it("returns the agent's task history when only agentId is given", async () => {
        const history = [makeTask({ id: 'h-1' }), makeTask({ id: 'h-2' })]
        const { app, service } = makeRoutes({
          getTaskHistory: () => history,
        })

        const res = await app.request('/?agentId=agent-9')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ tasks: history, total: 2 })
        expect(callsOf(service, 'getTaskHistory')).toEqual([['agent-9', 100]])
        expect(callsOf(service, 'getTasksByStatus')).toEqual([])
      })

      it('returns tasks by status when agentId and status are given', async () => {
        const byStatus = [makeTask({ id: 's-1', status: 'running' })]
        const { app, service } = makeRoutes({
          getTasksByStatus: () => byStatus,
        })

        const res = await app.request('/?agentId=agent-9&status=running')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
          tasks: byStatus,
          total: 1,
        })
        expect(callsOf(service, 'getTasksByStatus')).toEqual([
          ['agent-9', 'running', 100],
        ])
        expect(callsOf(service, 'getTaskHistory')).toEqual([])
      })

      it('parses the limit query parameter and forwards it', async () => {
        const { app, service } = makeRoutes()

        await app.request('/?agentId=a&limit=7')
        expect(callsOf(service, 'getTaskHistory')).toEqual([['a', 7]])

        await app.request('/?agentId=a&status=failed&limit=7')
        expect(callsOf(service, 'getTasksByStatus')).toEqual([
          ['a', 'failed', 7],
        ])
      })

      it('rejects an unknown status or an out-of-range limit with 400', async () => {
        const { app, service } = makeRoutes()
        const badQueries = [
          '?status=bogus',
          '?limit=0',
          '?limit=501',
          '?limit=abc',
          '?agentId=a&limit=-1',
        ]
        for (const query of badQueries) {
          const res = await app.request(`/${query}`)
          expect(res.status).toBe(400)
        }
        expect(service.calls).toEqual([])
      })

      it('maps a listing failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          getQueueStats: () => {
            throw new Error('db gone')
          },
        })
        const res = await app.request('/')

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({ error: 'db gone' })
      })
    })

    describe('GET /queue/:agentId — dequeue the next task', () => {
      it('returns the next task for the agent', async () => {
        const next = makeTask({
          id: 'next-1',
          agentId: 'agent-4',
          status: 'running',
        })
        const { app, service } = makeRoutes({
          dequeueNextTask: () => next,
        })

        const res = await app.request('/queue/agent-4')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ success: true, task: next })
        expect(callsOf(service, 'dequeueNextTask')).toEqual([['agent-4']])
      })

      it('reports "No pending tasks" with a null task when the queue is empty', async () => {
        const { app } = makeRoutes({ dequeueNextTask: () => null })

        const res = await app.request('/queue/agent-4')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
          success: true,
          task: null,
          message: 'No pending tasks',
        })
      })

      it('maps a dequeue failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          dequeueNextTask: () => {
            throw new Error('lease lost')
          },
        })

        const res = await app.request('/queue/agent-4')

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({ error: 'lease lost' })
      })
    })

    describe('GET /stats — queue statistics', () => {
      it('returns the stats, scoped to agentId when given', async () => {
        const stats = {
          total: 5,
          pending: 2,
          running: 1,
          completed: 1,
          failed: 1,
        }
        const { app, service } = makeRoutes({ getQueueStats: () => stats })

        const res = await app.request('/stats')
        const scoped = await app.request('/stats?agentId=agent-3')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ stats })
        expect(scoped.status).toBe(200)
        expect(callsOf(service, 'getQueueStats')).toEqual([[], ['agent-3']])
      })

      it('serves /stats from the stats route, not the task lookup', async () => {
        const stats = {
          total: 0,
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
        }
        const { app, service } = makeRoutes({
          getQueueStats: () => stats,
          getTask: () => makeTask({ id: 'would-be-wrong' }),
        })

        const res = await app.request('/stats')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ stats })
        expect(callsOf(service, 'getTask')).toEqual([])
      })

      it('maps a stats failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          getQueueStats: () => {
            throw new Error('stats backend down')
          },
        })

        const res = await app.request('/stats')

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
          error: 'stats backend down',
        })
      })
    })

    describe('GET /:taskId — fetch one task', () => {
      it('returns the task when it exists', async () => {
        const task = makeTask({ id: 't-1' })
        const { app, service } = makeRoutes({ getTask: () => task })

        const res = await app.request('/t-1')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ task })
        expect(callsOf(service, 'getTask')).toEqual([['t-1']])
      })

      it('returns 404 "Task not found" when the service has no such task', async () => {
        const { app } = makeRoutes({ getTask: () => null })

        const res = await app.request('/t-404')

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toEqual({ error: 'Task not found' })
      })

      it('forbids reading a task that belongs to another agent', async () => {
        const { app } = makeRoutes({
          getTask: () => makeTask({ id: 't-1', agentId: 'owner-1' }),
        })

        const res = await app.request('/t-1?agentId=someone-else')

        expect(res.status).toBe(403)
        await expect(res.json()).resolves.toEqual({ error: 'Forbidden' })
      })

      it('allows the owning agent to read its task', async () => {
        const task = makeTask({ id: 't-1', agentId: 'owner-1' })
        const { app } = makeRoutes({ getTask: () => task })

        const res = await app.request('/t-1?agentId=owner-1')

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ task })
      })

      it('maps a lookup failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          getTask: () => {
            throw new Error('row fetch failed')
          },
        })

        const res = await app.request('/t-1')

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({ error: 'row fetch failed' })
      })
    })

    describe('PUT /:taskId — update task status', () => {
      it('updates the status and confirms with a message', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request(
          '/t-1?agentId=owner-1',
          jsonInit('PUT', {
            status: 'completed',
            result: { answer: 42 },
            errorMessage: 'done',
          }),
        )

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
          success: true,
          message: 'Task updated',
        })
        expect(callsOf(service, 'updateTaskStatus')).toEqual([
          ['t-1', 'completed', { answer: 42 }, 'done', 'owner-1'],
        ])
      })

      it('forwards optional fields as undefined when omitted', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request(
          '/t-2',
          jsonInit('PUT', { status: 'failed', errorMessage: 'boom' }),
        )

        expect(res.status).toBe(200)
        expect(callsOf(service, 'updateTaskStatus')).toEqual([
          ['t-2', 'failed', undefined, 'boom', undefined],
        ])
      })

      it('returns 404 when the service cannot update the task', async () => {
        const { app } = makeRoutes({ updateTaskStatus: () => false })

        const res = await app.request(
          '/t-1',
          jsonInit('PUT', { status: 'completed' }),
        )

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toEqual({
          error: 'Task not found or could not be updated',
        })
      })

      it('returns 404 and does not call the service when the body has no status', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request('/t-1', jsonInit('PUT', { result: 123 }))

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toEqual({
          error: 'Task not found or could not be updated',
        })
        expect(callsOf(service, 'updateTaskStatus')).toEqual([])
      })

      it('rejects a status outside the enum with 400', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request(
          '/t-1',
          jsonInit('PUT', { status: 'exploded' }),
        )

        expect(res.status).toBe(400)
        expect(service.calls).toEqual([])
      })

      it('maps an update failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          updateTaskStatus: () => {
            throw new Error('Task t-1 does not belong to agent other')
          },
        })

        const res = await app.request(
          '/t-1?agentId=other',
          jsonInit('PUT', { status: 'completed' }),
        )

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
          error: 'Task t-1 does not belong to agent other',
        })
      })
    })

    describe('POST /:taskId/retry — retry a failed task', () => {
      it('queues a retry and confirms', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request('/t-9/retry', { method: 'POST' })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
          success: true,
          message: 'Task queued for retry',
        })
        expect(callsOf(service, 'retryTask')).toEqual([['t-9']])
      })

      it('returns 404 when the retry limit is exceeded', async () => {
        const { app } = makeRoutes({ retryTask: () => false })

        const res = await app.request('/t-9/retry', { method: 'POST' })

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toEqual({
          error: 'Task not found or retry limit exceeded',
        })
      })

      it('maps a retry failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          retryTask: () => {
            throw new Error('retry backend down')
          },
        })

        const res = await app.request('/t-9/retry', { method: 'POST' })

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
          error: 'retry backend down',
        })
      })
    })

    describe('POST /:taskId/cancel — cancel a task', () => {
      it('cancels and confirms', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request('/t-3/cancel', { method: 'POST' })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
          success: true,
          message: 'Task cancelled',
        })
        expect(callsOf(service, 'cancelTask')).toEqual([['t-3']])
      })

      it('returns 404 when the task is already completed or cancelled', async () => {
        const { app } = makeRoutes({ cancelTask: () => false })

        const res = await app.request('/t-3/cancel', { method: 'POST' })

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toEqual({
          error: 'Task not found or already completed/cancelled',
        })
      })

      it('maps a cancel failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          cancelTask: () => {
            throw new Error('cancel backend down')
          },
        })

        const res = await app.request('/t-3/cancel', { method: 'POST' })

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
          error: 'cancel backend down',
        })
      })
    })

    describe('DELETE /:taskId — delete a task', () => {
      it('deletes and confirms', async () => {
        const { app, service } = makeRoutes()

        const res = await app.request('/t-5', { method: 'DELETE' })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
          success: true,
          message: 'Task deleted',
        })
        expect(callsOf(service, 'deleteTask')).toEqual([['t-5']])
      })

      it('returns 404 "Task not found" when the service cannot delete', async () => {
        const { app } = makeRoutes({ deleteTask: () => false })

        const res = await app.request('/t-5', { method: 'DELETE' })

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toEqual({ error: 'Task not found' })
      })

      it('maps a delete failure to 500 with the error message', async () => {
        const { app } = makeRoutes({
          deleteTask: () => {
            throw new Error('delete backend down')
          },
        })

        const res = await app.request('/t-5', { method: 'DELETE' })

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
          error: 'delete backend down',
        })
      })
    })

    describe('shutdown wiring (SIGTERM / SIGINT)', () => {
      it('shuts the service down on SIGTERM', async () => {
        let shutdowns = 0
        const service = makeService({
          shutdown: () => {
            shutdowns += 1
          },
        })

        createTaskQueueRoutes({ service })
        process.kill(process.pid, 'SIGTERM')

        await waitFor(() => shutdowns > 0)
        expect(shutdowns).toBe(1)
      })

      it('shuts the service down on SIGINT', async () => {
        let shutdowns = 0
        const service = makeService({
          shutdown: () => {
            shutdowns += 1
          },
        })

        createTaskQueueRoutes({ service })
        process.kill(process.pid, 'SIGINT')

        await waitFor(() => shutdowns > 0)
        expect(shutdowns).toBe(1)
      })
    })
  })
})
