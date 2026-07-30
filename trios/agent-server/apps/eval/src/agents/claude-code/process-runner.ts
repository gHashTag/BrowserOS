export interface ClaudeCodeRunOptions {
  executable: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  onStdoutLine: (line: string) => Promise<void>
}

export interface ClaudeCodeRunResult {
  exitCode: number
  stderr: string
  streamErrors?: string[]
}

export interface ClaudeCodeProcessRunner {
  run(options: ClaudeCodeRunOptions): Promise<ClaudeCodeRunResult>
}

export interface SpawnOptions {
  cwd: string
  signal?: AbortSignal
  onStdoutLine: (line: string) => Promise<void>
}

export interface CreateClaudeCodeProcessRunnerDeps {
  spawn?: (cmd: string[], options: SpawnOptions) => Promise<ClaudeCodeRunResult>
}

export function createClaudeCodeProcessRunner(
  deps: CreateClaudeCodeProcessRunnerDeps = {},
): ClaudeCodeProcessRunner {
  const spawn = deps.spawn ?? spawnClaudeCode
  return {
    run: async ({ executable, args, cwd, signal, onStdoutLine }) =>
      spawn([executable, ...args], { cwd, signal, onStdoutLine }),
  }
}

async function spawnClaudeCode(
  cmd: string[],
  options: SpawnOptions,
): Promise<ClaudeCodeRunResult> {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const abort = () => {
    try {
      proc.kill('SIGTERM')
    } catch {
      // Process may already have exited.
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const streamErrors: string[] = []
    const stdoutPromise = readLines(
      proc.stdout,
      options.onStdoutLine,
      streamErrors,
    )
    const stderrPromise = new Response(proc.stderr).text()
    const exitCode = await proc.exited
    await stdoutPromise
    const stderr = await stderrPromise
    return { exitCode, stderr, streamErrors }
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>,
  streamErrors: string[],
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      await emitLine(line, onLine, streamErrors)
    }
  }

  buffer += decoder.decode()
  if (buffer.length > 0) {
    await emitLine(buffer, onLine, streamErrors)
  }
}

async function emitLine(
  line: string,
  onLine: (line: string) => Promise<void>,
  streamErrors: string[],
): Promise<void> {
  try {
    await onLine(line)
  } catch (error) {
    streamErrors.push(error instanceof Error ? error.message : String(error))
  }
}
