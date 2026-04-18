/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { MAX_LOG_ENTRIES } from '@trios/shared/constants/portable-agent'
import type { AgentLogEntry } from './config-schema'

export class LogCollector {
  private logs: AgentLogEntry[] = []
  private listeners: Set<(entry: AgentLogEntry) => void> = new Set()

  add(entry: AgentLogEntry): void {
    this.logs.push(entry)
    this.trim()
    this.notifyListeners(entry)
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.add({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      data,
    })
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.add({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      data,
    })
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.add({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      data,
    })
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.add({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      data,
    })
  }

  get(
    options: {
      tail?: number
      since?: string
      level?: 'debug' | 'info' | 'warn' | 'error'
    } = {},
  ): AgentLogEntry[] {
    let filtered = [...this.logs]

    if (options.since) {
      const sinceTime = new Date(options.since).getTime()
      filtered = filtered.filter(
        (log) => new Date(log.timestamp).getTime() >= sinceTime,
      )
    }

    if (options.level) {
      const levels: Record<string, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
      }
      const minLevel = levels[options.level] ?? 0
      filtered = filtered.filter((log) => levels[log.level] >= minLevel)
    }

    if (options.tail && options.tail > 0) {
      filtered = filtered.slice(-options.tail)
    }

    return filtered
  }

  getRecent(count: number): AgentLogEntry[] {
    return this.get({ tail: count })
  }

  clear(): void {
    this.logs = []
  }

  size(): number {
    return this.logs.length
  }

  onLogEntry(callback: (entry: AgentLogEntry) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private trim(): void {
    if (this.logs.length > MAX_LOG_ENTRIES) {
      const excess = this.logs.length - MAX_LOG_ENTRIES
      this.logs.splice(0, excess)
    }
  }

  private notifyListeners(entry: AgentLogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch (error) {
        console.error('Log listener error', { error })
      }
    }
  }
}
