import { dirname, resolve } from 'node:path'
import { type EvalSuite, EvalSuiteSchema } from './schema'

export interface LoadedSuite {
  suite: EvalSuite
  suitePath: string
  suiteDir: string
  datasetPath: string
}

/** Loads a suite file and resolves its dataset relative to the suite. */
export async function loadSuite(suitePath: string): Promise<LoadedSuite> {
  const absolute = resolve(suitePath)
  const raw = JSON.parse(await Bun.file(absolute).text())
  const suite = EvalSuiteSchema.parse(raw)
  const suiteDir = dirname(absolute)
  const datasetPath = suite.dataset.startsWith('/')
    ? suite.dataset
    : resolve(suiteDir, suite.dataset)

  return { suite, suitePath: absolute, suiteDir, datasetPath }
}
