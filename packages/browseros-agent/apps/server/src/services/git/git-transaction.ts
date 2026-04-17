/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Transaction Safety
 * Provides transaction-like behavior for Git operations with rollback
 */

import { GIT_CONSTANTS } from '@browseros/shared/constants/git'
import { $ } from 'bun'

export interface GitOperation {
  type: string
  description: string
  execute: () => Promise<void>
  rollback: () => Promise<void>
}

export interface TransactionResult<T> {
  success: boolean
  rollbackPerformed: boolean
  operations: string[]
  result?: T
  error?: string
}

export class GitTransaction {
  private operations: GitOperation[] = []
  private executedOps: GitOperation[] = []
  private snapshotCreated = false

  constructor(
    private workingDir: string,
    private timeout = GIT_CONSTANTS.DEFAULT_TRANSACTION_TIMEOUT_MS
  ) {}

  addOperation(op: GitOperation): void {
    this.operations.push(op)
  }

  async executeTransaction<T>(
    fn: () => Promise<T>
  ): Promise<TransactionResult<T>> {
    const opNames: string[] = []

    try {
      await this.createSnapshot()
      this.snapshotCreated = true

      for (const op of this.operations) {
        opNames.push(op.description)
        await this.executeWithTimeout(op)
        this.executedOps.push(op)
      }

      const result = await fn()

      return {
        success: true,
        rollbackPerformed: false,
        operations: opNames,
        result,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      if (this.snapshotCreated && this.executedOps.length > 0) {
        try {
          await this.rollback()
          return {
            success: false,
            rollbackPerformed: true,
            operations: opNames,
            error: errorMsg,
          }
        } catch (rollbackError) {
          return {
            success: false,
            rollbackPerformed: false,
            operations: opNames,
            error: `${errorMsg} (rollback failed: ${rollbackError})`,
          }
        }
      }

      return {
        success: false,
        rollbackPerformed: false,
        operations: opNames,
        error: errorMsg,
      }
    } finally {
      await this.cleanup()
    }
  }

  private async createSnapshot(): Promise<void> {
    const stashName = `trios-tx-${Date.now()}`
    await $`cd ${this.workingDir} && git stash push -m ${stashName}`.quiet()
  }

  private async executeWithTimeout(op: GitOperation): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      await op.execute()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async rollback(): Promise<void> {
    for (let i = this.executedOps.length - 1; i >= 0; i--) {
      const op = this.executedOps[i]
      try {
        await op.rollback()
      } catch (error) {
        console.error(`Rollback failed for ${op.description}:`, error)
      }
    }

    await $`cd ${this.workingDir} && git stash pop`.quiet()
  }

  private async cleanup(): Promise<void> {
    this.operations = []
    this.executedOps = []
    this.snapshotCreated = false
  }
}

export function withTransaction<T>(
  workingDir: string,
  operations: GitOperation[],
  fn: () => Promise<T>
): Promise<TransactionResult<T>> {
  const tx = new GitTransaction(workingDir)
  for (const op of operations) {
    tx.addOperation(op)
  }
  return tx.executeTransaction(fn)
}
