/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract suite for the task queue service.
 *
 * Export inventory of src/api/services/task-queue-service.ts, and what this
 * suite does with each:
 *
 *   - TaskQueueService (the only runtime export): exercised throughout, one
 *     describe per public method, so a reader can map assertions to the
 *     export's surface.
 *   - TaskQueueDeps, TaskStatus, TaskPayload, CreateTaskInput, TaskItem are
 *     type-only exports, erased at runtime. They are exercised as the shapes
 *     of the class's inputs and outputs: TaskQueueDeps is what the
 *     constructor is handed, CreateTaskInput/TaskPayload is what createTask
 *     accepts, TaskStatus is what updateTaskStatus/getTasksByStatus accept,
 *     and TaskItem is what every read path returns and is asserted on.
 *
 *   Exports not exercised: none. Nothing here needed a live Postgres - the
 *   one external dependency, a pg pool, is faked at the module boundary and
 *   answers what Postgres would. The SQL statements themselves are
 *   deliberately NOT asserted (the same stance tests/api/queen-lease.test.ts
 *   takes and explains): a query string can be right while its semantics are
 *   wrong. What is pinned is the behaviour on either side of the database -
 *   which values the service writes, what it makes of the rows that come
 *   back, and which failures it swallows into `false` versus which it
 *   rethrows wrapped.
 *
 * The mock is registered before the subject is imported and restored after
 * this file's tests: bun's mock.restore() does not undo mock.module, and a
 * 'pg' mock left in place has broken sibling files in full-suite runs before
 * (see tests/api/routes/queen-lease.test.ts).
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import type {
  TaskItem,
  TaskQueueService as TaskQueueServiceInstance,
} from '../../src/api/services/task-queue-service'

/** What the service hands pg for each query it issues. */
interface QueryCall {
  text: string
  values?: unknown[]
}

/** What pg hands back: enough of the real shape for this service. */
interface QueryResponse {
  rows?: unknown[]
  rowCount?: number | null
}

const DATABASE_URL = 'postgres://queue:none@db.internal:5432/agent'

// Captured before anything is mocked so the real modules can be put back for
// the sibling files that run after this one in the same bun process.
const realPg = await import('pg')

/**
 * A stand-in for pg.Pool that records how the service uses it.
 *
 * Constructor options are kept (which database, which TLS), `end` calls are
 * counted (shutdown must end the pool once), 'error' listeners are collected
 * (idle-client errors must be absorbed), and every query is logged and
 * answered from a per-test script of responses - an Error in the script is
 * what the database failing looks like to the caller.
 */
class FakePool {
  readonly options: unknown
  endCalls = 0
  errorListeners: Array<(err: unknown) => void> = []

  constructor(options: unknown) {
    this.options = options
    pools.push(this)
  }

  on(event: string, listener: (err: unknown) => void): this {
    if (event === 'error') this.errorListeners.push(listener)
    return this
  }

  query(text: unknown, values?: unknown[]): Promise<QueryResponse> {
    calls.push({ text: String(text), values })
    const next = script.shift()
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next ?? { rows: [], rowCount: 0 })
  }

  async end(): Promise<void> {
    this.endCalls++
  }
}

let pools: FakePool[] = []
let calls: QueryCall[] = []
let script: Array<QueryResponse | Error> = []

mock.module('pg', () => ({ Pool: FakePool, default: { Pool: FakePool } }))

