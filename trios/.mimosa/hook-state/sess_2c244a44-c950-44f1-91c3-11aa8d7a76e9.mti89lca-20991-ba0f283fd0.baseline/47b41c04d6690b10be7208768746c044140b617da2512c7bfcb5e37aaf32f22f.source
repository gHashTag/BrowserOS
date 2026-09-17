import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TrajectorySaver } from '../../capture/trajectory-saver'
import { runGraders } from '../../grading/grader-runner'
import { type Message, MessageSchema, TaskMetadataSchema } from '../../types'
import type { GradeCliArgs } from '../args'

async function loadMessages(taskDir: string): Promise<Message[]> {
  const content = await readFile(
    join(taskDir, 'messages.jsonl'),
    'utf-8',
  ).catch(() => '')
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => MessageSchema.parse(JSON.parse(line)))
}

async function findTaskDirs(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, { withFileTypes: true })
  const taskDirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const taskDir = join(runDir, entry.name)
    const metadata = await stat(join(taskDir, 'metadata.json')).catch(
      () => null,
    )
    if (metadata?.isFile()) taskDirs.push(taskDir)
  }
  return taskDirs
}

/** Re-runs graders for task artifacts that already contain metadata and messages. */
export async function runGradeCommand(args: GradeCliArgs): Promise<void> {
  const runStat = await stat(args.runDir).catch(() => null)
  if (!runStat?.isDirectory()) {
    throw new Error(`Not a run directory: ${args.runDir}`)
  }

  const taskDirs = await findTaskDirs(args.runDir)
  if (taskDirs.length === 0) {
    throw new Error(`No task metadata found under ${args.runDir}`)
  }

  let graded = 0
  for (const taskDir of taskDirs) {
    const metadata = TaskMetadataSchema.parse(
      JSON.parse(await readFile(join(taskDir, 'metadata.json'), 'utf-8')),
    )
    const graderNames = Object.keys(metadata.grader_results ?? {})
    if (graderNames.length === 0) {
      console.warn(`Skipping ${metadata.query_id}: no existing grader names`)
      continue
    }

    const messages = await loadMessages(taskDir)
    const graderResults = await runGraders(graderNames, {
      task: {
        query_id: metadata.query_id,
        query: metadata.query,
        dataset: metadata.dataset,
      },
      messages,
      screenshotCount: metadata.screenshot_count ?? metadata.total_steps,
      finalAnswer: metadata.final_answer,
      taskArtifactDir: taskDir,
      outputDir: taskDir,
      mcpUrl: `${process.env.BROWSEROS_SERVER_URL || 'http://127.0.0.1:9110'}/mcp`,
    })

    await new TrajectorySaver(
      args.runDir,
      metadata.query_id,
    ).updateGraderResults(graderResults)
    graded++
  }

  if (graded === 0) {
    throw new Error(
      `No tasks with existing grader names found under ${args.runDir}`,
    )
  }
  console.log(`Re-graded ${graded} task(s) in ${args.runDir}`)
}
