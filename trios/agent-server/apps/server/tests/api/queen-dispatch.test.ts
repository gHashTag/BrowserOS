import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  closeDispatch,
  committedFileCount,
  committedFiles,
  configuredWorkerCapacity,
  dispatchBee,
  drain,
  finishDispatch,
  missingProviderRefusal,
  prepareWorktree,
  reapDispatchesFromPreviousBoot,
  reapStalledDispatches,
  recordDispatch,
  resolveWorkerProvider,
  setDurableCloseListener,
  workspaceRoot,
} from '../../src/api/services/queen-dispatch'
import { logger } from '../../src/lib/logger'

const KEYS = [
  'ZAI_API_KEY',
  'ZAI_API_KEY_2',
  'ZAI_API_KEY_3',
  'ZAI_API_KEY_4',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'TRIOS_QUEEN_WORKER_MODEL',
]

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

// The suite must pass under the environment #1293's independent test describes:
// `ZAI_API_KEY=x ZAI_API_KEY_2=x bun test ...`. Variables present when the
// process starts would otherwise walk into the FIRST case, which asserts that a
// deployment with no credential refuses - and clearing only between cases is
// one case too late. Clearing here also keeps any real secret sitting in the
// runner's environment out of every assertion below, so a failure can never
// print one.
beforeAll(() => {
  for (const key of KEYS) delete process.env[key]
})

