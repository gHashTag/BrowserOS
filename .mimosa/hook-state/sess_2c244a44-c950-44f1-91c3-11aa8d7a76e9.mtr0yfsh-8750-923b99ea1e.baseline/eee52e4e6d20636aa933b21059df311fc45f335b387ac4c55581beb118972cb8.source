import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GraderInput } from './types'

function artifactDir(input: GraderInput, graderName: string): string {
  return join(
    input.taskArtifactDir || input.outputDir,
    'grader-artifacts',
    graderName,
  )
}

/** Writes a JSON artifact for a grader under the task artifact directory. */
export async function writeGraderJsonArtifact(
  input: GraderInput,
  graderName: string,
  filename: string,
  value: unknown,
): Promise<void> {
  const dir = artifactDir(input, graderName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), JSON.stringify(value, null, 2))
}

export async function writeGraderTextArtifact(
  input: GraderInput,
  graderName: string,
  filename: string,
  value: string,
): Promise<void> {
  const dir = artifactDir(input, graderName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), value)
}
