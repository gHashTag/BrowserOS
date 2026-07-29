import { describe, expect, it } from 'bun:test'
import { createGrader } from '../../src/grading/grader-registry'
import { runConfiguredGraders } from '../../src/grading/grader-runner'
import type { Grader, GraderInput } from '../../src/grading/types'

const fixtureInput: GraderInput = {
  task: {
    query_id: 'task-1',
    query: 'Do the thing',
    dataset: 'fixture',
  },
  messages: [],
  screenshotCount: 0,
  finalAnswer: null,
  taskArtifactDir: '/tmp/task-1',
  outputDir: '/tmp/task-1',
}

describe('grader registry', () => {
  it('creates all current graders behind the shared interface', () => {
    expect(createGrader('agisdk_state_diff')?.name).toBe('agisdk_state_diff')
    expect(createGrader('infinity_state')?.name).toBe('infinity_state')
    expect(createGrader('performance_grader')?.name).toBe('performance_grader')
  })
})

describe('runConfiguredGraders', () => {
  it('records one grader failure without aborting other graders', async () => {
    const passing: Grader = {
      name: 'passing',
      async grade() {
        return { score: 1, pass: true, reasoning: 'ok' }
      },
    }
    const failing: Grader = {
      name: 'failing',
      async grade() {
        throw new Error('grader exploded')
      },
    }

    const results = await runConfiguredGraders(
      ['failing', 'passing'],
      fixtureInput,
      {
        createGrader(name) {
          return name === 'failing' ? failing : passing
        },
      },
    )

    expect(results.failing.pass).toBe(false)
    expect(results.failing.reasoning).toContain('grader exploded')
    expect(results.passing.pass).toBe(true)
  })
})