describe('queen dispatch precheck', () => {
  // The state of the deployment on 2026-08-29, measured rather than assumed:
  // the live /chat answered `z.ai provider requires apiKey`. Dispatch must
  // refuse BEFORE it cuts a worktree, or every round leaves a branch and a
  // directory behind for a bee that was never going to run.
  it('refuses when the deployment has no provider credential', () => {
    expect(resolveWorkerProvider()).toBeNull()
  })

  it('names every variable that would fix it, and who may set it', () => {
    const refusal = missingProviderRefusal()
    for (const key of KEYS.filter((k) => k.endsWith('API_KEY'))) {
      expect(refusal).toContain(key)
    }
    expect(refusal).toContain('operator')
  })

  // An empty string is the trap this repository has already been caught by:
  // `~/.trios/config.json` holds two provider keys with zero-length values, so
  // every check for the NAME passes and every read of the VALUE gets nothing.
  it('treats an empty key as absent, not as configured', () => {
    process.env.ZAI_API_KEY = ''
    expect(resolveWorkerProvider()).toBeNull()
  })

  it('takes the first provider in preference order', () => {
    process.env.OPENAI_API_KEY = 'x'
    expect(resolveWorkerProvider()?.provider).toBe('openai')
    process.env.ZAI_API_KEY = 'y'
    expect(resolveWorkerProvider()?.provider).toBe('zai')
  })

  it('lets the deployment pin a model without pinning a provider', () => {
    process.env.ANTHROPIC_API_KEY = 'x'
    process.env.TRIOS_QUEEN_WORKER_MODEL = 'claude-opus-4-1'
    const chosen = resolveWorkerProvider()
    expect(chosen?.provider).toBe('anthropic')
    expect(chosen?.model).toBe('claude-opus-4-1')
  })

  it('roots the checkout under the workspace volume, not the app directory', () => {
    expect(workspaceRoot()).toBe('/workspace/BrowserOS')
  })

  // Four bees on one key share one rate limit, so the swarm's real ceiling
  // becomes whatever that key allows rather than what the Queen permits - and
  // the 429 arrives blamed on the work.
  describe('key rotation', () => {
    it('hands out the lowest key index nobody is holding', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      process.env.ZAI_API_KEY_3 = 'c'
      expect(resolveWorkerProvider([])?.keyIndex).toBe(0)
      expect(resolveWorkerProvider([0])?.keyIndex).toBe(1)
      expect(resolveWorkerProvider([0, 1])?.keyIndex).toBe(2)
      // A gap is filled rather than skipped past: bee 1 finished, its key is
      // free, and the next bee should take it instead of reaching for a fourth
      // that does not exist.
      expect(resolveWorkerProvider([0, 2])?.keyIndex).toBe(1)
    })

    it('reports exhaustion by name instead of reusing a key', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      const chosen = resolveWorkerProvider([0, 1])
      expect(chosen?.exhausted).toBe(2)
      expect(chosen?.apiKey).toBeUndefined()
    })

    it('preserves the prior provider, model and free key for a retry', () => {
      process.env.ZAI_API_KEY = 'z0'
      process.env.ZAI_API_KEY_2 = 'z1'
      process.env.OPENAI_API_KEY = 'o0'
      const chosen = resolveWorkerProvider([], {
        provider: 'zai',
        model: 'glm-5.3-pinned',
        keyIndex: 1,
      })
      expect(chosen?.provider).toBe('zai')
      expect(chosen?.model).toBe('glm-5.3-pinned')
      expect(chosen?.keyIndex).toBe(1)
      expect(chosen?.apiKey).toBe('z1')
    })

    it('keeps the retry queued when its exact prior key is still busy', () => {
      process.env.ZAI_API_KEY = 'z0'
      process.env.ZAI_API_KEY_2 = 'z1'
      process.env.OPENAI_API_KEY = 'o0'
      const chosen = resolveWorkerProvider([1], {
        provider: 'zai',
        model: 'glm-5.3',
        keyIndex: 1,
      })
      expect(chosen?.provider).toBe('zai')
      expect(chosen?.preferredKeyBusy).toBe(1)
      expect(chosen?.keyIndex).toBeUndefined()
      expect(chosen?.apiKey).toBeUndefined()
    })

    // The trap this design exists to avoid. The four issues in flight when it
    // was written - 1176, 1216, 1240, 1244 - are ALL 0 mod 4, so an
    // issue-number hash would have put every bee on one key while looking like
    // rotation.
    it('does not distribute by issue number', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      process.env.ZAI_API_KEY_3 = 'c'
      process.env.ZAI_API_KEY_4 = 'd'
      const byIssue = [1176, 1216, 1240, 1244].map((n) => n % 4)
      expect(new Set(byIssue).size).toBe(1)
      const bySlot = [[], [0], [0, 1], [0, 1, 2]].map(
        (taken) => resolveWorkerProvider(taken)?.keyIndex,
      )
      expect(new Set(bySlot).size).toBe(4)
    })

    // A platform variable saved with an empty box leaves the NAME behind. A
    // rotation that counted names would hand a bee a key that authenticates
    // with nothing.
    it('does not count an empty key as a key', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = ''
      process.env.ZAI_API_KEY_3 = 'c'
      expect(resolveWorkerProvider([])?.keyCount).toBe(2)
      expect(resolveWorkerProvider([0])?.apiKey).toBe('c')
    })

    // #1293. A variable duplicated across names - the platform's copy button,
    // an env block pasted twice - is one account with one rate limit. Counting
    // it twice makes the dashboard promise parallel capacity that shares a
    // single limit, and the second "free" slot hands a bee a secret its
    // sibling is already spending.
    describe('duplicate secrets', () => {
      it('reports one slot when both variables hold the same key', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        expect(configuredWorkerCapacity()).toBe(1)
      })

      it('reports two slots for two distinct keys', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'b'
        expect(configuredWorkerCapacity()).toBe(2)
      })

      // The fixture from the issue: a, a, b - exactly two worker slots.
      it('counts a, a and b as exactly two worker slots', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        process.env.ZAI_API_KEY_3 = 'b'
        expect(configuredWorkerCapacity()).toBe(2)
      })

      // Selection must agree with capacity. If the count says two but the
      // rotation still had three indices, the dashboard's "one free key" and
      // the dispatch's key 3 would be two different stories about the same
      // two secrets - and the third story would hand out a duplicate.
      it('never assigns the same secret as two independent keys', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        process.env.ZAI_API_KEY_3 = 'b'
        const first = resolveWorkerProvider([])
        expect(first?.keyCount).toBe(2)
        const second = resolveWorkerProvider([first?.keyIndex ?? 0])
        expect(second?.keyIndex).toBe(1)
        expect(second?.apiKey).not.toBe(first?.apiKey)
        // There is no third secret, so a third bee is told the pool is
        // exhausted rather than handed a copy of one already in flight.
        const third = resolveWorkerProvider([0, 1])
        expect(third?.exhausted).toBe(2)
        expect(third?.apiKey).toBeUndefined()
      })

      // Deduplication must not reorder or un-skip: the unsuffixed variable
      // stays index 0 (first occurrence wins), and an empty value stays
      // absent even when duplicates surround it.
      it('keeps the unsuffixed key first and empty values absent', () => {
        process.env.ZAI_API_KEY = 'b'
        process.env.ZAI_API_KEY_2 = ''
        process.env.ZAI_API_KEY_3 = 'a'
        process.env.ZAI_API_KEY_4 = 'b'
        const first = resolveWorkerProvider([])
        expect(first?.keyCount).toBe(2)
        expect(first?.keyIndex).toBe(0)
        expect(resolveWorkerProvider([0])?.apiKey).toBe('a')
        expect(resolveWorkerProvider([0, 1])?.exhausted).toBe(2)
      })
    })
  })
})

