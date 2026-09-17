import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgisdkStateDiffGrader } from '../../src/graders/benchmark/agisdk-state-diff'
import type { GraderInput } from '../../src/grading/types'

describe('AgisdkStateDiffGrader artifacts', () => {
  it('writes finish state and evaluator artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agisdk-artifacts-'))
    const grader = new AgisdkStateDiffGrader()
    const internals = grader as unknown as {
      fetchFinishState(
        origin: string,
        endpoint: string,
      ): Promise<Record<string, unknown>>
      runPythonEvaluator(input: unknown): Promise<{
        output: {
          reward: number
          pass: boolean
          message: string
          per_criterion: unknown[]
        }
        stderr: string
      }>
    }

    internals.fetchFinishState = async () => ({ cart: [{ name: 'Soup' }] })
    internals.runPythonEvaluator = async () => ({
      output: {
        reward: 0,
        pass: false,
        message: 'Missing entree',
        per_criterion: [{ passed: false, detail: 'entree missing' }],
      },
      stderr: 'criterion log',
    })

    const input: GraderInput = {
      task: {
        query_id: 'agisdk-dashdish-10',
        query: 'Order dinner',
        dataset: 'agisdk',
      },
      messages: [],
      screenshotCount: 0,
      finalAnswer: 'done',
      taskArtifactDir: dir,
      outputDir: dir,
      mcpUrl: 'http://127.0.0.1:9110/mcp',
    }

    const result = await grader.grade(input)

    expect(result.pass).toBe(false)
    expect(
      JSON.parse(
        await readFile(
          join(dir, 'grader-artifacts/agisdk_state_diff/finish-state.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ cart: [{ name: 'Soup' }] })
    expect(
      JSON.parse(
        await readFile(
          join(dir, 'grader-artifacts/agisdk_state_diff/evaluator-output.json'),
          'utf-8',
        ),
      ),
    ).toMatchObject({ message: 'Missing entree' })
    expect(
      await readFile(
        join(dir, 'grader-artifacts/agisdk_state_diff/stderr.txt'),
        'utf-8',
      ),
    ).toContain('criterion log')
  })
})
