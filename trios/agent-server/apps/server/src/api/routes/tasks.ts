/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Task Queue HTTP Routes
 *
 * Endpoints for managing agent task queue
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type {
  TaskPayload,
  TaskQueueService,
} from '../services/task-queue-service'

interface TaskQueueRouteDeps {
  service: TaskQueueService
}

const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])

const CreateTaskBodySchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  taskType: z.string().min(1, 'taskType is required'),
  payload: z.object({
    type: z.string(),
    data: z.record(z.any()),
  }),
  priority: z.number().int().min(0).max(100).optional().default(0),
  maxRetries: z.number().int().min(0).max(10).optional().default(3),
  assignedBy: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

const UpdateTaskBodySchema = z.object({
  status: TaskStatusSchema.optional(),
  result: z.any().optional(),
  errorMessage: z.string().optional(),
})

const TaskIdParamSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
})

const ListTasksQuerySchema = z.object({
  agentId: z.string().optional(),
  status: TaskStatusSchema.optional(),
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

export function createTaskQueueRoutes(deps: TaskQueueRouteDeps) {
  const { service } = deps

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await service.shutdown()
  })
  process.on('SIGINT', async () => {
    await service.shutdown()
  })

  return (
    new Hono()
      // POST /api/tasks - Create a new task
      .post('/', zValidator('json', CreateTaskBodySchema), async (c) => {
        const {
          agentId,
          taskType,
          payload,
          priority,
          maxRetries,
          assignedBy,
          metadata,
        } = c.req.valid('json')

        try {
          const task = await service.createTask({
            agentId,
            taskType,
            payload: payload as TaskPayload,
            priority,
            maxRetries,
            assignedBy,
            metadata,
          })
          return c.json(
            {
              success: true,
              task,
            },
            201,
          )
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to create task',
            },
            500,
          )
        }
      })

      // GET /api/tasks - List tasks with filters
      .get('/', zValidator('query', ListTasksQuerySchema), async (c) => {
        const { agentId, status, limit } = c.req.valid('query')

        try {
          // For now, get by status if provided, otherwise get all pending
          if (agentId && status) {
            const tasks = await service.getTasksByStatus(agentId, status, limit)
            return c.json({ tasks, total: tasks.length })
          }

          // If agentId provided without status, get all tasks
          if (agentId) {
            const tasks = await service.getTaskHistory(agentId, limit)
            return c.json({ tasks, total: tasks.length })
          }

          // Get queue stats if no filters
          const stats = await service.getQueueStats()
          return c.json({ stats })
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error ? error.message : 'Failed to list tasks',
            },
            500,
          )
        }
      })

      // GET /api/tasks/queue/:agentId - Get next task for agent (dequeue)
      .get('/queue/:agentId', async (c) => {
        const agentId = c.req.param('agentId')

        try {
          const task = await service.dequeueNextTask(agentId)

          if (!task) {
            return c.json({
              success: true,
              task: null,
              message: 'No pending tasks',
            })
          }

          return c.json({
            success: true,
            task,
          })
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to dequeue task',
            },
            500,
          )
        }
      })

      // GET /api/tasks/stats - Get queue statistics
      .get('/stats', async (c) => {
        const agentId = c.req.query('agentId')

        try {
          const stats = await service.getQueueStats(agentId)
          return c.json({ stats })
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error ? error.message : 'Failed to get stats',
            },
            500,
          )
        }
      })

      // GET /api/tasks/:taskId - Get specific task
      .get('/:taskId', zValidator('param', TaskIdParamSchema), async (c) => {
        const { taskId } = c.req.valid('param')
        const agentId = c.req.query('agentId')

        try {
          const task = await service.getTask(taskId)

          if (!task) {
            return c.json({ error: 'Task not found' }, 404)
          }

          if (agentId && task.agentId !== agentId) {
            return c.json({ error: 'Forbidden' }, 403)
          }

          return c.json({ task })
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error ? error.message : 'Failed to get task',
            },
            500,
          )
        }
      })

      // PUT /api/tasks/:taskId - Update task status
      .put(
        '/:taskId',
        zValidator('param', TaskIdParamSchema),
        zValidator('query', z.object({ agentId: z.string().optional() })),
        zValidator('json', UpdateTaskBodySchema),
        async (c) => {
          const { taskId } = c.req.valid('param')
          const { agentId } = c.req.valid('query')
          const { status, result, errorMessage } = c.req.valid('json')

          try {
            let success = false

            if (status) {
              success = await service.updateTaskStatus(
                taskId,
                status,
                result,
                errorMessage,
                agentId,
              )
            }

            if (!success) {
              return c.json(
                { error: 'Task not found or could not be updated' },
                404,
              )
            }

            return c.json({
              success: true,
              message: 'Task updated',
            })
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to update task',
              },
              500,
            )
          }
        },
      )

      // POST /api/tasks/:taskId/retry - Retry a failed task
      .post(
        '/:taskId/retry',
        zValidator('param', TaskIdParamSchema),
        async (c) => {
          const { taskId } = c.req.valid('param')

          try {
            const success = await service.retryTask(taskId)

            if (!success) {
              return c.json(
                { error: 'Task not found or retry limit exceeded' },
                404,
              )
            }

            return c.json({
              success: true,
              message: 'Task queued for retry',
            })
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to retry task',
              },
              500,
            )
          }
        },
      )

      // POST /api/tasks/:taskId/cancel - Cancel a task
      .post(
        '/:taskId/cancel',
        zValidator('param', TaskIdParamSchema),
        async (c) => {
          const { taskId } = c.req.valid('param')

          try {
            const success = await service.cancelTask(taskId)

            if (!success) {
              return c.json(
                { error: 'Task not found or already completed/cancelled' },
                404,
              )
            }

            return c.json({
              success: true,
              message: 'Task cancelled',
            })
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to cancel task',
              },
              500,
            )
          }
        },
      )

      // DELETE /api/tasks/:taskId - Delete a task
      .delete('/:taskId', zValidator('param', TaskIdParamSchema), async (c) => {
        const { taskId } = c.req.valid('param')

        try {
          const success = await service.deleteTask(taskId)

          if (!success) {
            return c.json({ error: 'Task not found' }, 404)
          }

          return c.json({
            success: true,
            message: 'Task deleted',
          })
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to delete task',
            },
            500,
          )
        }
      })
  )
}