/** Every statement a call made, with the values it bound. */
function recordingPool(
  answer: (sql: string, attempt: number) => unknown = () => ({
    rowCount: 1,
    rows: [],
  }),
) {
  const asked: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      asked.push({ sql: String(sql), params })
      const answered = answer(String(sql), asked.length)
      if (answered instanceof Error) throw answered
      return answered as { rowCount: number; rows: unknown[] }
    },
  } as unknown as Pool
  return { pool, asked }
}

/** The statements that touched one table, in the order they were sent. */
const touching = (
  asked: Array<{ sql: string; params: unknown[] }>,
  table: string,
) => asked.filter((q) => q.sql.includes(table))

describe('changes-requested retry recovery', () => {
  it('keeps a retry visible when its prior provider is unavailable', async () => {
    const { pool, asked } = recordingPool()
    const outcome = await dispatchBee(
      pool,
      1315,
      'apply the review note',
      ['trios/agent-server/**'],
      [],
      ['second tick must retry'],
      'github',
      { provider: 'zai', model: 'glm-5.3', keyIndex: 0 },
    )
    expect(outcome.started).toBe(false)
    const update = touching(asked, 'queen_dispatch')[0]
    expect(update.sql).toContain("review_state = 'sendBack'")
    expect(update.sql).not.toContain('started = false')
  })

  it('keeps a retry visible instead of changing keys when its key is busy', async () => {
    process.env.ZAI_API_KEY = 'z0'
    process.env.ZAI_API_KEY_2 = 'z1'
    const { pool, asked } = recordingPool()
    const outcome = await dispatchBee(
      pool,
      1315,
      'apply the review note',
      ['trios/agent-server/**'],
      [1],
      ['same key must remain attributable'],
      'github',
      { provider: 'zai', model: 'glm-5.3', keyIndex: 1 },
    )
    expect(outcome.started).toBe(false)
    expect(outcome.detail).toContain('prior provider key slot 2')
    const update = touching(asked, 'queen_dispatch')[0]
    expect(update.sql).toContain("review_state = 'sendBack'")
    expect(update.sql).not.toContain('started = false')
  })

  it('returns only a pre-flight retry claim to sendBack on boot recovery', async () => {
    const { pool, asked } = recordingPool()
    await reapDispatchesFromPreviousBoot(pool)
    const sql = asked[0].sql
    expect(sql).toContain('CASE WHEN retry_of_send_back')
    expect(sql).toContain("THEN 'sendBack'")
    expect(sql).toContain('retry_of_send_back = false')
  })

  it('returns only a pre-flight retry claim to sendBack on stall recovery', async () => {
    const { pool, asked } = recordingPool()
    await reapStalledDispatches(pool, 30)
    const sql = asked[0].sql
    expect(sql).toContain('CASE WHEN retry_of_send_back')
    expect(sql).toContain("THEN 'sendBack'")
    expect(asked[0].params).toEqual([30])
  })
})

/**
 * The only statement that ends a turn used to fail in complete silence.
 *
 * `finishDispatch(...).catch(() => {})` inside a function that is itself
 * `void`ed: no log, no retry, no counter, and no caller able to see it either.
 * What it leaves behind is a phantom - the row keeps finished_at NULL and
 * started true, which the board reads as `running`, so a bee that has stopped
 * holds its boundary until the 120-minute stall sweep reaps it. Reaping
 * RELEASES the issue for retry, which is how #1244 was dispatched six times.
 */
