import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrajectorySaver } from '../../src/capture/trajectory-saver'
import { createRunId, getRunPaths } from '../../src/runs/artifact-paths'
import type { TaskMetadata } from '../../src/types'

describe('artifact paths', () => {
  it('creates stable safe run ids', () => {
    const runId = createRunId(
      'agisdk/daily 10',
      'kimi fire?',
      new Date('2026-04-29T06:00:00Z'),
    )

    expect(runId).toBe('agisdk-daily-10__kimi-fire__2026-04-29-0600')
  })

  it('returns run and task artifact paths', () => {
    const paths = getRunPaths('results', 'run-1', 'task-1')

    expect(paths.runDir).toBe(join('results', 'runs', 'run-1'))
    expect(paths.runManifest).toBe(join('results', 'runs', 'run-1', 'run.json'))
    expect(paths.viewerManifest).toBe(
      join('results', 'runs', 'run-1', 'viewer-manifest.json'),
    )
    expect(paths.messages).toBe(
      join('results', 'runs', 'run-1', 'tasks', 'task-1', 'messages.jsonl'),
    )
    expect(paths.graderArtifacts).toBe(
      join('results', 'runs', 'run-1', 'tasks', 'task-1', 'grader-artifacts'),
    )
  })
})

describe('TrajectorySaver artifact compatibility', () => {
  it('keeps metadata.json and writes attempt and grades artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-artifacts-'))
    const saver = new TrajectorySaver(dir, 'task-1')
    const taskDir = await saver.init()
    const metadata: TaskMetadata = {
      query_id: 'task-1',
      dataset: 'fixture',
      query: 'Do the task',
      started_at: '2026-04-29T00:00:00.000Z',
      completed_at: '2026-04-29T00:00:01.000Z',
      total_duration_ms: 1000,
      total_steps: 1,
      screenshot_count: 1,
      termination_reason: 'completed',
      final_answer: 'done',
      errors: [],
      warnings: [],
      agent_config: { type: 'single', model: 'model' },
      grader_results: {},
    }

    await saver.saveMetadata(metadata)
    await saver.saveAttempt({ status: 'completed', taskId: 'task-1' })
    await saver.saveGrades({
      performance_grader: { score: 1, pass: true, reasoning: 'ok' },
    })

    expect(
      JSON.parse(await readFile(join(taskDir, 'metadata.json'), 'utf-8')),
    ).toMatchObject({
      query_id: 'task-1',
    })
    expect(
      JSON.parse(await readFile(join(taskDir, 'attempt.json'), 'utf-8')),
    ).toEqual({
      status: 'completed',
      taskId: 'task-1',
    })
    expect(
      JSON.parse(await readFile(join(taskDir, 'grades.json'), 'utf-8')),
    ).toMatchObject({
      performance_grader: { pass: true },
    })
  })
})
