import { describe, expect, it } from 'bun:test'
import { runEval as oldRunEval } from '../../src/runner/eval-runner'
import { ParallelExecutor } from '../../src/runner/parallel-executor'
import { TaskExecutor } from '../../src/runner/task-executor'
import { runEval } from '../../src/runs/eval-runner'
import { TaskRunPipeline } from '../../src/runs/task-run-pipeline'
import { TaskWorkerPool } from '../../src/runs/task-worker-pool'

describe('runner naming compatibility', () => {
  it('exports new runner-layer names', () => {
    expect(TaskWorkerPool.name).toBe('TaskWorkerPool')
    expect(TaskRunPipeline.name).toBe('TaskRunPipeline')
    expect(typeof runEval).toBe('function')
  })

  it('keeps old runner imports working', () => {
    expect(ParallelExecutor).toBe(TaskWorkerPool)
    expect(TaskExecutor).toBe(TaskRunPipeline)
    expect(oldRunEval).toBe(runEval)
  })
})
