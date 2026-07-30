import { describe, expect, it } from 'bun:test'
import {
  buildRunSummaries,
  extractConfigName,
} from '../../src/reporting/run-summary'

describe('report run summaries', () => {
  it('summarizes schema v2 manifests without depending on artifact paths', () => {
    const [summary] = buildRunSummaries([
      {
        schemaVersion: 2,
        runId: 'agisdk-real-smoke-2026-04-30-0000',
        uploadedAt: '2026-04-30T01:03:59.663Z',
        agentConfig: { type: 'single', model: 'moonshotai/kimi-k2.5' },
        dataset: 'agisdk-real',
        tasks: [
          {
            queryId: 'task-1',
            query: 'Do task 1',
            status: 'completed',
            durationMs: 1000,
            screenshotCount: 1,
            paths: { metadata: 'tasks/task-1/metadata.json' },
            graderResults: {
              agisdk_state_diff: { score: 1, pass: true },
            },
          },
          {
            queryId: 'task-2',
            query: 'Do task 2',
            status: 'timeout',
            durationMs: 3000,
            screenshotCount: 0,
            paths: { metadata: 'tasks/task-2/metadata.json' },
            graderResults: {
              agisdk_state_diff: { score: 0, pass: false },
            },
          },
        ],
      },
    ])

    expect(summary).toMatchObject({
      runId: 'agisdk-real-smoke-2026-04-30-0000',
      configName: 'agisdk-real-smoke',
      date: '2026-04-30 01:03',
      avgScore: 50,
      total: 2,
      completed: 1,
      timeout: 1,
      avgDurationMs: 2000,
      model: 'moonshotai/kimi-k2.5',
      dataset: 'agisdk-real',
      agentType: 'single',
    })
  })

  it('summarizes legacy manifests without schema version or paths', () => {
    const [summary] = buildRunSummaries([
      {
        runId: 'browseros-agent-weekly-2026-04-29-1430',
        uploadedAt: '2026-04-29T14:30:00.000Z',
        agentConfig: { type: 'orchestrator-executor', model: 'kimi' },
        dataset: 'webbench',
        tasks: [
          {
            queryId: 'legacy-task',
            query: 'Do the old task',
            status: 'failed',
            durationMs: 0,
            screenshotCount: 0,
            graderResults: {
              performance_grader: { score: 0.25, pass: false },
            },
          },
        ],
      },
    ])

    expect(summary).toMatchObject({
      runId: 'browseros-agent-weekly-2026-04-29-1430',
      configName: 'browseros-agent-weekly',
      avgScore: 25,
      total: 1,
      completed: 0,
      failed: 1,
      avgDurationMs: 0,
    })
  })

  it('keeps legacy config names when run ids have no timestamp suffix', () => {
    expect(extractConfigName('ci-weekly')).toBe('ci-weekly')
  })

  it('uses an explicit unknown date when uploadedAt is missing', () => {
    const [summary] = buildRunSummaries([
      {
        runId: 'ci-weekly',
        tasks: [],
      },
    ])

    expect(summary.date).toBe('unknown')
  })
})
