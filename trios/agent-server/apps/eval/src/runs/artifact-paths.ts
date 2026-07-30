import { join } from 'node:path'

function timestamp(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const min = String(date.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

function safeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Creates a path-safe run id from suite/config, variant, and time. */
export function createRunId(
  suiteId: string,
  variantId: string,
  date = new Date(),
): string {
  return `${safeSegment(suiteId)}__${safeSegment(variantId)}__${timestamp(date)}`
}

export function getRunPaths(baseDir: string, runId: string, taskId?: string) {
  const runDir = join(baseDir, 'runs', runId)
  const taskDir = taskId ? join(runDir, 'tasks', taskId) : undefined

  return {
    runDir,
    runManifest: join(runDir, 'run.json'),
    summary: join(runDir, 'summary.json'),
    viewerManifest: join(runDir, 'viewer-manifest.json'),
    uploadManifest: join(runDir, 'upload-manifest.json'),
    taskDir,
    attempt: taskDir ? join(taskDir, 'attempt.json') : undefined,
    trace: taskDir ? join(taskDir, 'trace.jsonl') : undefined,
    messages: taskDir ? join(taskDir, 'messages.jsonl') : undefined,
    grades: taskDir ? join(taskDir, 'grades.json') : undefined,
    graderArtifacts: taskDir ? join(taskDir, 'grader-artifacts') : undefined,
    screenshots: taskDir ? join(taskDir, 'screenshots') : undefined,
  }
}
