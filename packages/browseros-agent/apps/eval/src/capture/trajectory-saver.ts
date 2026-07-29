import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type GraderResult,
  type Task,
  type TaskMetadata,
  TaskMetadataSchema,
} from '../types'

/**
 * Check if a task has already been completed with grader results
 */
export async function hasExistingGraderResults(
  baseOutputDir: string,
  queryId: string,
): Promise<{ exists: boolean; metadata?: TaskMetadata }> {
  const metadataPath = join(baseOutputDir, queryId, 'metadata.json')

  try {
    await access(metadataPath)
    const content = await readFile(metadataPath, 'utf-8')
    const metadata = TaskMetadataSchema.parse(JSON.parse(content))

    // Check if grader_results exists and has at least one entry
    const hasResults =
      metadata.grader_results && Object.keys(metadata.grader_results).length > 0

    return { exists: hasResults, metadata: hasResults ? metadata : undefined }
  } catch {
    return { exists: false }
  }
}

export class TrajectorySaver {
  private outputDir: string

  constructor(baseOutputDir: string, queryId: string) {
    this.outputDir = join(baseOutputDir, queryId)
  }

  async init(): Promise<string> {
    // Clean existing output directory to avoid stale data from previous runs
    await rm(this.outputDir, { recursive: true, force: true })
    await mkdir(this.outputDir, { recursive: true })
    await mkdir(join(this.outputDir, 'screenshots'), { recursive: true })
    return this.outputDir
  }

  getOutputDir(): string {
    return this.outputDir
  }

  async saveMetadata(metadata: TaskMetadata): Promise<void> {
    await writeFile(
      join(this.outputDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
    )
  }

  async saveAttempt(attempt: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(this.outputDir, 'attempt.json'),
      JSON.stringify(attempt, null, 2),
    )
  }

  async saveGrades(graderResults: Record<string, GraderResult>): Promise<void> {
    await writeFile(
      join(this.outputDir, 'grades.json'),
      JSON.stringify(graderResults, null, 2),
    )
  }

  async loadMetadata(): Promise<TaskMetadata> {
    const content = await readFile(
      join(this.outputDir, 'metadata.json'),
      'utf-8',
    )
    return TaskMetadataSchema.parse(JSON.parse(content))
  }

  async updateGraderResults(
    graderResults: Record<string, GraderResult>,
  ): Promise<void> {
    const metadata = await this.loadMetadata()
    metadata.grader_results = graderResults
    await this.saveGrades(graderResults)
    await this.saveMetadata(metadata)
  }

  static createInitialMetadata(
    task: Task,
    agentConfig: { type: string; model: string },
  ): TaskMetadata {
    return {
      query_id: task.query_id,
      dataset: task.dataset,
      query: task.query,
      started_at: new Date().toISOString(),
      completed_at: '',
      total_duration_ms: 0,
      total_steps: 0,
      termination_reason: 'completed',
      final_answer: null,
      errors: [],
      warnings: [],
      agent_config: {
        type: agentConfig.type as
          | 'single'
          | 'orchestrator-executor'
          | 'claude-code',
        model: agentConfig.model,
      },
      grader_results: {},
    }
  }
}
