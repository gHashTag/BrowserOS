/**
 * Shared timeout wrapper for eval agent execution.
 * Handles AbortController creation, setTimeout scheduling, catch/finally logic,
 * and post-execution safety check — deduplicating ~25 lines per evaluator.
 */

import type { CaptureContext } from '../capture/context'

export type TerminationReason = 'completed' | 'max_steps' | 'error' | 'timeout'

export interface TimeoutResult<T> {
  result?: T
  terminationReason: TerminationReason
}

export async function withEvalTimeout<T>(
  timeoutMs: number,
  capture: CaptureContext,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<TimeoutResult<T>> {
  const abortController = new AbortController()
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs)
  let terminationReason: TerminationReason = 'completed'

  try {
    const result = await fn(abortController.signal)
    return { result, terminationReason }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))

    if (abortController.signal.aborted) {
      terminationReason = 'timeout'
      capture.addError(
        'agent_execution',
        `Task timed out after ${timeoutMs / 1000}s`,
      )
    } else {
      terminationReason = 'error'
      capture.addError('agent_execution', error.message, {
        stack: error.stack,
      })
    }

    return { terminationReason }
  } finally {
    clearTimeout(timeoutHandle)
  }
}
