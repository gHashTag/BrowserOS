import { existsSync } from 'node:fs'
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
 * The full argv for a command, dropping privileges when asked to.
 *
 * The allowlist below keeps secrets out of the child's environment, and that
 * is enough against accidental inheritance. It is not enough against a shell
 * that goes looking: measured 2026-08-28 on the deployed container, which ran
 * everything as root, `tr '\0' '\n' < /proc/1/environ` from inside a tool
 * command printed the server's whole environment - GITHUB_TOKEN, DATABASE_URL
 * and the server's own TRIOS_API_TOKEN among it. Same user, same namespace,
 * so the scrubbed env was a formality.
 *
 * With TRIOS_TOOL_SHELL_USER set, commands run as that user instead, and the
 * server's environment stops being readable because it belongs to somebody
 * else. Unset - every existing local install - nothing changes at all, which
 * is deliberate: `su` is not portable to macOS in this form and a developer's
 * own machine has no second user to drop to.
 */
export function shellArgv(command: string): string[] {
  const [shell, flag] = getShellArgs()
  const user = process.env.TRIOS_TOOL_SHELL_USER
  if (process.platform === 'win32' || !user) return [shell, flag, command]
  // `-s` because the target account is deliberately shell-less in the image,
  // and without it su refuses with "This account is currently not available".
  return ['su', '-s', shell, user, '-c', command]
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

/**
 * BUN'S CACHE MUST SHARE A FILESYSTEM WITH THE WORKTREES.
 *
 * A hardlink cannot cross a filesystem boundary. Measured on the live container
 * 2026-09-05:
 *
 *   /home/bee/.bun   2493 MB   on `overlay`      (the image, 2 TB)
 *   /workspace       46 GB     on /dev/zd29056   (the volume)
 *
 * Different devices, so `bun install` cannot link a package into a worktree's
 * node_modules and copies it instead - about 2.4 GB per worktree, every
 * dispatch. A sample confirmed it: `links=1` on a package file inside a
 * worktree, where a shared store would show more.
 *
 * That is what refills a 46 GB volume at 39 points per hour while the reapers
 * work correctly. Four bees installing four private copies of one dependency
 * tree is 10 GB per generation, and no collection strategy wins against a
 * duplication rate like that - which is why three rounds of tuning reapers
 * moved the symptom and never the cause.
 *
 * Put the cache on the volume and the copies become links: one store, and each
 * worktree's node_modules costs almost nothing.
 *
 * Set explicitly rather than passed through the allowlist, because it is not a
 * configuration choice - it is a fact about where this deployment's filesystems
 * are. `TRIOS_BUN_CACHE_DIR` overrides it, and a machine with no /workspace - a
 * laptop, CI - is left exactly as it was.
 */
export function bunCacheDir(exists: (p: string) => boolean = existsSync): string | undefined {
  const override = process.env.TRIOS_BUN_CACHE_DIR
  if (override) return override
  return exists('/workspace') ? '/workspace/.bun-cache' : undefined
}

function spawnEnv(): Record<string, string | undefined> {
  if (process.env.TRIOS_BASH_ENV_ALLOWLIST === '0') {
    return { ...process.env }
  }
  const scrubbed: Record<string, string | undefined> = {}
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) scrubbed[key] = process.env[key]
  }
  const cache = bunCacheDir()
  if (cache) scrubbed.BUN_INSTALL_CACHE_DIR = cache
  return scrubbed
}

/// How much output is kept in memory while a command runs, in characters.
///
/// `truncateTail` returns at most 2000 lines within 50 KB, so anything beyond
/// this is read and thrown away. Sized generously against that - a hundredfold
/// - so a long line or an unlucky chunk boundary cannot eat into what the
/// caller would have seen.
const TAIL_WINDOW_CHARS = 5 * 1024 * 1024

/// The largest timeout a model may ask for, in seconds.
///
/// `timeout` is model-supplied and was unbounded. A command that asks for a day
/// and hangs holds its slot for a day, and with the swarm bounded by
/// concurrent sessions that is a slot no other bee gets.
const MAX_BASH_TIMEOUT = 900

/// The timeout that will actually be applied, and whether it was reduced.
///
/// Separated from the tool body so the rule can be tested without waiting out
/// a real timer - proving the cap by letting a command run for fifteen minutes
/// is not a test anyone will keep.
export function effectiveTimeout(requested: number | undefined): {
  seconds: number
  capped: boolean
} {
  const asked = requested && requested > 0 ? requested : DEFAULT_BASH_TIMEOUT
  return {
    seconds: Math.min(asked, MAX_BASH_TIMEOUT),
    capped: asked > MAX_BASH_TIMEOUT,
  }
}