describe('closing a dispatch', () => {
  const captureErrors = () => {
    const errors: Array<{ message: string; meta?: Record<string, unknown> }> =
      []
    const original = logger.error.bind(logger)
    logger.error = (message: string, meta?: Record<string, unknown>) => {
      errors.push({ message, meta })
    }
    return { errors, restore: () => (logger.error = original) }
  }

  it('logs and retries when the ending cannot be written', async () => {
    const { pool, asked } = recordingPool((_sql, attempt) =>
      attempt === 1 ? new Error('connection terminated unexpectedly') : {},
    )
    const { errors, restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    expect(asked.length).toBe(2)
    expect(errors.length).toBe(1)
    // The issue and the conversation, or the line cannot be traced to a bee.
    expect(errors[0].meta?.issue).toBe(1244)
    expect(errors[0].meta?.conversationId).toBe('conv-1')
    expect(String(errors[0].meta?.error)).toContain('connection terminated')
  })

  // AN UPDATE THAT CHANGED NOTHING DOES NOT THROW, so the `try` above cannot
  // see it and the old code called it a written ending. A skeptic proved that
  // matters: with the history archive added, a turn whose frames are all NOISE
  // reached this function BEFORE its dispatch row existed, the UPDATE matched
  // zero rows in silence, and the upsert that followed wrote started=true with
  // finished_at NULL - the exact phantom this function exists to prevent,
  // arriving with no database failure anywhere in it.
  it('says so when the ending matched no row at all', async () => {
    const { pool, asked } = recordingPool(() => ({ rowCount: 0, rows: [] }))
    const { errors, restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    // One statement: it did not throw, so there is nothing to retry.
    expect(asked.length).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain('matched no row')
    expect(errors[0].meta?.issue).toBe(1244)
    expect(errors[0].meta?.conversationId).toBe('conv-1')
  })

  it('stays quiet when the ending did land', async () => {
    const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    const { errors, restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    expect(errors).toEqual([])
  })

  it('does not throw when the retry fails too', async () => {
    const { pool, asked } = recordingPool(() => new Error('still down'))
    const { restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    // Two attempts and no more: the stall reaper is the backstop, and a loop
    // here would hold a dead stream open.
    expect(asked.length).toBe(2)
  })

  // Unknown is not zero. A turn killed mid-stream never reaches its usage
  // frame, and writing 0 for it would price a real turn at nothing.
  it('leaves an existing price alone when the turn reported none', async () => {
    const { pool, asked } = recordingPool()
    await finishDispatch(pool, 1244, 'reaped')
    expect(asked[0].sql).toContain('COALESCE')
    expect(asked[0].params[2]).toBeNull()
    expect(asked[0].params[3]).toBeNull()
  })
})

/**
 * What the turn cost, on the row rather than inside a string.
 *
 * The stream has carried a usage frame since 2026-08-21 and this module let it
 * fall through to the default branch, where it was stored as 800 characters of
 * JSON in the transcript. queen_dispatch had no numeric column at all, so
 * pricing one round meant string-parsing one transcript row.
 */
describe('draining a turn', () => {
  const sse = (frames: unknown[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const frame of frames) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
            )
          }
          controller.close()
        },
      }),
    )

  it('writes the token counts the stream reported', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'text-delta', delta: 'working' },
        // The shape chat-service.ts emits, nested under `usage`.
        { type: 'usage', usage: { inputTokens: 18308, outputTokens: 45 } },
        { type: 'finish' },
      ]),
      'conv-1',
      1244,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing.length).toBe(1)
    expect(closing[0].params).toEqual([1244, 'finished', 18308, 45, 'conv-1'])
  })

  // The ending must name the turn it belongs to, not just the issue.
  //
  // Keyed by issue alone, a stream from a previous attempt that finishes late
  // closes the CURRENT attempt's row - and drives its token counts through the
  // COALESCE that exists to protect a price. The reaper releases an issue for
  // retry while the old container's stream may still be alive, so two turns for
  // one issue overlap as a matter of routine.
  it('closes the turn it belongs to and not merely the issue', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
        { type: 'finish' },
      ]),
      'the-second-attempt',
      1244,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(closing.params).toContain('the-second-attempt')
    expect(closing.sql).toContain('conversation_id')
  })

  it('still shows the cost in the feed a person watches', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([{ type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }]),
      'conv-1',
      1244,
    )
    const rows = touching(asked, 'queen_transcript')
    expect(rows.some((r) => r.params[3] === 'usage')).toBe(true)
    expect(
      rows.some((r) => String(r.params[4]).includes('12 in / 3 out')),
    ).toBe(true)
  })

  it('reports no price rather than a free turn when the frame never came', async () => {
    const { pool, asked } = recordingPool()
    await drain(pool, sse([{ type: 'text-delta', delta: 'killed' }]), 'c', 1244)
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing[0].params[2]).toBeNull()
    expect(closing[0].params[3]).toBeNull()
  })
})

