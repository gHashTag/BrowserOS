export interface ReportManifestTask {
  queryId: string
  query?: string
  status: string
  durationMs: number
  screenshotCount?: number
  paths?: Record<string, string>
  graderResults?: Record<string, { pass?: boolean; score?: number }>
}

export interface ReportManifest {
  schemaVersion?: number
  runId: string
  uploadedAt?: string
  agentConfig?: { type?: string; model?: string }
  dataset?: string
  summary?: { passRate?: number; avgDurationMs?: number }
  tasks?: ReportManifestTask[]
}

export interface RunSummary {
  runId: string
  configName: string
  date: string
  avgScore: number
  total: number
  completed: number
  failed: number
  timeout: number
  avgDurationMs: number
  model: string
  dataset: string
  agentType: string
}

// Report score uses the primary pass/fail grader so mixed-grader runs keep
// the same precedence as the eval summary.
const PASS_FAIL_GRADER_ORDER = [
  'agisdk_state_diff',
  'infinity_state',
  'performance_grader',
]

export function extractConfigName(runId: string): string {
  return runId.replace(/-\d{4}-\d{2}-\d{2}-\d{4}$/, '')
}

function reportDate(manifest: ReportManifest): string {
  if (!manifest.uploadedAt) return 'unknown'
  const [date, time] = manifest.uploadedAt.split('T')
  return `${date} ${time?.slice(0, 5) || ''}`
}

function primaryScore(task: ReportManifestTask): number | null {
  if (!task.graderResults) return null
  for (const name of PASS_FAIL_GRADER_ORDER) {
    const result = task.graderResults[name]
    if (result) return result.score ?? 0
  }
  return null
}

export function buildRunSummaries(manifests: ReportManifest[]): RunSummary[] {
  return manifests
    .map((manifest) => {
      const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : []
      const total = tasks.length
      const completed = tasks.filter((t) => t.status === 'completed').length
      const failed = tasks.filter((t) => t.status === 'failed').length
      const timeout = tasks.filter((t) => t.status === 'timeout').length

      let scoredCount = 0
      let scoreSum = 0
      for (const task of tasks) {
        const score = primaryScore(task)
        if (score === null) continue
        scoredCount++
        scoreSum += score
      }

      const durations = tasks
        .filter((t) => t.durationMs > 0)
        .map((t) => t.durationMs)

      return {
        runId: manifest.runId,
        configName: extractConfigName(manifest.runId),
        date: reportDate(manifest),
        avgScore: scoredCount > 0 ? (scoreSum / scoredCount) * 100 : 0,
        total,
        completed,
        failed,
        timeout,
        avgDurationMs:
          durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0,
        model: manifest.agentConfig?.model || 'unknown',
        dataset: manifest.dataset || manifest.runId,
        agentType: manifest.agentConfig?.type || 'unknown',
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}
