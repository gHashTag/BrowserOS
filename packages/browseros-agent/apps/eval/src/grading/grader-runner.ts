import type { GraderResult } from '../types'
import { createGrader as defaultCreateGrader } from './grader-registry'
import type { Grader, GraderInput } from './types'

export interface GraderRunnerDeps {
  createGrader?: (name: string) => Grader | null
}

/** Runs configured graders independently so one failure does not hide others. */
export async function runConfiguredGraders(
  graderNames: string[],
  input: GraderInput,
  deps: GraderRunnerDeps = {},
): Promise<Record<string, GraderResult>> {
  const create = deps.createGrader ?? defaultCreateGrader
  const results: Record<string, GraderResult> = {}

  for (const name of graderNames) {
    const grader = create(name)
    if (!grader) continue
    try {
      console.log(`  Running grader: ${name}`)
      results[name] = await grader.grade(input)
    } catch (error) {
      results[name] = {
        score: 0,
        pass: false,
        reasoning: `Error running grader: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return results
}

export const runGraders = runConfiguredGraders
