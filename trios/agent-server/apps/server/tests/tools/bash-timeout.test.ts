import { describe, expect, it } from 'bun:test'
import { createBashTool } from '../../src/tools/filesystem/bash'

/// The timeout these tests hand the tool, in seconds (trios#1340).
///
/// A named constant rather than a literal at each use: the deadline given
/// to the tool and the elapsed-time bound asserted against it must read
/// the same number, or the assertion could drift away from the deadline
/// it claims to bound.
const TIMEOUT_SECONDS = 2
const TIMEOUT_MS = TIMEOUT_SECONDS * 1000

/// The multiple of the deadline within which a timed-out call must
/// return. Three times leaves room for process teardown while leaving no
/// room for the defect: the pre-fix code waited for the pipe-holding
/// grandchild's full sleep, thirty times the deadline.
const MAX_ELAPSED_MS = TIMEOUT_MS * 3

async function run(command: string, timeout?: number) {
  const tool = createBashTool(process.cwd())
  // biome-ignore lint/suspicious/noExplicitAny: ai-sdk ToolExecutionOptions
  return (await (tool as any).execute(
    { command, timeout },
    {
      toolCallId: 'test',
      messages: [],
    },
  )) as { text?: string; content?: Array<{ text: string }>; isError?: boolean }
}
function textOf(r: Awaited<ReturnType<typeof run>>): string {
  return r.text ?? r.content?.[0]?.text ?? ''
}

describe('filesystem_bash timeout', () => {
  // The defect (trios#1340): the timer killed the shell and nothing else.
  // A grandchild the shell had started held the write end of the stdout
  // pipe, so the reads after the kill waited for that grandchild to exit -
  // for a hung one, never. The timeout fired, then the call waited anyway.
  // The fix races the reads and the exit wait against the deadline, so the
  // call returns with whatever output arrived in time.
  it('returns within the bound when a grandchild holds the pipe past the deadline', async () => {
    // `sleep 60 &` is the grandchild: it inherits stdout's write end and
    // outlives both the deadline and the killed shell. The foreground
    // `sleep 60` keeps the shell itself alive past the deadline too.
    const started = performance.now()
    const r = await run(
      'echo pipe-holder-started; sleep 60 & sleep 60',
      TIMEOUT_SECONDS,
    )
    const elapsedMs = performance.now() - started

    // The measured elapsed time is part of the record: quoted in the
    // closing report, so a regression shows up as a number, not a hang.
    console.log(
      `timed-out call returned in ${Math.round(elapsedMs)}ms ` +
        `(deadline ${TIMEOUT_MS}ms, bound ${MAX_ELAPSED_MS}ms)`,
    )

    expect(elapsedMs).toBeLessThan(MAX_ELAPSED_MS)
    expect(r.isError).toBe(true)
    const text = textOf(r)
    expect(text).toContain(`Command timed out after ${TIMEOUT_SECONDS}s`)
    // Partial output received before the deadline, not an empty string.
    expect(text).toContain('pipe-holder-started')
  }, 30_000)

  it("returns an ordinary fast command's exit code and full stdout", async () => {
    const r = await run(
      "printf 'fast-stdout-line-1\\nfast-stdout-line-2\\n'; exit 7",
    )
    expect(r.isError).toBe(true)
    const text = textOf(r)
    expect(text).toContain('fast-stdout-line-1')
    expect(text).toContain('fast-stdout-line-2')
    expect(text).toContain('[Exit code: 7]')
  }, 30_000)

  it("returns a succeeding command's full stdout unchanged", async () => {
    const r = await run("printf 'success-line-1\\nsuccess-line-2\\n'")
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe('success-line-1\nsuccess-line-2\n')
  }, 30_000)
})
