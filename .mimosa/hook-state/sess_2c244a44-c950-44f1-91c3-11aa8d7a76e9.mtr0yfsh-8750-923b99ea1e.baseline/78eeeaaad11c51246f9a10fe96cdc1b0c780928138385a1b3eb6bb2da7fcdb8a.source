import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerformanceGrader } from '../../src/graders/performance/performance-grader'
import type { GraderInput } from '../../src/grading/types'

describe('PerformanceGrader artifacts', () => {
  it('writes metrics, agent output, and axes artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'performance-artifacts-'))
    await mkdir(join(dir, 'screenshots'))
    await writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify({ termination_reason: 'completed' }),
    )

    const grader = new PerformanceGrader(undefined, undefined, 'claude-test')
    const internals = grader as unknown as {
      runAgent(
        systemPrompt: string,
        userPrompt: string,
        outputDir: string,
      ): Promise<{
        type: 'result'
        subtype: string
        result: string
        total_cost_usd: number
        num_turns: number
        structured_output: unknown
      }>
    }
    internals.runAgent = async () => ({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      total_cost_usd: 0.01,
      num_turns: 2,
      structured_output: {
        axes: [{ axis: 'task_completion', score: 90, reasoning: 'completed' }],
      },
    })

    const input: GraderInput = {
      task: {
        query_id: 'task-1',
        query: 'Find the answer',
        dataset: 'fixture',
      },
      messages: [
        {
          type: 'tool-input-available',
          timestamp: '2026-04-29T00:00:00.000Z',
          toolCallId: 'call-1',
          toolName: 'browser_get_page_content',
          input: {},
        },
      ],
      screenshotCount: 1,
      finalAnswer: 'answer',
      taskArtifactDir: dir,
      outputDir: dir,
    }

    const result = await grader.grade(input)

    expect(result.details?.model).toBe('claude-test')
    expect(
      JSON.parse(
        await readFile(
          join(dir, 'grader-artifacts/performance_grader/metrics.json'),
          'utf-8',
        ),
      ),
    ).toMatchObject({ totalToolCalls: 1 })
    expect(
      JSON.parse(
        await readFile(
          join(dir, 'grader-artifacts/performance_grader/axes.json'),
          'utf-8',
        ),
      ),
    ).toMatchObject({ task_completion: { score: 90 } })
    expect(
      JSON.parse(
        await readFile(
          join(dir, 'grader-artifacts/performance_grader/agent-output.json'),
          'utf-8',
        ),
      ),
    ).toMatchObject({ subtype: 'success' })
  })
})