/// Reads a stream keeping only the tail the caller can actually use.
///
/// `new Response(stream).text()` materialises the whole output before anything
/// is truncated. Measured 2026-08-29 on the deployed container: `cat` of a
/// 257 MB log cost **889.8 MB of RSS** - 3.46x the file - to return 51,018
/// characters, and stalled the event loop 428 ms while every other agent
/// session waited behind it. One process serves every bee, so that is the
/// swarm's memory ceiling being set by whoever runs the least careful command,
/// and a cgroup OOM takes all of them together.
///
/// What is discarded is counted first, so the caller can say a tail is a tail
/// rather than presenting it as the whole. Counted in characters, which is what
/// the window actually bounds - the decoded string held in memory, not the
/// bytes that arrived.
///
/// `deadline` is the command's timeout, resolved by the timer in
/// `createBashTool` - and never resolved on the happy path, so a command that
/// finishes inside its timeout is read exactly as before. When the deadline
/// does fire, the loop below stops at that instant and returns the tail
/// collected so far: the stream itself ends only when every holder of the
/// write end exits, and a grandchild the shell started holds it too
/// (trios#1340).
async function readBoundedTail(
  stream: ReadableStream<Uint8Array>,
  deadline: Promise<void>,
): Promise<{ text: string; droppedChars: number }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const held: string[] = []
  let heldChars = 0
  let droppedChars = 0

  while (true) {
    // Each read is raced against the deadline, so the loop ends when the
    // stream ends or when the timeout fires, whichever comes first.
    const chunk = await Promise.race([
      reader.read(),
      // `null` is not a value `read()` can produce, so it unambiguously
      // means the deadline won.
      deadline.then(() => null),
    ])
    if (chunk === null) {
      // Timed out mid-stream: stop reading, release this end of the pipe,
      // and let the caller have the tail collected so far. The abandoned
      // `read()` settles into a race that is already over.
      void reader.cancel().catch(() => {})
      break
    }
    if (chunk.done) break
    const value = chunk.value
    // `stream: true` so a multi-byte character split across two chunks is not
    // decoded as two replacement characters.
    const piece = decoder.decode(value, { stream: true })
    if (!piece) continue
    held.push(piece)
    heldChars += piece.length
    while (heldChars > TAIL_WINDOW_CHARS && held.length > 1) {
      const shed = held.shift() as string
      heldChars -= shed.length
      droppedChars += shed.length
    }
  }
  const tail = decoder.decode()
  if (tail) held.push(tail)
  return { text: held.join(''), droppedChars }
}

/// stdout and stderr as the caller sees them: one stream, stderr last.
function combined(stdoutText: string, stderrText: string): string {
  if (!stderrText) return stdoutText
  return stdoutText ? `${stdoutText}\n${stderrText}` : stderrText
}

/// How the truncation is described, or nothing when there was none.
///
/// `totalLines` counts what reached this process, which after the bounded read
/// above is no longer everything the command produced. Saying so keeps the
/// count honest rather than quietly redefining "total" to mean "the part we
/// kept".
function truncationNote(
  truncated: { truncated: boolean; keptLines: number; totalLines: number },
  droppedChars: number,
): string | null {
  if (!truncated.truncated) return null
  const head = `(Output truncated. Showing last ${truncated.keptLines} of ${truncated.totalLines} lines`
  return droppedChars > 0
    ? `${head} held; a further ${droppedChars} characters were discarded while the command ran)`
    : `${head})`
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
        const requested = params.timeout || DEFAULT_BASH_TIMEOUT
        const limit = effectiveTimeout(params.timeout)
        const timeoutMs = limit.seconds * 1000
        const resolvedCwd = resolve(cwd)

        const proc = Bun.spawn(shellArgv(params.command), {
          cwd: resolvedCwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: spawnEnv(),
        })

        let timedOut = false
        // Resolved by the timer below. Every wait on the child is raced
        // against it, so the timeout bounds the call rather than only
        // signalling it. `proc.kill()` reaches the shell, but a grandchild
        // the shell started keeps the write end of the pipes open, and the
        // reads would otherwise wait for that grandchild to exit - for a
        // hung one, never (trios#1340). Raced here, a timed-out call
        // returns with whatever output arrived before the deadline.
        let onDeadline!: () => void
        const deadline = new Promise<void>((resolve) => {
          onDeadline = resolve
        })
        const timer = setTimeout(() => {
          timedOut = true
          proc.kill()
          onDeadline()
        }, timeoutMs)

        const [out, err] = await Promise.all([
          readBoundedTail(proc.stdout as ReadableStream<Uint8Array>, deadline),
          readBoundedTail(proc.stderr as ReadableStream<Uint8Array>, deadline),
        ])
        const stdoutText = out.text
        const stderrText = err.text
        const droppedChars = out.droppedChars + err.droppedChars

        // Raced as well: the exit wait follows the reads and must not be
        // able to outlive the deadline any more than they can. On the
        // happy path the deadline never resolves and this is plain
        // `await proc.exited`; when the timeout fires, the raced value is
        // unused - the timed-out branch below does not read an exit code.
        const exitCode = await Promise.race([
          proc.exited,
          deadline.then(() => null),
        ])
        clearTimeout(timer)

        if (timedOut) {
          const truncated = truncateTail(combined(stdoutText, stderrText))
          return {
            // The applied timeout, not the requested one. A model asking for
            // 86400 and being cut at 900 must not be told it waited a day.
            text: `Command timed out after ${limit.seconds}s${
              limit.capped ? ` (requested ${requested}s, capped)` : ''
            }\n\n${truncated.content}`,
            isError: true,
          }
        }

        const truncated = truncateTail(combined(stdoutText, stderrText))
        const note = truncationNote(truncated, droppedChars)
        let result = note ? `${note}\n${truncated.content}` : truncated.content

        if (exitCode !== 0) {
          result += `\n\n[Exit code: ${exitCode}]`
          return { text: result, isError: true }
        }

        return { text: result || '(no output)' }
      }),
    toModelOutput,
  })
}
