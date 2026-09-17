export interface PythonEvaluatorOptions {
  scriptPath: string
  input: unknown
  timeoutMs: number
  pythonPath?: string
}

export interface PythonEvaluatorResult<T> {
  output: T
  stdout: string
  stderr: string
  exitCode: number
}

/** Runs a Python evaluator that accepts stdin JSON and emits stdout JSON. */
export async function runPythonJsonEvaluator<T>(
  options: PythonEvaluatorOptions,
): Promise<PythonEvaluatorResult<T>> {
  const pythonPath =
    options.pythonPath || process.env.BROWSEROS_EVAL_PYTHON || 'python3'
  const proc = Bun.spawn([pythonPath, options.scriptPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  proc.stdin.write(JSON.stringify(options.input))
  proc.stdin.end()

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(
        new Error(`Python evaluator timed out after ${options.timeoutMs}ms`),
      )
    }, options.timeoutMs)
  })

  const completed = (async (): Promise<PythonEvaluatorResult<T>> => {
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      throw new Error(
        `Python evaluator exited with code ${exitCode}: ${stderr || stdout}`,
      )
    }

    try {
      return {
        output: JSON.parse(stdout.trim()) as T,
        stdout,
        stderr,
        exitCode,
      }
    } catch {
      throw new Error(`Failed to parse Python evaluator output: ${stdout}`)
    }
  })()

  try {
    return await Promise.race([completed, timeout])
  } finally {
    clearTimeout(timeoutHandle)
  }
}
