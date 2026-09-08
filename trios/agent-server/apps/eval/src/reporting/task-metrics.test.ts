import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunMetrics,
  buildTaskMetrics,
  countMessageMetrics,
  readRunMetricSummary,
  readTaskMetrics,
} from './task-metrics'

// Every export of this module is exercised below. None of the five needs a
// live dependency: the two readers only touch directories under the OS temp
// dir that stand in for on-disk run artifacts, so there is no blocked export
// to list here.

const createdDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  )
  createdDirs.length = 0
})

function toolEvent(type: string): string {
  return JSON.stringify({ type })
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

describe('taskMetricsContract', () => {
  it('countMessageMetrics counts tool events across JSONL lines', () => {
    const jsonl = [
      toolEvent('tool-input-available'),
      toolEvent('assistant'),
      toolEvent('tool-output-error'),
      toolEvent('tool-output-error'),
      'this line is not JSON and must be ignored',
      '',
      '   ',
      toolEvent('tool-input-available'),
    ].join('\n')

    expect(countMessageMetrics(jsonl)).toEqual({
      toolCalls: 2,
      toolErrors: 2,
    })
    expect(countMessageMetrics('')).toEqual({
      toolCalls: 0,
      toolErrors: 0,
    })
  })

  it('buildTaskMetrics prefers metadata and falls back to screenshots', () => {
    const fromMetadata = buildTaskMetrics(
      { total_duration_ms: 1500, total_steps: 6, screenshot_count: 2 },
      { toolCalls: 4, toolErrors: 1 },
      7,
    )
    expect(fromMetadata).toEqual({
      durationMs: 1500,
      steps: 6,
      screenshots: 2,
      toolCalls: 4,
      toolErrors: 1,
    })

    const withoutMetadata = buildTaskMetrics(
      {},
      { toolCalls: 0, toolErrors: 0 },
      3,
    )
    expect(withoutMetadata).toEqual({
      durationMs: 0,
      steps: 3,
      screenshots: 3,
      toolCalls: 0,
      toolErrors: 0,
    })

    const withZeroSteps = buildTaskMetrics(
      { total_steps: 0, screenshot_count: 5 },
      { toolCalls: 0, toolErrors: 0 },
    )
    expect(withZeroSteps.steps).toBe(5)

    const withGarbage = buildTaskMetrics(
      {
        total_duration_ms: 'slow',
        total_steps: Number.NaN,
        screenshot_count: Number.POSITIVE_INFINITY,
      },
      { toolCalls: 0, toolErrors: 0 },
    )
    expect(withGarbage).toEqual({
      durationMs: 0,
      steps: 0,
      screenshots: 0,
      toolCalls: 0,
      toolErrors: 0,
    })
  })

  it('buildRunMetrics aggregates task metrics with averages', () => {
    expect(buildRunMetrics([])).toEqual({
      taskCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      totalSteps: 0,
      avgSteps: 0,
      totalToolCalls: 0,
      avgToolCalls: 0,
      totalToolErrors: 0,
      avgToolErrors: 0,
    })

    const run = buildRunMetrics([
      {
        durationMs: 100,
        steps: 2,
        screenshots: 1,
        toolCalls: 3,
        toolErrors: 1,
      },
      {
        durationMs: 300,
        steps: 4,
        screenshots: 5,
        toolCalls: 5,
        toolErrors: 3,
      },
    ])
    expect(run).toEqual({
      taskCount: 2,
      totalDurationMs: 400,
      avgDurationMs: 200,
      totalSteps: 6,
      avgSteps: 3,
      totalToolCalls: 8,
      avgToolCalls: 4,
      totalToolErrors: 4,
      avgToolErrors: 2,
    })
  })

  it('readTaskMetrics reads messages.jsonl and tolerates its absence', async () => {
    const taskDir = await makeTempDir('task-metrics-task-')
    await writeFile(
      join(taskDir, 'messages.jsonl'),
      [
        toolEvent('tool-input-available'),
        toolEvent('tool-input-available'),
        toolEvent('tool-output-error'),
      ].join('\n'),
    )

    await expect(
      readTaskMetrics(taskDir, { total_duration_ms: 900, total_steps: 6 }, 9),
    ).resolves.toEqual({
      durationMs: 900,
      steps: 6,
      screenshots: 9,
      toolCalls: 2,
      toolErrors: 1,
    })

    const emptyDir = await makeTempDir('task-metrics-empty-')
    await expect(readTaskMetrics(emptyDir, {}, 2)).resolves.toEqual({
      durationMs: 0,
      steps: 2,
      screenshots: 2,
      toolCalls: 0,
      toolErrors: 0,
    })
  })

  it('readRunMetricSummary walks a run directory into a graded summary', async () => {
    const runDir = await makeTempDir('task-metrics-run-')
    const tasksDir = join(runDir, 'tasks')
    const taskA = join(tasksDir, 'task-a')
    const taskB = join(tasksDir, 'task-b')
    const taskC = join(tasksDir, 'task-c')
    const noMetadata = join(tasksDir, 'no-metadata')
    const ignoredScreenshots = join(tasksDir, 'screenshots')
    const strayOutsideTasks = join(runDir, 'stray-task')
    for (const dir of [taskA, taskB, taskC, noMetadata, ignoredScreenshots]) {
      await mkdir(dir, { recursive: true })
    }
    await mkdir(strayOutsideTasks, { recursive: true })

    await writeFile(
      join(taskA, 'metadata.json'),
      JSON.stringify({
        query_id: 'query-a',
        termination_reason: 'timeout',
        total_duration_ms: 100,
        total_steps: 2,
      }),
    )
    await writeFile(
      join(taskA, 'messages.jsonl'),
      toolEvent('tool-input-available'),
    )

    await writeFile(
      join(taskB, 'metadata.json'),
      JSON.stringify({
        errors: ['boom'],
        total_duration_ms: 300,
        grader_results: { rubric: { score: 0.5, pass: false } },
      }),
    )
    await writeFile(
      join(taskB, 'messages.jsonl'),
      toolEvent('tool-output-error'),
    )

    await writeFile(
      join(taskC, 'metadata.json'),
      JSON.stringify({ query_id: 'query-c', errors: [] }),
    )

    // `no-metadata` has no metadata.json and is skipped; `screenshots` is
    // not a task; `stray-task` is hidden because the canonical `tasks`
    // layout wins over directories at the run root.
    await writeFile(
      join(strayOutsideTasks, 'metadata.json'),
      JSON.stringify({ query_id: 'stray' }),
    )

    const summary = await readRunMetricSummary(runDir)
    const byQueryId = new Map(
      summary.tasks.map((task) => [task.queryId, task]),
    )
    expect(summary.tasks).toHaveLength(3)
    expect(byQueryId.get('query-a')).toEqual({
      queryId: 'query-a',
      status: 'timeout',
      metrics: {
        durationMs: 100,
        steps: 2,
        screenshots: 0,
        toolCalls: 1,
        toolErrors: 0,
      },
    })
    expect(byQueryId.get('task-b')).toEqual({
      queryId: 'task-b',
      status: 'failed',
      score: 0.5,
      pass: false,
      metrics: {
        durationMs: 300,
        steps: 0,
        screenshots: 0,
        toolCalls: 0,
        toolErrors: 1,
      },
    })
    expect(byQueryId.get('query-c')).toEqual({
      queryId: 'query-c',
      status: 'completed',
      metrics: {
        durationMs: 0,
        steps: 0,
        screenshots: 0,
        toolCalls: 0,
        toolErrors: 0,
      },
    })
    expect(summary.run).toEqual({
      taskCount: 3,
      totalDurationMs: 400,
      avgDurationMs: 400 / 3,
      totalSteps: 2,
      avgSteps: 2 / 3,
      totalToolCalls: 1,
      avgToolCalls: 1 / 3,
      totalToolErrors: 1,
      avgToolErrors: 1 / 3,
    })

    const flatRunDir = await makeTempDir('task-metrics-flat-')
    const flatTask = join(flatRunDir, 'only-task')
    await mkdir(flatTask, { recursive: true })
    await mkdir(join(flatRunDir, 'screenshots'), { recursive: true })
    await writeFile(
      join(flatTask, 'metadata.json'),
      JSON.stringify({ query_id: 'flat-query' }),
    )
    const flatSummary = await readRunMetricSummary(flatRunDir)
    expect(flatSummary.tasks.map((task) => task.queryId)).toEqual([
      'flat-query',
    ])
    expect(flatSummary.run.taskCount).toBe(1)
  })
})
