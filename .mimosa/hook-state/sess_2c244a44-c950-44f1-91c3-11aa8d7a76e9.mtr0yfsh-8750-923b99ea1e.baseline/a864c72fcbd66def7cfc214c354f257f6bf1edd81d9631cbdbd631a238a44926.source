import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InfinityStateGrader } from '../../src/graders/benchmark/infinity-state'
import type { GraderInput } from '../../src/grading/types'

describe('InfinityStateGrader artifacts', () => {
  it('writes verifier and evaluator artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'infinity-artifacts-'))
    const oldInfinityDir = process.env.WEBARENA_INFINITY_DIR
    process.env.WEBARENA_INFINITY_DIR = '/tmp/webarena-infinity'

    try {
      const grader = new InfinityStateGrader()
      const internals = grader as unknown as {
        runPythonEvaluator(input: unknown): Promise<{
          output: { pass: boolean; reward: number; message: string }
          stderr: string
        }>
      }
      internals.runPythonEvaluator = async () => ({
        output: { pass: true, reward: 1, message: 'verified' },
        stderr: 'verifier log',
      })

      const input: GraderInput = {
        task: {
          query_id: 'infinity-elation-prescriptions-task_h69',
          query: 'Verify the app state',
          dataset: 'webarena-infinity',
        },
        messages: [],
        screenshotCount: 0,
        finalAnswer: null,
        taskArtifactDir: dir,
        outputDir: dir,
        infinityAppUrl: 'http://127.0.0.1:8123',
      }

      const result = await grader.grade(input)

      expect(result.pass).toBe(true)
      expect(
        JSON.parse(
          await readFile(
            join(dir, 'grader-artifacts/infinity_state/verifier.json'),
            'utf-8',
          ),
        ),
      ).toMatchObject({
        appName: 'elation-prescriptions',
        appServerUrl: 'http://127.0.0.1:8123',
      })
      expect(
        JSON.parse(
          await readFile(
            join(dir, 'grader-artifacts/infinity_state/evaluator-output.json'),
            'utf-8',
          ),
        ),
      ).toMatchObject({ message: 'verified' })
    } finally {
      process.env.WEBARENA_INFINITY_DIR = oldInfinityDir
    }
  })
})
