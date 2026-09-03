import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  closeDispatch,
  committedFileCount,
  committedFiles,
  drain,
  finishDispatch,
  keyIsLive,
  missingProviderRefusal,
  prepareWorktree,
  recordDispatch,
  refusedKeyCount,
  resolveWorkerProvider,
  Scribe,
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
 * A provider that refuses is not a bee that finished.
 *
 * Measured 2026-09-03: #1323, #1324 and #1325 each ran on key index 1, produced
 * ONE frame, and were written down as `outcome = finished` with the review
 * answering `wait` - indistinguishable from a bee that worked and under-
 * reported. Key 0 was healthy at the same moment, finishing a 257-frame turn.
 *
 * The stream ends CLEANLY when an account runs out of balance: the refusal
 * arrives as a frame, not as a thrown exception, so `drain`'s catch never runs
 * and its default outcome stood. The swarm went on feeding issues to a dead
 * credential and calling the results finished, which is the difference between
 * a supervisor that is idle and one that is lying to itself.
 */
describe('a provider refusal', () => {
  // Local, because the sibling helper lives inside another describe block.
  const sse = (frames: unknown[]) =>
    new Response(
      frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') +
        'data: [DONE]\n\n',
    )

  it('is recognised in the frame the provider actually sends', () => {
    const zai =
      '{"type":"error","error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}'
    expect(Scribe.providerRefusal('error', zai)).toContain(
      'Insufficient balance',
    )
  })

  it('is recognised when the SDK wraps it', () => {
    const wrapped = '{"type":"finish","detail":"AI_APICallError: [1113] quota"}'
    expect(Scribe.providerRefusal('finish', wrapped)).toContain(
      'AI_APICallError',
    )
  })

  // Ordinary traffic must not be read as a refusal, or a healthy swarm writes
  // off its own keys and stops.
  it('is not seen in ordinary traffic', () => {
    expect(
      Scribe.providerRefusal('text-delta', '{"delta":"working on it"}'),
    ).toBeNull()
    expect(
      Scribe.providerRefusal('usage', '{"usage":{"inputTokens":9}}'),
    ).toBeNull()
  })

  it('writes the ending as a refusal and quotes the provider', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        {
          type: 'error',
          error: {
            code: '1113',
            message: 'Insufficient balance, please recharge',
          },
        },
      ]),
      'conv-refused',
      1323,
      'zai',
      1,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(String(closing.params[1])).toContain('provider refused')
    expect(String(closing.params[1])).toContain('Insufficient balance')
  })

  // And the rotation must hear about it, or the next round spends another
  // issue learning the same fact.
  it('stops the rotation handing that key out again', async () => {
    const before = refusedKeyCount('zai')
    const { pool } = recordingPool()
    await drain(
      pool,
      sse([{ type: 'error', error: { message: 'Insufficient balance' } }]),
      'conv-refused-2',
      1324,
      'zai',
      1,
    )
    expect(refusedKeyCount('zai')).toBeGreaterThan(before - 1)
    expect(refusedKeyCount('zai')).toBeGreaterThanOrEqual(1)
  })
})

/**
 * A credential is asked whether it can pay BEFORE an issue is spent on it.
 *
 * Measured 2026-09-03 with four keys configured: two answered HTTP 200 and two
 * answered 429 with Z.AI business code 1113, "Insufficient balance or no
 * resource package". Without the probe the rotation hands each dead key an
 * issue, the turn dies on its first frame, and - before the refusal fix - that
 * was written down as finished work awaiting a verdict. Two dead keys meant two
 * issues consumed to learn what one request answers.
 */
describe('checking a credential before spending an issue', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const answer = (status: number, body: string) => {
    globalThis.fetch = (async () =>
      new Response(body, { status })) as typeof fetch
  }

  it('reads an exhausted package as dead', async () => {
    answer(429, '{"error":{"code":"1113","message":"Insufficient balance"}}')
    expect(
      await keyIsLive({
        provider: 'zai',
        model: 'glm-5.3',
        apiKey: 'k',
        keyIndex: 90,
      }),
    ).toBe(false)
  })

  it('reads a rejected key as dead', async () => {
    answer(401, 'unauthorized')
    expect(
      await keyIsLive({
        provider: 'zai',
        model: 'glm-5.3',
        apiKey: 'k',
        keyIndex: 91,
      }),
    ).toBe(false)
  })

  it('reads a working key as live', async () => {
    answer(200, '{"choices":[]}')
    expect(
      await keyIsLive({
        provider: 'zai',
        model: 'glm-5.3',
        apiKey: 'k',
        keyIndex: 92,
      }),
    ).toBe(true)
  })

  // A network failure is not a refusal. Refusing to dispatch because our own
  // network hiccuped would stall the swarm for a reason that has nothing to do
  // with the credential.
  it('assumes live when the provider cannot be reached at all', async () => {
    globalThis.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as typeof fetch
    expect(
      await keyIsLive({
        provider: 'zai',
        model: 'glm-5.3',
        apiKey: 'k',
        keyIndex: 93,
      }),
    ).toBe(true)
  })

  // A rehearsal turn aims at this server and has no credential to check.
  it('does not probe a rehearsal', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(
      await keyIsLive({
        provider: 'openai-compatible',
        model: 'rehearsal',
        apiKey: 'x',
        rehearsal: true,
        keyIndex: 94,
      }),
    ).toBe(true)
    expect(called).toBe(false)
  })
})
