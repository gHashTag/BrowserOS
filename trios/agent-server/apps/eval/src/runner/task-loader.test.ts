import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskSchema } from '../types'
import {
  getTaskSourceDescription,
  loadTasks,
  TaskLoadError,
  TaskValidationError,
} from './task-loader'
import type { TaskSource } from './types'

/**
 * Contract suite for src/runner/task-loader.ts.
 *
 * The module exports four symbols and each one is exercised below by exactly
 * one `it` block whose title names the export, so a reader can map every
 * assertion to the public surface:
 *
 *   TaskLoadError, TaskValidationError, loadTasks, getTaskSourceDescription
 *
 * No export was blocked by a live dependency: loadTasks runs against real
 * files created under the OS temp directory, so this suite needs no network,
 * no database and no container. There is therefore nothing left untested to
 * list here.
 */

const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(
    scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

/** Writes a JSONL payload to a fresh temp file and returns its path. */
async function writeTasksFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'task-loader-contract-'))
  scratchDirs.push(dir)
  const path = join(dir, 'tasks.jsonl')
  await writeFile(path, content, 'utf-8')
  return path
}

/** Runs a promise that must reject and returns the rejection reason. */
async function rejectionFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to reject, but the promise resolved')
}

/** A minimal record that satisfies the task schema, with overrides applied. */
function fileTask(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    query_id: 'file-1',
    dataset: 'e2e',
    query: 'a file based task',
    metadata: { original_task_id: 'file-1' },
    ...overrides,
  })
}

