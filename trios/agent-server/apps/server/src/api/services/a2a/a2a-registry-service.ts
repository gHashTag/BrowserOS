/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A2A (Agent-to-Agent) Registry Service
 *
 * Hybrid storage: PostgreSQL for persistent agent cards + in-memory for
 * realtime message queuing and SSE subscriptions.
 */

import { logger } from '../../../lib/logger'
import { PgAgentStore } from './pg-agent-store'

export interface A2aAgentCard {
  id: string
  name: string
  description: string
  capabilities: string[]
  version: string
  endpoint?: string
}

export interface A2aMessage {
  id: string
  sender: string
  recipient?: string
  type: string
  payload: unknown
  timestamp: string
}

export interface A2aTask {
  id: string
  title: string
  description: string
  state: string
  priority: number
  assignee: string
  createdAt: string
  updatedAt: string
}

type MessageHandler = (message: A2aMessage) => void

export class A2aRegistryService {
  private messageQueue = new Map<string, A2aMessage[]>()
  private tasks = new Map<string, A2aTask>()
  private subscribers = new Map<string, MessageHandler>()
  private memoryAgents = new Map<string, A2aAgentCard>()
  private memoryHeartbeats = new Map<string, number>()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private pg: PgAgentStore | null = null
  private pgReady = false
  private pgConfigured = false
  private pgError: string | null = null

  constructor(pgDsn?: string) {
    if (pgDsn) {
      this.pgConfigured = true
      this.pg = new PgAgentStore(pgDsn)
      this.initPg()
    }
    this.startHeartbeatWatchdog()
  }

  private async initPg(): Promise<void> {
    try {
      await this.pg!.connect()
      await this.pg!.ensureSchema()
      this.pgReady = true
      this.pgError = null
      logger.info('A2A registry PostgreSQL backend ready')
    } catch (err) {
      this.pgError = err instanceof Error ? err.message : String(err)
      logger.warn(
        'A2A PostgreSQL backend failed, falling back to memory-only',
        { error: this.pgError },
      )
    }
  }

  /// Whether agent registrations survive this process, and why not when they do not.
  ///
  /// The fallback to memory is deliberate - a registry that refuses to start
  /// because a database is unreachable is worse than one that keeps working
  /// locally. But it is also silent: a wrong DSN and no DSN at all produce the
  /// same running server, and the only difference is one `warn` line emitted
  /// once at startup. Anyone asking "is the state in the cloud yet?" then has
  /// to read logs from minutes ago and infer. Reporting it here makes that a
  /// question the server can answer about itself at any moment.
  backendStatus(): {
    durable: boolean
    configured: boolean
    error: string | null
  } {
    return {
      durable: this.pgReady,
      configured: this.pgConfigured,
      // Distinguishes "configured and still connecting" from "configured and
      // broken": both report durable=false, only the second carries a reason.
      error: this.pgError,
    }
  }

  destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.pg?.disconnect().catch(() => {})
  }

  async register(card: A2aAgentCard): Promise<void> {
    // Idempotency: skip if already registered with the same card data.
    const existing = this.memoryAgents.get(card.id)
    if (existing && JSON.stringify(existing) === JSON.stringify(card)) {
      this.memoryHeartbeats.set(card.id, Date.now())
      return
    }
    if (this.pgReady) {
      await this.pg!.upsertAgent(card, 'online')
    }
    const wasNew = !this.memoryAgents.has(card.id)
    this.memoryAgents.set(card.id, card)
    this.memoryHeartbeats.set(card.id, Date.now())
    if (wasNew) {
      logger.info('A2A agent registered', { agentId: card.id, name: card.name })
    }
  }

  async unregister(agentId: string): Promise<boolean> {
    // Idempotency: skip if already unregistered.
    if (!this.memoryAgents.has(agentId)) {
      return true
    }
    if (this.pgReady) {
      await this.pg!.markOffline(agentId)
    }
    this.memoryAgents.delete(agentId)
    this.memoryHeartbeats.delete(agentId)
    this.subscribers.delete(agentId)
    this.messageQueue.delete(agentId)
    logger.info('A2A agent unregistered', { agentId })
    return true
  }

  async heartbeat(agentId: string): Promise<boolean> {
    if (this.pgReady) {
      const ok = await this.pg!.heartbeat(agentId)
      if (ok) {
        this.memoryHeartbeats.set(agentId, Date.now())
      }
      return ok
    }
    // Memory-only fallback: accept heartbeats for registered agents.
    if (this.memoryAgents.has(agentId)) {
      this.memoryHeartbeats.set(agentId, Date.now())
      return true
    }
    return false
  }

  async listAgents(): Promise<A2aAgentCard[]> {
    if (this.pgReady) {
      return this.pg!.listAgents(true)
    }
    // Memory-only fallback: return agents with recent heartbeats.
    const threshold = 120_000
    const now = Date.now()
    return Array.from(this.memoryAgents.values()).filter((card) => {
      const last = this.memoryHeartbeats.get(card.id) ?? 0
      return now - last < threshold
    })
  }

  async listMatrix(): Promise<any[]> {
    if (this.pgReady) {
      return this.pg!.listMatrix()
    }
    return []
  }

  sendMessage(message: A2aMessage): boolean {
    const delivered = this.deliver(message)
    if (!delivered) {
      const target = message.recipient ?? '__broadcast__'
      const queue = this.messageQueue.get(target) ?? []
      queue.push(message)
      this.messageQueue.set(target, queue)
    }
    return delivered
  }

  assignTask(task: A2aTask, agentId: string): boolean {
    task.state = 'pending'
    task.assignee = agentId
    this.tasks.set(task.id, task)

    const msg: A2aMessage = {
      id: crypto.randomUUID(),
      sender: 'system',
      recipient: agentId,
      type: 'taskAssign',
      payload: task,
      timestamp: new Date().toISOString(),
    }

    const delivered = this.deliver(msg)
    if (!delivered) {
      const queue = this.messageQueue.get(agentId) ?? []
      queue.push(msg)
      this.messageQueue.set(agentId, queue)
    }

    logger.info('A2A task assigned', {
      taskId: task.id,
      agentId,
      title: task.title,
    })
    return delivered
  }

  updateTaskState(taskId: string, state: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.state = state
    task.updatedAt = new Date().toISOString()

    const msg: A2aMessage = {
      id: crypto.randomUUID(),
      sender: 'system',
      recipient: task.assignee,
      type: 'taskUpdate',
      payload: task,
      timestamp: new Date().toISOString(),
    }

    this.deliver(msg)
    return true
  }

  subscribe(agentId: string, handler: MessageHandler): void {
    this.subscribers.set(agentId, handler)
    this.flushQueue(agentId)
  }

  unsubscribe(agentId: string): void {
    this.subscribers.delete(agentId)
  }

  private deliver(message: A2aMessage): boolean {
    const target = message.recipient

    // Broadcast (no explicit recipient): fan out to all current subscribers.
    if (!target) {
      let anyDelivered = false
      for (const [agentId, handler] of this.subscribers) {
        if (agentId === message.sender) continue
        try {
          handler(message)
          anyDelivered = true
        } catch {
          // Drop failed broadcast deliveries; client can re-register.
        }
      }
      return anyDelivered
    }

    const handler = this.subscribers.get(target)
    if (handler) {
      try {
        handler(message)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  private flushQueue(agentId: string): void {
    const queue = this.messageQueue.get(agentId)
    if (!queue || queue.length === 0) return

    const handler = this.subscribers.get(agentId)
    if (!handler) return

    while (queue.length > 0) {
      const msg = queue.shift()
      if (msg) {
        try {
          handler(msg)
        } catch {
          queue.unshift(msg)
          break
        }
      }
    }

    if (queue.length === 0) {
      this.messageQueue.delete(agentId)
    }
  }

  private startHeartbeatWatchdog(): void {
    this.heartbeatInterval = setInterval(async () => {
      const threshold = 120_000
      const now = Date.now()

      if (this.pgReady) {
        try {
          const stale = await this.pg!.pruneOffline(90)
          for (const agentId of stale) {
            logger.warn('A2A agent marked offline due to missed heartbeats', {
              agentId,
            })
            this.subscribers.delete(agentId)
          }
        } catch (err) {
          logger.warn('A2A heartbeat watchdog PG error', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        // Memory-only pruning.
        for (const [agentId, last] of this.memoryHeartbeats) {
          if (now - last >= threshold) {
            logger.warn('A2A agent marked offline due to missed heartbeats', {
              agentId,
            })
            this.memoryAgents.delete(agentId)
            this.memoryHeartbeats.delete(agentId)
            this.subscribers.delete(agentId)
          }
        }
      }
    }, 60_000)
  }
}