/**
 * queen_dispatch is keyed by issue alone, so a second attempt overwrites the
 * first in place: which key it took, how long it ran and why it ended all stop
 * existing. #1244 was dispatched six times and one row survived it.
 */
describe('recording a dispatch', () => {
  it('archives the attempt it is about to overwrite, first', async () => {
    const { pool, asked } = recordingPool()
    await recordDispatch(pool, 1244, 'queen-1244', true, 'cut from dev', [])
    const archive = asked.findIndex((q) =>
      q.sql.includes('queen_dispatch_history'),
    )
    const upsert = asked.findIndex((q) => q.sql.includes('ON CONFLICT (issue)'))
    expect(archive).toBeGreaterThanOrEqual(0)
    expect(archive).toBeLessThan(upsert)
    expect(asked[archive].params).toEqual([1244])
    // The whole row as one value. A copied column list would be a second rule,
    // stale on the first ALTER that touched the table it copies.
    expect(asked[archive].sql).toContain('to_jsonb(queen_dispatch)')
  })

  it('does not fail the dispatch when the archive cannot be written', async () => {
    const { pool, asked } = recordingPool((sql) =>
      sql.includes('queen_dispatch_history')
        ? new Error('relation "queen_dispatch_history" does not exist')
        : {},
    )
    await recordDispatch(pool, 1244, 'queen-1244', true, 'cut from dev', [])
    expect(touching(asked, 'ON CONFLICT (issue)').length).toBe(1)
  })

  // Measured on a scratch database while this was written: without the reset a
  // second dispatch of #1244 inherited the first attempt's 18308 input tokens
  // and reported them as its own.
  it('starts the new attempt with no price of its own', async () => {
    const { pool, asked } = recordingPool()
    await recordDispatch(pool, 1244, 'queen-1244', true, 'cut from dev', [])
    const upsert = touching(asked, 'ON CONFLICT (issue)')[0]
    expect(upsert.sql).toContain('input_tokens = NULL')
    expect(upsert.sql).toContain('output_tokens = NULL')
  })
})

/**
 * Git-backed. These drive real `git` in a throwaway repository, because the
 * defect being fixed is that the code did not RUN a git command it should
 * have - a mocked git would agree with whatever the source says.
 */