describe('taskLoaderContract', () => {
  it('TaskLoadError carries its name, message, source and optional cause', () => {
    const source: TaskSource = { type: 'single', query: 'find flights' }
    const cause = new Error('disk on fire')

    const withCause = new TaskLoadError('could not load tasks', source, cause)
    expect(withCause).toBeInstanceOf(Error)
    expect(withCause.name).toBe('TaskLoadError')
    expect(withCause.message).toBe('could not load tasks')
    expect(withCause.source).toEqual({ type: 'single', query: 'find flights' })
    expect(withCause.cause).toBe(cause)

    const withoutCause = new TaskLoadError('could not load tasks', source)
    expect(withoutCause).toBeInstanceOf(TaskLoadError)
    expect(withoutCause.name).toBe('TaskLoadError')
    expect(withoutCause.cause).toBeUndefined()
    expect(withoutCause.source).toEqual({
      type: 'single',
      query: 'find flights',
    })
  })

  it('TaskValidationError carries its name, message, line number and zod issues', () => {
    const attempt = TaskSchema.safeParse({
      query_id: 'bad',
      dataset: 'e2e',
      metadata: { original_task_id: 'bad' },
    })
    expect(attempt.success).toBe(false)
    if (attempt.success) {
      throw new Error('the fixture record should not have validated')
    }

    const error = new TaskValidationError(
      'task on line 4 is not a task',
      4,
      attempt.error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TaskValidationError')
    expect(error.message).toBe('task on line 4 is not a task')
    expect(error.lineNumber).toBe(4)
    expect(error.validationErrors).toBe(attempt.error)
    expect(
      error.validationErrors.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    ).toEqual(['query: Required'])
  })

  it('loadTasks parses JSONL files, builds single-query tasks and rejects bad sources', async () => {
    // A well formed file: two valid records with a blank line between them.
    const goodPath = await writeTasksFile(
      [
        fileTask(),
        '',
        JSON.stringify({
          query_id: 'file-2',
          dataset: 'e2e',
          query: 'a second task',
          graders: ['human'],
          start_url: 'https://example.test/start',
          metadata: { original_task_id: 'file-2' },
        }),
      ].join('\n'),
    )

    const fromFile = await loadTasks({ type: 'file', path: goodPath })
    expect(fromFile.source).toEqual({ type: 'file', path: goodPath })
    expect(fromFile.tasks).toHaveLength(2)
    // The optional graders field defaults to an empty array; blank lines are
    // skipped rather than counted as tasks.
    expect(fromFile.tasks[0]).toEqual({
      query_id: 'file-1',
      dataset: 'e2e',
      query: 'a file based task',
      graders: [],
      metadata: { original_task_id: 'file-1' },
    })
    expect(fromFile.tasks[1]).toEqual({
      query_id: 'file-2',
      dataset: 'e2e',
      query: 'a second task',
      graders: ['human'],
      start_url: 'https://example.test/start',
      metadata: { original_task_id: 'file-2' },
    })

    // A single-query source trims the query and stamps it as a manual task.
    const single = await loadTasks({
      type: 'single',
      query: '  buy oat milk  ',
      startUrl: 'https://shop.test',
    })
    expect(single.source).toEqual({
      type: 'single',
      query: '  buy oat milk  ',
      startUrl: 'https://shop.test',
    })
    expect(single.tasks).toHaveLength(1)
    expect(single.tasks[0]).toEqual({
      query_id: expect.stringMatching(/^single-/),
      dataset: 'manual',
      query: 'buy oat milk',
      graders: ['performance_grader'],
      start_url: 'https://shop.test',
      metadata: { original_task_id: 'manual' },
    })

    // A missing file fails as a TaskLoadError that echoes the source and the
    // underlying read failure.
    const missing = join(tmpdir(), 'task-loader-contract-missing.jsonl')
    const readError = (await rejectionFrom(
      loadTasks({ type: 'file', path: missing }),
    )) as TaskLoadError
    expect(readError).toBeInstanceOf(TaskLoadError)
    expect(readError.message).toBe(`Failed to read tasks file: ${missing}`)
    expect(readError.source).toEqual({ type: 'file', path: missing })
    expect(readError.cause).toBeInstanceOf(Error)

    // A file holding nothing but whitespace is treated as empty.
    const emptyError = (await rejectionFrom(
      loadTasks({ type: 'file', path: await writeTasksFile('\n   \n\n') }),
    )) as TaskLoadError
    expect(emptyError).toBeInstanceOf(TaskLoadError)
    expect(emptyError.message).toBe('Tasks file is empty')

    // Malformed JSON is reported against the line where it appears.
    const jsonError = (await rejectionFrom(
      loadTasks({
        type: 'file',
        path: await writeTasksFile(
          [fileTask(), '{ not json', fileTask()].join('\n'),
        ),
      }),
    )) as TaskLoadError
    expect(jsonError).toBeInstanceOf(TaskLoadError)
    expect(jsonError.message).toContain('Failed to parse 1 task(s):')
    expect(jsonError.message).toContain('Line 2: Invalid JSON:')

    // Schema violations name the offending field.
    const noQuery = JSON.stringify({
      query_id: 'no-query',
      dataset: 'e2e',
      metadata: { original_task_id: 'no-query' },
    })
    const schemaError = (await rejectionFrom(
      loadTasks({
        type: 'file',
        path: await writeTasksFile(
          [fileTask(), noQuery, fileTask()].join('\n'),
        ),
      }),
    )) as TaskLoadError
    expect(schemaError).toBeInstanceOf(TaskLoadError)
    expect(schemaError.message).toContain('Failed to parse 1 task(s):')
    expect(schemaError.message).toContain(
      'Line 2: Validation failed: query: Required',
    )

    // When more than five records are broken the summary is truncated.
    const brokenLines = Array.from({ length: 7 }, (_, n) =>
      JSON.stringify({
        query_id: `broken-${n}`,
        dataset: 'e2e',
        metadata: { original_task_id: `broken-${n}` },
      }),
    )
    const manyError = (await rejectionFrom(
      loadTasks({
        type: 'file',
        path: await writeTasksFile(brokenLines.join('\n')),
      }),
    )) as TaskLoadError
    expect(manyError.message).toContain('Failed to parse 7 task(s):')
    expect(manyError.message).toContain('... and 2 more errors')
    expect(manyError.message.match(/Line \d+:/g)).toHaveLength(5)

    // Repeated query ids across otherwise valid records are rejected.
    const duplicateSecond = JSON.stringify({
      query_id: 'file-1',
      dataset: 'e2e',
      query: 'a second task',
      metadata: { original_task_id: 'file-1' },
    })
    const duplicateError = (await rejectionFrom(
      loadTasks({
        type: 'file',
        path: await writeTasksFile([fileTask(), duplicateSecond].join('\n')),
      }),
    )) as TaskLoadError
    expect(duplicateError).toBeInstanceOf(TaskLoadError)
    expect(duplicateError.message).toBe('Duplicate query_ids found: file-1')

    // A blank single query is rejected before any task is built.
    const blankQueryError = (await rejectionFrom(
      loadTasks({ type: 'single', query: '   ' }),
    )) as TaskLoadError
    expect(blankQueryError).toBeInstanceOf(TaskLoadError)
    expect(blankQueryError.message).toBe('Query cannot be empty')
    expect(blankQueryError.source).toEqual({ type: 'single', query: '   ' })
  })

  it('getTaskSourceDescription describes a file source and the single-query mode', () => {
    expect(
      getTaskSourceDescription({ type: 'file', path: '/tmp/whatever.jsonl' }),
    ).toBe('file: /tmp/whatever.jsonl')
    expect(
      getTaskSourceDescription({ type: 'single', query: 'buy oat milk' }),
    ).toBe('single task mode')
    expect(
      getTaskSourceDescription({
        type: 'single',
        query: 'buy oat milk',
        startUrl: 'https://shop.test',
      }),
    ).toBe('single task mode')
  })
})
