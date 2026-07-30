/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * TaskQueueService — Manage agent task queue with priorities and retry logic
 */

import * as crypto from 'node:crypto'
import { Pool } from 'pg'
import { withDbRetry } from '../../lib/db/retry'
import { logger } from '../../lib/logger'

export interface TaskQueueDeps {
  databaseUrl: string
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TaskPayload {
  type: string
  data: Record<string, unknown>
}

export interface CreateTaskInput {
  agentId: string
  taskType: string
  payload: TaskPayload
  priority?: number
  maxRetries?: number
  assignedBy?: string
  metadata?: Record<string, unknown>
}

export interface TaskItem {
  id: string
  agentId: string
  taskType: string
  payload: TaskPayload
  priority: number
  status: TaskStatus
  retryCount: number
  maxRetries: number
  createdAt: string
  startedAt?: string
  completedAt?: string
  errorMessage?: string
  result?: unknown
  assignedBy?: string
  metadata?: Record<string, unknown>
}

export class TaskQueueService {
  private pool: Pool
  private workerId: string
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private isShutdown = false

  constructor(private deps: TaskQueueDeps) {
    this.pool = new Pool({
      connectionString: deps.databaseUrl,
      ssl: deps.databaseUrl.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : undefined,
    })
    this.workerId = process.env.HOSTNAME || `worker-${process.pid}`
    this.pool.on('error', (err) => {
      logger.warn('TaskQueueService pool client error', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    this.startLeaseHeartbeat()
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return
    }
    this.isShutdown = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    await this.pool.end()
  }

  /**
   * Create a new task in the queue
   */
  async createTask(input: CreateTaskInput): Promise<TaskItem> {
    logger.info('Creating task', {
      agentId: input.agentId,
      taskType: input.taskType,
      priority: input.priority ?? 0,
    })

    try {
      const taskId = crypto.randomUUID()
      const now = new Date().toISOString()

      const result = await withDbRetry(() =>
        this.pool.query(
          `
        INSERT INTO agent_tasks (
          id, agent_id, task_type, payload, priority, status, 
          max_retries, assigned_by, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
        RETURNING *
      `,
          [
            taskId,
            input.agentId,
            input.taskType,
            JSON.stringify(input.payload),
            input.priority ?? 0,
            input.maxRetries ?? 3,
            input.assignedBy ?? null,
            JSON.stringify(input.metadata ?? {}),
            now,
          ],
        ),
      )

      return this.mapRowToTask(result.rows[0])
    } catch (error) {
      logger.error('Failed to create task', {
        agentId: input.agentId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(
        `Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Get next pending task for an agent (highest priority, oldest first)
   */
  async dequeueNextTask(agentId: string): Promise<TaskItem | null> {
    logger.info('Dequeuing next task', { agentId, workerId: this.workerId })

    try {
      // First, recover tasks whose leases expired while a worker was processing them.
      await this.reclaimStaleLeases()

      // Atomic claim: SELECT + UPDATE in one statement so the row lock is not released early.
      // Pending tasks are claimable, as are running tasks with no/missing lease (stale).
      const result = await withDbRetry(() =>
        this.pool.query(
          `
        WITH next_task AS (
          SELECT id
          FROM agent_tasks
          WHERE agent_id = $1
            AND (
              status = 'pending'
              OR (
                status = 'running'
                AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
              )
            )
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE agent_tasks
        SET
          status = 'running',
          started_at = NOW(),
          lease_expires_at = NOW() + interval '5 minutes',
          lease_owner = $2
        FROM next_task
        WHERE agent_tasks.id = next_task.id
        RETURNING agent_tasks.*
      `,
          [agentId, this.workerId],
        ),
      )

      if (result.rows.length === 0) {
        return null
      }

      return this.mapRowToTask(result.rows[0])
    } catch (error) {
      logger.error('Failed to dequeue task', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(
        `Failed to dequeue task: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Extend the lease on a running task that this worker still owns.
   */
  async renewLease(taskId: string, leaseOwner: string): Promise<boolean> {
    logger.info('Renewing task lease', { taskId, leaseOwner })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(
          `
        UPDATE agent_tasks
        SET lease_expires_at = NOW() + interval '5 minutes'
        WHERE id = $1
          AND status = 'running'
          AND lease_owner = $2
      `,
          [taskId, leaseOwner],
        ),
      )

      return result.rowCount !== null && result.rowCount > 0
    } catch (error) {
      logger.error('Failed to renew task lease', {
        taskId,
        leaseOwner,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Recover tasks whose leases have expired while still marked running.
   */
  async reclaimStaleLeases(): Promise<number> {
    logger.info('Reclaiming stale task leases')

    try {
      const result = await withDbRetry(() =>
        this.pool.query(
          `
        UPDATE agent_tasks
        SET
          status = 'pending',
          lease_expires_at = NULL,
          lease_owner = NULL,
          retry_count = LEAST(retry_count + 1, max_retries)
        WHERE status = 'running'
          AND lease_expires_at < NOW()
      `,
        ),
      )

      const count = result.rowCount ?? 0
      if (count > 0) {
        logger.info('Reclaimed stale task leases', { count })
      }
      return count
    } catch (error) {
      logger.error('Failed to reclaim stale leases', {
        error: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }

  private startLeaseHeartbeat(): void {
    if (this.heartbeatTimer) return
    // Reclaim stale leases periodically so crashed workers do not permanently block tasks.
    this.heartbeatTimer = setInterval(() => {
      void this.reclaimStaleLeases()
    }, 30_000)
  }

  /**
   * Update task status
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: unknown,
    errorMessage?: string,
    agentId?: string,
  ): Promise<boolean> {
    logger.info('Updating task status', { taskId, status, agentId })

    try {
      // Verify the task belongs to the agent if provided
      if (agentId) {
        const ownerResult = await withDbRetry(() =>
          this.pool.query(`SELECT agent_id FROM agent_tasks WHERE id = $1`, [
            taskId,
          ]),
        )
        if (ownerResult.rows.length === 0) {
          return false
        }
        if (ownerResult.rows[0].agent_id !== agentId) {
          throw new Error(`Task ${taskId} does not belong to agent ${agentId}`)
        }
      }

      const updates: string[] = ['status = $2']
      const values: unknown[] = [taskId, status]
      let paramIndex = 3

      if (status === 'completed') {
        updates.push(`completed_at = NOW()`)
      }

      if (result !== undefined) {
        updates.push(`result = $${paramIndex}`)
        values.push(JSON.stringify(result))
        paramIndex++
      }

      if (errorMessage !== undefined) {
        updates.push(`error_message = $${paramIndex}`)
        values.push(errorMessage)
        paramIndex++
      }

      const updateQuery = `UPDATE agent_tasks SET ${updates.join(', ')} WHERE id = $1`
      const updateResult = await withDbRetry(() =>
        this.pool.query(updateQuery, values),
      )

      return updateResult.rowCount !== null && updateResult.rowCount > 0
    } catch (error) {
      logger.error('Failed to update task status', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Increment retry count and reset status to pending
   */
  async retryTask(taskId: string): Promise<boolean> {
    logger.info('Retrying task', { taskId })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(
          `
        UPDATE agent_tasks 
        SET 
          status = 'pending',
          retry_count = retry_count + 1,
          started_at = NULL,
          error_message = NULL
        WHERE id = $1 AND retry_count < max_retries
        RETURNING *
      `,
          [taskId],
        ),
      )

      return result.rows.length > 0
    } catch (error) {
      logger.error('Failed to retry task', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(
    agentId: string,
    status: TaskStatus,
    limit: number = 50,
  ): Promise<TaskItem[]> {
    logger.info('Getting tasks by status', { agentId, status, limit })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(
          `SELECT * FROM agent_tasks WHERE agent_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`,
          [agentId, status, limit],
        ),
      )

      return result.rows.map((row) => this.mapRowToTask(row))
    } catch (error) {
      logger.error('Failed to get tasks by status', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(
        `Failed to get tasks: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Get task by ID
   */
  async getTask(taskId: string): Promise<TaskItem | null> {
    logger.info('Getting task', { taskId })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(`SELECT * FROM agent_tasks WHERE id = $1`, [taskId]),
      )

      if (result.rows.length === 0) {
        return null
      }

      return this.mapRowToTask(result.rows[0])
    } catch (error) {
      logger.error('Failed to get task', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(
        `Failed to get task: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    logger.info('Cancelling task', { taskId })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(
          `UPDATE agent_tasks SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
          [taskId],
        ),
      )

      return result.rowCount !== null && result.rowCount > 0
    } catch (error) {
      logger.error('Failed to cancel task', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<boolean> {
    logger.info('Deleting task', { taskId })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(`DELETE FROM agent_tasks WHERE id = $1`, [taskId]),
      )
      return result.rowCount !== null && result.rowCount > 0
    } catch (error) {
      logger.error('Failed to delete task', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Get task history for an agent
   */
  async getTaskHistory(
    agentId: string,
    limit: number = 100,
  ): Promise<TaskItem[]> {
    logger.info('Getting task history', { agentId, limit })

    try {
      const result = await withDbRetry(() =>
        this.pool.query(
          `SELECT * FROM agent_tasks WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [agentId, limit],
        ),
      )

      return result.rows.map((row) => this.mapRowToTask(row))
    } catch (error) {
      logger.error('Failed to get task history', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(
        `Failed to get task history: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(agentId?: string): Promise<{
    total: number
    pending: number
    running: number
    completed: number
    failed: number
  }> {
    logger.info('Getting queue stats', { agentId })

    try {
      const whereClause = agentId ? 'WHERE agent_id = $1' : ''
      const values = agentId ? [agentId] : []

      const result = await withDbRetry(() =>
        this.pool.query(
          `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'running') as running,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM agent_tasks ${whereClause}
      `,
          values,
        ),
      )

      const row = result.rows[0]
      return {
        total: parseInt(row.total, 10),
        pending: parseInt(row.pending, 10),
        running: parseInt(row.running, 10),
        completed: parseInt(row.completed, 10),
        failed: parseInt(row.failed, 10),
      }
    } catch (error) {
      logger.error('Failed to get queue stats', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(
        `Failed to get queue stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  private mapRowToTask(row: Record<string, unknown>): TaskItem {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      taskType: row.task_type as string,
      payload: parseJsonb(row.payload) as TaskPayload,
      priority: row.priority as number,
      status: row.status as TaskStatus,
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      createdAt: row.created_at as string,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
      errorMessage: row.error_message as string | undefined,
      result: row.result != null ? parseJsonb(row.result) : undefined,
      assignedBy: row.assigned_by as string | undefined,
      metadata: row.metadata != null ? parseJsonb(row.metadata) : undefined,
    }
  }
}

function parseJsonb(value: unknown): unknown {
  if (value == null) return undefined
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}
