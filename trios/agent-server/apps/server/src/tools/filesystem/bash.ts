import { resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import {
  DEFAULT_BASH_TIMEOUT,
  executeWithMetrics,
  toModelOutput,
  truncateTail,
} from './utils'

const TOOL_NAME = 'filesystem_bash'

function getShellArgs(): [string, string] {
  if (process.platform === 'win32') return ['cmd.exe', '/c']
  return [process.env.SHELL || '/bin/sh', '-c']
}

/**
 * Environment the spawned shell receives.
 *
 * Measured 2026-08-21 on the live release server (ps eww): the inherited
 * environment carried 52 variables including SSH_AUTH_SOCK, DATABASE_URL and
 * KAGGLE_API_TOKEN - so every worker-bee shell command ran with an SSH agent
 * socket and live credentials it never needed. The allowlist keeps what a
 * build or git command actually uses and drops the rest.
 *
 * ON by default since 2026-08-21, when a full worker turn ran under the
 * allowlist and its finishing git commit landed (queen.branch.committed at
 * 17:56:19Z with TRIOS_BASH_ENV_ALLOWLIST=1 on the live server) - the ten
 * variables are enough for real work. TRIOS_BASH_ENV_ALLOWLIST=0 is the
 * opt-out for debugging a command that needs the full environment.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'DEVELOPER_DIR',
] as const

function spawnEnv(): Record<string, string | undefined> {
  if (process.env.TRIOS_BASH_ENV_ALLOWLIST === '0') {
    return { ...process.env }
  }
  const scrubbed: Record<string, string | undefined> = {}
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) scrubbed[key] = process.env[key]
  }
  return scrubbed
}

export function createBashTool(cwd: string) {
  return tool({
    description:
      'Execute a shell command and return its output. Commands run in a shell (sh/bash on Unix, cmd on Windows). Output is truncated to the last 2000 lines if too large.',
    inputSchema: z.object({
      command: z.string().describe('Shell command to execute'),
      timeout: z
        .number()
        .optional()
        .describe(`Timeout in seconds (default: ${DEFAULT_BASH_TIMEOUT})`),
    }),
    execute: (params) =>
      executeWithMetrics(TOOL_NAME, async () => {
        const [shell, flag] = getShellArgs()
        const timeoutMs = (params.timeout || DEFAULT_BASH_TIMEOUT) * 1000
        const resolvedCwd = resolve(cwd)

        const proc = Bun.spawn([shell, flag, params.command], {
          cwd: resolvedCwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: spawnEnv(),
        })

        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          proc.kill()
        }, timeoutMs)

        const [stdoutText, stderrText] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])

        const exitCode = await proc.exited
        clearTimeout(timer)

        if (timedOut) {
          let output = stdoutText
          if (stderrText) output += (output ? '\n' : '') + stderrText
          const truncated = truncateTail(output)
          return {
            text: `Command timed out after ${params.timeout || DEFAULT_BASH_TIMEOUT}s\n\n${truncated.content}`,
            isError: true,
          }
        }

        let output = stdoutText
        if (stderrText) output += (output ? '\n' : '') + stderrText

        const truncated = truncateTail(output)
        let result = truncated.content
        if (truncated.truncated) {
          result = `(Output truncated. Showing last ${truncated.keptLines} of ${truncated.totalLines} lines)\n${result}`
        }

        if (exitCode !== 0) {
          result += `\n\n[Exit code: ${exitCode}]`
          return { text: result, isError: true }
        }

        return { text: result || '(no output)' }
      }),
    toModelOutput,
  })
}