describe('an existing worktree', () => {
  const git = (cwd: string, args: string[]) => {
    const done = Bun.spawnSync(['git', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    if (done.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${done.stderr.toString()}`)
    }
    return done.stdout.toString().trim()
  }

  /** A repository with one commit and a worktree cut for issue 99. */
  function hive(): { root: string; worktree: string; restore: () => void } {
    const previous = process.env.WORKSPACE_DIR
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'queen-hive-')))
    const root = join(workspace, 'BrowserOS')
    mkdirSync(root)
    git(root, ['init', '-q', '-b', 'dev'])
    git(root, ['config', 'user.email', 'bee@example.com'])
    git(root, ['config', 'user.name', 'Bee'])
    writeFileSync(join(root, 'README.md'), 'hive\n')
    git(root, ['add', '.'])
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
    const worktree = join(root, '.worktrees', 'queen-99')
    git(root, ['worktree', 'add', '-q', '-B', 'queen-99', worktree, 'dev'])
    process.env.WORKSPACE_DIR = workspace
    return {
      root,
      worktree,
      restore: () => {
        if (previous === undefined) delete process.env.WORKSPACE_DIR
        else process.env.WORKSPACE_DIR = previous
      },
    }
  }

  // The container holds no push credential by design, so what a previous bee
  // left uncommitted in that tree is the only copy of it. The next bee inherits
  // it either way; the row and the brief used to say "reused an existing
  // worktree" and let that pass unnoticed.
  it('says how much a previous attempt left behind', async () => {
    const { worktree, restore } = hive()
    try {
      writeFileSync(join(worktree, 'half-done.ts'), 'export const x = 1\n')
      writeFileSync(join(worktree, 'README.md'), 'edited\n')
      const prepared = await prepareWorktree(99)
      expect(prepared.ok).toBe(true)
      expect(prepared.detail).toContain('2 uncommitted file(s)')
    } finally {
      restore()
    }
  })

  it('says it is clean when it is', async () => {
    const { restore } = hive()
    try {
      const prepared = await prepareWorktree(99)
      expect(prepared.detail).toBe('reused an existing worktree (clean)')
    } finally {
      restore()
    }
  })

  // The measurement `queend`'s unused `boundary` question needs. The count was
  // all that ever left this module, and the diff that produces it is the only
  // record of WHERE a bee wrote.
  it('names the files a branch committed, not just how many', async () => {
    const { root, worktree, restore } = hive()
    const previousRef = process.env.TRIOS_REPO_REF
    process.env.TRIOS_REPO_REF = 'dev'
    try {
      writeFileSync(join(worktree, 'owned.ts'), 'export const a = 1\n')
      writeFileSync(join(worktree, 'stray.ts'), 'export const b = 2\n')
      git(worktree, ['add', '.'])
      git(worktree, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'bee work'])
      expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dev')
      const files = await committedFiles(99)
      expect(files.sort()).toEqual(['owned.ts', 'stray.ts'])
      expect(await committedFileCount(99)).toBe(2)
    } finally {
      if (previousRef === undefined) delete process.env.TRIOS_REPO_REF
      else process.env.TRIOS_REPO_REF = previousRef
      restore()
    }
  })
})

/**
 * #1295. A finished bee frees a healthy paid key, and until this the next
 * eligible mission waited for the periodic tick - up to 1,800 seconds of idle
 * capacity per finished bee, on a swarm whose whole point is that no laptop
 * has to be awake to keep it busy.
 *
 * The signal must be EARNED by a durable close. An UPDATE that changed
 * nothing does not throw, so "the write succeeded" and "the write matched no
 * row" were the same answer one layer out - and announcing a freed slot about
 * a row that still reads `running` would wake a round that sees the bee as in
 * flight and skips the very work the signal promised. The retry and, behind
 * it, the stall reaper stay authoritative for every close that did not land.
 *
 * These cases use a recording pool rather than a database because the
 * question is which CLOSES signal, not whether Postgres can UPDATE - and the
 * issue's own independent test asks for exactly that shape: fake pools, no
 * sleeping, no real provider.
 */
describe('a durable close frees the slot at once', () => {
  afterEach(() => {
    // The listener is module state. A case that forgets to clear it would
    // hand its hook to every later close in this file - a signal from a test
    // nobody is looking at.
    setDurableCloseListener(undefined)
  })

  /** A stream that has already ended, the way a real bee's does. */
  const endedStream = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"finish"}\n\n'),
          )
          controller.close()
        },
      }),
    )

  // Scenario 1: one updated row is the durable running-to-finished
  // transition, and it must ask for a refill without waiting for the timer.
  it('signals one refill when the ending landed on one row', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(heard).toEqual([1295])
  })

  // The stream ending is WHEN the slot frees, so the signal must travel the
  // drain path a real bee takes - not only a hand-made closeDispatch call.
  it('signals when the stream ends and the close is durable', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    await drain(pool, endedStream(), 'conv-1295', 1295)
    expect(heard).toEqual([1295])
  })

  // Scenario 3, first half: zero rows means the transition never happened.
  it('signals nothing when the ending matched no row', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool, asked } = recordingPool(() => ({ rowCount: 0, rows: [] }))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(heard).toEqual([])
    // Unchanged: nothing threw, so there is no retry to make.
    expect(asked.length).toBe(1)
  })

  // Scenario 3, second half: a close whose every write failed leaves the row
  // running. The stall reaper, not a hopeful signal, decides when that slot
  // is free.
  it('signals nothing when both write attempts fail', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool, asked } = recordingPool(() => new Error('still down'))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(heard).toEqual([])
    // Unchanged: one retry, then silence.
    expect(asked.length).toBe(2)
  })

  // A close that needed its retry but LANDED is closed as far as the board
  // can see - the row says finished - and suppressing the signal here would
  // restore the half-hour wait for exactly the deployments with the flakiest
  // databases, which are the ones that most need the slot back.
  it('signals when only the retry landed, because the row is closed either way', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool, asked } = recordingPool((_sql, attempt) =>
      attempt === 1
        ? new Error('connection terminated unexpectedly')
        : { rowCount: 1, rows: [] },
    )
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(asked.length).toBe(2)
    expect(heard).toEqual([1295])
  })

  // The tick loop is the only listener. A server running without it (local
  // development, the app alongside) must close exactly as before, because a
  // completion with nobody local to refill is a normal minute, not an error.
  it('closes quietly when no listener is installed', async () => {
    const { pool, asked } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(asked.length).toBe(1)
  })
})