// The real logger writes to console and disk; neither belongs in a unit run.
mock.module('../../src/lib/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}))

const { TaskQueueService } = await import(
  '../../src/api/services/task-queue-service'
)

/** A database row shaped like agent_tasks, with test-friendly defaults. */
function taskRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'task-1',
    agent_id: 'agent-1',
    task_type: 'crawl',
    payload: { type: 'crawl', data: { url: 'https://example.test' } },
    priority: 5,
    status: 'pending',
    retry_count: 0,
    max_retries: 3,
    created_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('taskQueueServiceContract', () => {
  let service: TaskQueueServiceInstance

  beforeEach(() => {
    pools = []
    calls = []
    script = []
    service = new TaskQueueService({ databaseUrl: DATABASE_URL })
  })

  afterEach(async () => {
    // The constructor starts a 30s lease heartbeat; shutdown clears it so
    // this file leaves nothing running behind it.
    await service.shutdown()
  })

  afterAll(async () => {
    // Put the real modules back before sibling files import them.
    mock.module('pg', () => realPg)
    const realLogger = await import('../../src/lib/logger')
    mock.module('../../src/lib/logger', () => realLogger)
    mock.restore()
  })

  describe('TaskQueueService construction', () => {
    it('connects a pool to exactly the database it was configured with', () => {
      expect(pools).toHaveLength(1)
      const options = pools[0].options as {
        connectionString: unknown
        ssl: unknown
      }
      expect(options.connectionString).toBe(DATABASE_URL)
      expect(options.ssl).toBeUndefined()
    })

    it('asks pg for TLS on neon databases without pinning certificates', async () => {
      const neon = new TaskQueueService({
        databaseUrl:
          'postgres://queue:none@ep-1.eu-central-1.aws.neon.tech/agent',
      })
      try {
        const options = pools[1].options as { ssl: unknown }
        expect(options.ssl).toEqual({ rejectUnauthorized: false })
      } finally {
        await neon.shutdown()
      }
    })

    it('absorbs errors raised by an idle pool client', () => {
      const listeners = pools[0].errorListeners
      // pg emits 'error' on the pool for idle-client failures; a listener
      // that is missing (or rethrows) turns a background hiccup into an
      // unhandled error that takes the worker down.
      expect(listeners.length).toBeGreaterThan(0)
      for (const listener of listeners) {
        expect(() =>
          listener(new Error('idle client terminated')),
        ).not.toThrow()
      }
    })
  })

  describe('TaskQueueService.shutdown', () => {
    it('ends the pool exactly once however often it is called', async () => {
      await service.shutdown()
      await service.shutdown()
      expect(pools[0].endCalls).toBe(1)
    })
  })

  describe('TaskQueueService.createTask', () => {
    it('persists a pending task with the documented defaults', async () => {
      const payload = { type: 'crawl', data: { url: 'https://example.test' } }
      const stored = taskRow({
        id: 'generated-id',
        status: 'pending',
        priority: 0,
        max_retries: 3,
      })
      script = [{ rows: [stored], rowCount: 1 }]

      const task = await service.createTask({
        agentId: 'agent-1',
        taskType: 'crawl',
        payload,
      })

      const values = calls[0].values as unknown[]
      // The row Postgres is asked to store: a fresh UUID for the task, the
      // caller's identity, the payload serialised, and the defaults the
      // contract promises - priority 0, three retries, no assignee, empty
      // metadata, an ISO-8601 creation instant.
      expect(values[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(values[1]).toBe('agent-1')
      expect(values[2]).toBe('crawl')
      expect(values[3]).toBe(JSON.stringify(payload))
      expect(values[4]).toBe(0)
      expect(values[5]).toBe(3)
      expect(values[6]).toBeNull()
      expect(values[7]).toBe('{}')
      expect(new Date(values[8] as string).toISOString()).toBe(values[8])

      // And the task the caller gets back is the row the database returned,
      // not a fabrication of the input.
      expect(task.id).toBe('generated-id')
      expect(task.agentId).toBe('agent-1')
      expect(task.taskType).toBe('crawl')
      expect(task.payload).toEqual(payload)
      expect(task.priority).toBe(0)
      expect(task.status).toBe('pending')
      expect(task.maxRetries).toBe(3)
    })

    it("persists the caller's priority, retries, assignee and metadata", async () => {
      const payload = { type: 'summarise', data: { doc: 4 } }
      script = [{ rows: [taskRow()], rowCount: 1 }]

      await service.createTask({
        agentId: 'agent-2',
        taskType: 'summarise',
        payload,
        priority: 7,
        maxRetries: 9,
        assignedBy: 'queen-bee',
        metadata: { source: 'suite' },
      })

      expect(calls[0].values).toEqual([
        expect.any(String),
        'agent-2',
        'summarise',
        JSON.stringify(payload),
        7,
        9,
        'queen-bee',
        '{"source":"suite"}',
        expect.any(String),
      ])
    })

    it('wraps a database failure in "Failed to create task"', async () => {
      script = [new Error('insert exploded')]
      await expect(
        service.createTask({
          agentId: 'agent-1',
          taskType: 'crawl',
          payload: { type: 'crawl', data: {} },
        }),
      ).rejects.toThrow('Failed to create task: insert exploded')
    })
  })

  describe('TaskQueueService.dequeueNextTask', () => {
    it('sweeps expired leases before claiming, and reports an empty queue as null', async () => {
      // The sweep query is answered with a full row to prove its result is
      // discarded: if the claim read the first response, this would come back
      // as a task instead of null.
      script = [
        { rows: [taskRow({ id: 'not-the-claim' })], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]

      await expect(service.dequeueNextTask('agent-1')).resolves.toBeNull()
      expect(calls).toHaveLength(2)
    })

    it('returns the task the atomic claim matched', async () => {
      const claimed = taskRow({
        id: 'the-claim',
        status: 'running',
        started_at: '2026-02-01T00:01:00.000Z',
      })
      script = [
        { rows: [], rowCount: 0 },
        { rows: [claimed], rowCount: 1 },
      ]

      const task = await service.dequeueNextTask('agent-1')

      expect(task).not.toBeNull()
      expect(task?.id).toBe('the-claim')
      expect(task?.status).toBe('running')
      expect(task?.startedAt).toBe('2026-02-01T00:01:00.000Z')
    })

    it('claims under the worker identity taken from HOSTNAME', async () => {
      const saved = process.env.HOSTNAME
      process.env.HOSTNAME = 'bee-host-7'
      try {
        // The worker identity is chosen when the service is built, so this
        // test constructs its own rather than using the beforeEach one.
        const svc = new TaskQueueService({ databaseUrl: DATABASE_URL })
        try {
          script = [
            { rows: [], rowCount: 0 },
            { rows: [taskRow()], rowCount: 1 },
          ]
          await svc.dequeueNextTask('agent-1')
          // The claim names its owner so a later renewal can tell this worker
          // from any other holding the same task.
          expect(calls[1].values).toEqual(['agent-1', 'bee-host-7'])
        } finally {
          await svc.shutdown()
        }
      } finally {
        if (saved === undefined) delete process.env.HOSTNAME
        else process.env.HOSTNAME = saved
      }
    })

    it('falls back to worker-<pid> when HOSTNAME is unset', async () => {
      const saved = process.env.HOSTNAME
      delete process.env.HOSTNAME
      try {
        const svc = new TaskQueueService({ databaseUrl: DATABASE_URL })
        try {
          script = [
            { rows: [], rowCount: 0 },
            { rows: [taskRow()], rowCount: 1 },
          ]
          await svc.dequeueNextTask('agent-1')
          expect(calls[1].values).toEqual(['agent-1', `worker-${process.pid}`])
        } finally {
          await svc.shutdown()
        }
      } finally {
        if (saved === undefined) delete process.env.HOSTNAME
        else process.env.HOSTNAME = saved
      }
    })

    it('still claims when the stale-lease sweep itself fails', async () => {
      // The sweep is best-effort housekeeping: its failure must not block a
      // claim that would otherwise succeed.
      script = [
        new Error('sweep exploded'),
        { rows: [taskRow({ id: 'claimed-anyway' })], rowCount: 1 },
      ]

      const task = await service.dequeueNextTask('agent-1')
      expect(task?.id).toBe('claimed-anyway')
    })

    it('wraps a failed claim in "Failed to dequeue task"', async () => {
      script = [{ rows: [], rowCount: 0 }, new Error('claim exploded')]
      await expect(service.dequeueNextTask('agent-1')).rejects.toThrow(
        'Failed to dequeue task: claim exploded',
      )
    })
  })

  describe('TaskQueueService.renewLease', () => {
    it('reports a renewal only while this worker still owns a running task', async () => {
      script = [{ rows: [], rowCount: 1 }]
      await expect(service.renewLease('task-1', 'worker-me')).resolves.toBe(
        true,
      )
      expect(calls[0].values).toEqual(['task-1', 'worker-me'])
    })

    it('reports no renewal when nothing matched or the count is unknown', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(service.renewLease('task-1', 'worker-me')).resolves.toBe(
        false,
      )

      script = [{ rows: [], rowCount: null }]
      await expect(service.renewLease('task-1', 'worker-me')).resolves.toBe(
        false,
      )
    })

    it('reports no renewal when the database fails', async () => {
      script = [new Error('renewal exploded')]
      await expect(service.renewLease('task-1', 'worker-me')).resolves.toBe(
        false,
      )
    })
  })

  describe('TaskQueueService.reclaimStaleLeases', () => {
    it('returns how many stale leases were reset to pending', async () => {
      script = [{ rows: [], rowCount: 4 }]
      await expect(service.reclaimStaleLeases()).resolves.toBe(4)
    })

    it('reports zero when none were stale, the count is unknown, or the database fails', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(service.reclaimStaleLeases()).resolves.toBe(0)

      script = [{ rows: [], rowCount: null }]
      await expect(service.reclaimStaleLeases()).resolves.toBe(0)

      script = [new Error('sweep exploded')]
      await expect(service.reclaimStaleLeases()).resolves.toBe(0)
    })
  })

  describe('TaskQueueService.updateTaskStatus', () => {
    it('writes the new status and a JSON-encoded result', async () => {
      script = [{ rows: [], rowCount: 1 }]
      await expect(
        service.updateTaskStatus('task-1', 'completed', { ok: true }),
      ).resolves.toBe(true)
      expect(calls[0].values).toEqual(['task-1', 'completed', '{"ok":true}'])
    })

    it('reports false when the task no longer exists', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(
        service.updateTaskStatus('task-1', 'failed', undefined, 'boom'),
      ).resolves.toBe(false)
    })

    it('refuses a task that belongs to another agent, without attempting the update', async () => {
      script = [{ rows: [{ agent_id: 'someone-else' }], rowCount: 1 }]
      await expect(
        service.updateTaskStatus(
          'task-1',
          'completed',
          undefined,
          undefined,
          'agent-1',
        ),
      ).resolves.toBe(false)
      // Only the ownership check ran; the update never reached the database.
      expect(calls).toHaveLength(1)
    })

    it('checks ownership and then updates when the task is the agent own', async () => {
      script = [
        { rows: [{ agent_id: 'agent-1' }], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ]
      await expect(
        service.updateTaskStatus(
          'task-1',
          'completed',
          undefined,
          undefined,
          'agent-1',
        ),
      ).resolves.toBe(true)
      expect(calls).toHaveLength(2)
    })

    it('reports false for an unknown task when ownership was requested', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(
        service.updateTaskStatus(
          'missing',
          'failed',
          undefined,
          undefined,
          'agent-1',
        ),
      ).resolves.toBe(false)
      expect(calls).toHaveLength(1)
    })

    it('reports false when the database fails', async () => {
      script = [new Error('update exploded')]
      await expect(service.updateTaskStatus('task-1', 'failed')).resolves.toBe(
        false,
      )
    })
  })

  describe('TaskQueueService.retryTask', () => {
    it('requeues a task only while a row comes back', async () => {
      script = [
        { rows: [taskRow({ status: 'pending', retry_count: 1 })], rowCount: 1 },
      ]
      await expect(service.retryTask('task-1')).resolves.toBe(true)
      expect(calls[0].values).toEqual(['task-1'])

      script = [{ rows: [], rowCount: 0 }]
      await expect(service.retryTask('task-1')).resolves.toBe(false)
    })

    it('reports false when the database fails', async () => {
      script = [new Error('retry exploded')]
      await expect(service.retryTask('task-1')).resolves.toBe(false)
    })
  })

  describe('TaskQueueService.getTasksByStatus', () => {
    it("returns the agent's tasks as TaskItems, fifty by default", async () => {
      script = [
        {
          rows: [taskRow({ id: 'a' }), taskRow({ id: 'b', status: 'pending' })],
          rowCount: 2,
        },
      ]
      const tasks = await service.getTasksByStatus('agent-1', 'pending')
      expect(tasks.map((t: TaskItem) => t.id)).toEqual(['a', 'b'])
      expect(tasks[1].status).toBe('pending')
      expect(calls[0].values).toEqual(['agent-1', 'pending', 50])

      script = [{ rows: [], rowCount: 0 }]
      await service.getTasksByStatus('agent-1', 'pending', 7)
      expect(calls[1].values).toEqual(['agent-1', 'pending', 7])
    })

    it('returns an empty list for an agent with no such tasks', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(
        service.getTasksByStatus('agent-1', 'pending'),
      ).resolves.toEqual([])
    })

    it('wraps a database failure in "Failed to get tasks"', async () => {
      script = [new Error('listing exploded')]
      await expect(
        service.getTasksByStatus('agent-1', 'pending'),
      ).rejects.toThrow('Failed to get tasks: listing exploded')
    })
  })

  describe('TaskQueueService.getTask', () => {
    it('maps a database row to a TaskItem', async () => {
      script = [
        {
          rows: [
            taskRow({
              id: 't9',
              agent_id: 'agent-9',
              task_type: 'index',
              priority: 2,
              status: 'running',
              retry_count: 1,
              max_retries: 5,
              created_at: '2026-02-01T00:00:00.000Z',
              started_at: '2026-02-01T00:05:00.000Z',
              completed_at: null,
              error_message: null,
              assigned_by: 'queen-bee',
            }),
          ],
          rowCount: 1,
        },
      ]
      const task = await service.getTask('t9')
      expect(task).toEqual({
        id: 't9',
        agentId: 'agent-9',
        taskType: 'index',
        payload: { type: 'crawl', data: { url: 'https://example.test' } },
        priority: 2,
        status: 'running',
        retryCount: 1,
        maxRetries: 5,
        createdAt: '2026-02-01T00:00:00.000Z',
        startedAt: '2026-02-01T00:05:00.000Z',
        completedAt: null,
        errorMessage: null,
        assignedBy: 'queen-bee',
        result: undefined,
        metadata: undefined,
      })
      expect(calls[0].values).toEqual(['t9'])
    })

    it('parses jsonb that came back as text and drops non-object metadata', async () => {
      // A jsonb column can come back from some drivers as text, and holds
      // whatever JSON it holds - scalars and arrays included. The contract
      // is that payloads and results are decoded, while metadata that is not
      // an object reads as absent rather than crashing a later reader.
      script = [
        {
          rows: [
            taskRow({
              payload: '{"type":"crawl","data":{"url":"https://example.test"}}',
              result: '{"answer":7}',
              metadata: '{"tag":"x"}',
            }),
          ],
          rowCount: 1,
        },
      ]
      const parsed = await service.getTask('task-1')
      expect(parsed?.payload).toEqual({
        type: 'crawl',
        data: { url: 'https://example.test' },
      })
      expect(parsed?.result).toEqual({ answer: 7 })
      expect(parsed?.metadata).toEqual({ tag: 'x' })

      script = [
        {
          rows: [taskRow({ result: null, metadata: '[1,2]' })],
          rowCount: 1,
        },
      ]
      const arrayMetadata = await service.getTask('task-1')
      expect(arrayMetadata?.result).toBeUndefined()
      expect(arrayMetadata?.metadata).toBeUndefined()

      script = [
        { rows: [taskRow({ metadata: '"just-a-string"' })], rowCount: 1 },
      ]
      const scalarMetadata = await service.getTask('task-1')
      expect(scalarMetadata?.metadata).toBeUndefined()
    })

    it('reports a missing task as null', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(service.getTask('missing')).resolves.toBeNull()
    })

    it('wraps a database failure in "Failed to get task"', async () => {
      script = [new Error('lookup exploded')]
      await expect(service.getTask('task-1')).rejects.toThrow(
        'Failed to get task: lookup exploded',
      )
    })
  })

  describe('TaskQueueService.cancelTask', () => {
    it('cancels a task that is still open for cancellation', async () => {
      script = [{ rows: [], rowCount: 1 }]
      await expect(service.cancelTask('task-1')).resolves.toBe(true)
      expect(calls[0].values).toEqual(['task-1'])
    })

    it('reports false when nothing was cancelled or the database fails', async () => {
      script = [{ rows: [], rowCount: 0 }]
      await expect(service.cancelTask('task-1')).resolves.toBe(false)

      script = [new Error('cancel exploded')]
      await expect(service.cancelTask('task-1')).resolves.toBe(false)
    })
  })

  describe('TaskQueueService.deleteTask', () => {
    it('deletes a task and reports whether a row went', async () => {
      script = [{ rows: [], rowCount: 1 }]
      await expect(service.deleteTask('task-1')).resolves.toBe(true)
      expect(calls[0].values).toEqual(['task-1'])

      script = [{ rows: [], rowCount: 0 }]
      await expect(service.deleteTask('task-1')).resolves.toBe(false)
    })

    it('reports false when the database fails', async () => {
      script = [new Error('delete exploded')]
      await expect(service.deleteTask('task-1')).resolves.toBe(false)
    })
  })

  describe('TaskQueueService.getTaskHistory', () => {
    it("returns the agent's history, a hundred by default", async () => {
      script = [
        {
          rows: [taskRow({ id: 'newest' }), taskRow({ id: 'oldest' })],
          rowCount: 2,
        },
      ]
      const history = await service.getTaskHistory('agent-1')
      expect(history.map((t: TaskItem) => t.id)).toEqual(['newest', 'oldest'])
      expect(calls[0].values).toEqual(['agent-1', 100])

      script = [{ rows: [], rowCount: 0 }]
      await service.getTaskHistory('agent-1', 5)
      expect(calls[1].values).toEqual(['agent-1', 5])
    })

    it('wraps a database failure in "Failed to get task history"', async () => {
      script = [new Error('history exploded')]
      await expect(service.getTaskHistory('agent-1')).rejects.toThrow(
        'Failed to get task history: history exploded',
      )
    })
  })

  describe('TaskQueueService.getQueueStats', () => {
    it('counts the queue per status as numbers', async () => {
      // Postgres COUNT(*) arrives as text; the caller must get numbers.
      script = [
        {
          rows: [
            {
              total: '12',
              pending: '7',
              running: '3',
              completed: '1',
              failed: '1',
            },
          ],
          rowCount: 1,
        },
      ]
      await expect(service.getQueueStats('agent-1')).resolves.toEqual({
        total: 12,
        pending: 7,
        running: 3,
        completed: 1,
        failed: 1,
      })
    })

    it('scopes the count to one agent when asked, and counts the whole queue when not', async () => {
      const counts = {
        rows: [
          {
            total: '0',
            pending: '0',
            running: '0',
            completed: '0',
            failed: '0',
          },
        ],
        rowCount: 1,
      }
      script = [counts, counts]

      await service.getQueueStats('agent-1')
      expect(calls[0].values).toEqual(['agent-1'])

      await service.getQueueStats()
      expect(calls[1].values).toEqual([])
    })

    it('wraps a database failure in "Failed to get queue stats"', async () => {
      script = [new Error('stats exploded')]
      await expect(service.getQueueStats()).rejects.toThrow(
        'Failed to get queue stats: stats exploded',
      )
    })
  })
})
