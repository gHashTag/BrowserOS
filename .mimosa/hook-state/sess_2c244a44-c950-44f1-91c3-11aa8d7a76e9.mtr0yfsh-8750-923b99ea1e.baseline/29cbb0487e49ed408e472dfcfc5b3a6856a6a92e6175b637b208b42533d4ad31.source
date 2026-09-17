import { describe, expect, it } from 'bun:test'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null))
}

describe('grader python script layout', () => {
  it('keeps runtime evaluator scripts next to the grader implementation', async () => {
    const pythonDir = resolve(import.meta.dir, '../../src/graders/python')
    const scriptsDir = resolve(import.meta.dir, '../../scripts')

    expect(await exists(resolve(pythonDir, 'agisdk-evaluate.py'))).toBe(true)
    expect(await exists(resolve(pythonDir, 'infinity-evaluate.py'))).toBe(true)
    expect(await exists(resolve(scriptsDir, 'agisdk-evaluate.py'))).toBe(false)
    expect(await exists(resolve(scriptsDir, 'infinity-evaluate.py'))).toBe(
      false,
    )
  })
})
