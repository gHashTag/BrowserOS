/**
 * The review runs the compiler on the bee's commit, and what it finds outranks
 * the bee's verdict line.
 *
 * Measured 2026-09-10 (gHashTag/t27#3560): 34 finished bee branches, every one
 * reviewed as met on the bee's own VERDICT block; 20 did not parse, 4 parsed
 * with DISCARDED tokens, 1 regressed typecheck, 9 held. The reviewer had no
 * `t27c`, so it had never been able to check - and never said so.
 *
 * Three layers, tested separately:
 *   - reading the witness script's lines (pure, recorded from a real t27c);
 *   - turning a witness into verdict lines the policy weighs (pure);
 *   - the review itself: no compiler + specs on the branch => escalate with
 *     the reason written down, never accept.
 * The end-to-end case with a real compiler is gated on one being present.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Pool } from 'pg'
import {
  readWitnessLines,
  type SpecWitness,
  type Witness,
  witnessSpecs,
  witnessVerdicts,
} from '../../src/api/services/queen-dispatch'
import {
  briefFor,
  reviewFinishedDispatches,
  workerSystemPrompt,
} from '../../src/api/services/queen-tick'

const ISSUE = 3542

// Recorded 2026-09-13 from `t27c 0.2.0` (gHashTag/t27 master 4dfb1ab) run
// through the witness script on a real commit. If the compiler's report format
// changes, these fixtures are the first thing to re-record.
const CLEAN = [
  'W parse ok',
  'W pc parse and consume all    1',
  'W pc parse but TRUNCATE       0',
  'W pc parse but DISCARD        0 (0 token(s))',
  'W pc do not parse             0',
  'W todo 0',
  'W typecheck ok',
  'W base ok',
].join('\n')

const DISCARD = [
  'W parse ok',
  'W pc /tmp/tmp.DF3dq4PGT3/specs/one/logging.t27: DISCARDED 1 top-level token(s)',
  'W pc parse and consume all    0',
  'W pc parse but TRUNCATE       0',
  'W pc parse but DISCARD        1 (1 token(s))',
  'W pc do not parse             0',
  'W todo 0',
  'W typecheck ok',
  'W base fail',
].join('\n')

const STUB = [
  'W parse ok',
  'W pc parse and consume all    1',
  'W pc parse but TRUNCATE       0',
  'W pc parse but DISCARD        0 (0 token(s))',
  'W pc do not parse             0',
  'W todo 1',
  'W typecheck ok',
  'W base ok',
].join('\n')

const NO_PARSE = [
  'W parse fail Error: Parse error: parse error at module level near line 130: unexpected token after expression statement: Ident',
  'W pc parse and consume all    0',
  'W pc parse but TRUNCATE       0',
  'W pc parse but DISCARD        0 (0 token(s))',
  'W pc do not parse             1',
  'W todo 0',
  'W typecheck fail',
  'W base new',
].join('\n')

describe('readWitnessLines, the compiler report read back', () => {
  it('reads a clean file as complete with no stubs', () => {
    const w = readWitnessLines('specs/a.t27', CLEAN)
    expect(w.present).toBe(true)
    expect(w.parses).toBe(true)
    expect(w.complete).toBe(true)
    expect(w.discardedTokens).toBe(0)
    expect(w.stubMarkers).toBe(0)
    expect(w.typechecks).toBe(true)
    expect(w.baseTypechecks).toBe(true)
  })

  it('reads a DISCARD as parsed but not complete', () => {
    const w = readWitnessLines('specs/a.t27', DISCARD)
    expect(w.parses).toBe(true)
    expect(w.complete).toBe(false)
    expect(w.discardedTokens).toBe(1)
    expect(w.baseTypechecks).toBe(false)
  })

  it('counts stub markers', () => {
    expect(readWitnessLines('specs/a.t27', STUB).stubMarkers).toBe(1)
  })

  it('keeps the first error line of a hard parse failure', () => {
    const w = readWitnessLines('specs/a.t27', NO_PARSE)
    expect(w.parses).toBe(false)
    expect(w.complete).toBe(false)
    expect(w.error).toContain('Parse error')
    expect(w.baseTypechecks).toBeNull()
  })

  it('reads a deleted file as not present', () => {
    expect(readWitnessLines('specs/a.t27', 'W absent').present).toBe(false)
  })

  it('does not read compiler chatter as a measurement', () => {
    // Nothing but noise: no `W ` line at all. An unmeasured file is not clean.
    const w = readWitnessLines('specs/a.t27', 'Node {\n  kind: Module\n}\n')
    expect(w.parses).toBe(false)
    expect(w.complete).toBe(false)
  })
})

describe('witnessVerdicts, the measurement as verdict lines', () => {
  const witnessed = (specs: SpecWitness[]): Witness => ({
    kind: 'witnessed',
    t27c: 't27c 0.2.0',
    specs,
  })

  it('says nothing when the compiler was absent', () => {
    expect(witnessVerdicts({ kind: 'absent', detail: 'no t27c' })).toEqual([])
  })

  it('emits three met lines for a clean file', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', CLEAN)]),
    )
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => l.met)).toBe(true)
    expect(lines[0].criterion).toBe('t27c: specs/a.t27 parses clean')
  })

  it('fails the parse line on a DISCARD and names the count', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', DISCARD)]),
    )
    const parse = lines[0]
    expect(parse.met).toBe(false)
    expect(parse.criterion).toContain('DISCARDED 1 token')
    // The base already failed typecheck: not a regression, so not held
    // against the bee. A ratchet, not a gate.
    expect(lines[2].met).toBe(true)
  })

  it('fails the stub line and names how many', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', STUB)]),
    )
    expect(lines[1].met).toBe(false)
    expect(lines[1].criterion).toContain('(1 found)')
  })

  it('holds a new file that fails typecheck as a regression', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', NO_PARSE)]),
    )
    expect(lines[0].met).toBe(false)
    expect(lines[0].criterion).toContain('Parse error')
    expect(lines[2].met).toBe(false)
    expect(lines[2].criterion).toContain('new file fails typecheck')
  })

  it('skips a deleted file', () => {
    expect(
      witnessVerdicts(witnessed([readWitnessLines('specs/a.t27', 'W absent')])),
    ).toEqual([])
  })
})

describe('the brief names the compiler and the trailer', () => {
  it('tells the bee t27c is installed and that the review runs it', () => {
    const text = briefFor(ISSUE, 'gHashTag/t27', ['specs/x.t27'], 'body', [
      'x parses',
    ])
    expect(text).toContain('t27c parse <file>')
    expect(text).toContain('t27c typecheck <file>')
    expect(text).toContain('The review runs the same commands on your COMMIT')
  })

  it('dictates the exact trailer the traceability gate accepts', () => {
    const text = briefFor(ISSUE, 'gHashTag/t27', ['specs/x.t27'], 'body', [
      'x parses',
    ])
    expect(text).toContain(`\`Closes #${ISSUE}\``)
    expect(text).toContain('"Resolves owner/repo#N" does not')
  })

  it('repeats both in the system prompt', () => {
    const text = workerSystemPrompt(ISSUE, 'gHashTag/t27', '/w/t27', [])
    expect(text).toContain('t27c')
    expect(text).toContain(`Closes #${ISSUE}`)
  })
})

// --- the review, end to end ------------------------------------------------

interface FinishedRow {
  issue: number
  conversation_id: string
  criteria: string[]
  criteria_source: string
  send_backs: number
  owned_paths: string[]
  said: string
}

const CRITERIA = ['specs/x.t27 parses clean', 'no stub markers remain']

const block = (met: boolean): string =>
  [
    '## VERDICT',
    ...CRITERIA.map((c) => `- ${c}: ${met ? 'met' : 'unmet'}`),
  ].join('\n')

function finishedRow(said: string): FinishedRow {
  return {
    issue: ISSUE,
    conversation_id: '00000000-0000-0000-0000-000000000dd6',
    criteria: CRITERIA,
    criteria_source: 'stated',
    send_backs: 0,
    owned_paths: ['specs/x.t27'],
    said,
  }
}

function reviewPool(finished: FinishedRow[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes('FROM queen_dispatch d')) {
        return { rowCount: finished.length, rows: finished }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries }
}

const reviewUpdate = (queries: Array<{ sql: string; params: unknown[] }>) =>
  queries.find(
    (q) =>
      q.sql.includes('UPDATE queen_dispatch') &&
      q.sql.includes('review_state ='),
  )

/** A repository whose `queen-<ISSUE>` branch committed the given files off `main`. */
function repoWithCommit(files: Array<{ path: string; body: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'queen-witness-'))
  const repo = join(root, 'BrowserOS')
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'bee@example.invalid')
  git('config', 'user.name', 'a bee')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-m', 'base')
  git('checkout', '-b', `queen-${ISSUE}`)
  for (const file of files) {
    mkdirSync(dirname(join(repo, file.path)), { recursive: true })
    writeFileSync(join(repo, file.path), file.body)
  }
  git('add', '-A')
  git('commit', '-m', 'work')
  git('checkout', 'main')
  return root
}

const T27C = [process.env.T27C_BIN, '/usr/local/bin/t27c'].find(
  (p): p is string => Boolean(p) && existsSync(p as string),
)
const QUEEND = [
  process.env.TRIOS_QUEEND_PATH,
  join(import.meta.dir, '../../../../queen-core/.build/release/queend'),
  '/usr/local/bin/queend',
].find((p): p is string => Boolean(p) && existsSync(p as string))

const saved: Record<string, string | undefined> = {}
const KEYS = [
  'WORKSPACE_DIR',
  'TRIOS_REPO_REF',
  'TRIOS_REPO_URL',
  'T27C_BIN',
  'TRIOS_QUEEND_PATH',
  'TRIOS_TOOL_SHELL_USER',
]

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.TRIOS_REPO_REF = 'main'
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('the review, without a compiler', () => {
  it('escalates a branch that changed specs and says the compiler is missing', async () => {
    process.env.WORKSPACE_DIR = repoWithCommit([
      { path: 'specs/x.t27', body: 'module M\nfn a() -> i32 { return 1 }\n' },
    ])
    process.env.T27C_BIN = join(tmpdir(), 'no-such-t27c-anywhere')
    const { pool, queries } = reviewPool([finishedRow(block(true))])
    const out = await reviewFinishedDispatches(pool)
    expect(out.acted).toEqual([`#${ISSUE}:escalate`])
    const update = reviewUpdate(queries)
    expect(update?.params[1]).toBe('escalate')
    expect(String(update?.params[2])).toContain('t27c is not available')
    expect(String(update?.params[2])).toContain('1 .t27 file(s)')
  })

  it('reports absent, not clean, from witnessSpecs itself', async () => {
    process.env.WORKSPACE_DIR = repoWithCommit([
      { path: 'specs/x.t27', body: 'module M\n' },
    ])
    process.env.T27C_BIN = join(tmpdir(), 'no-such-t27c-anywhere')
    const w = await witnessSpecs(ISSUE, ['specs/x.t27'])
    expect(w.kind).toBe('absent')
  })

  it('has nothing to witness on a branch that changed no spec', async () => {
    process.env.T27C_BIN = join(tmpdir(), 'no-such-t27c-anywhere')
    const w = await witnessSpecs(ISSUE, ['docs/a.md', 'src/b.ts'])
    expect(w).toEqual({
      kind: 'witnessed',
      t27c: process.env.T27C_BIN,
      specs: [],
    })
  })
})

describe('the review, with the compiler', () => {
  it.if(Boolean(T27C))('measures a clean commit as complete', async () => {
    process.env.WORKSPACE_DIR = repoWithCommit([
      { path: 'specs/x.t27', body: 'module M\nfn a() -> i32 { return 1 }\n' },
    ])
    process.env.T27C_BIN = T27C
    const w = await witnessSpecs(ISSUE, ['specs/x.t27'])
    expect(w.kind).toBe('witnessed')
    if (w.kind !== 'witnessed') return
    expect(w.specs).toHaveLength(1)
    expect(w.specs[0].complete).toBe(true)
    expect(w.specs[0].baseTypechecks).toBeNull()
  })

  it.if(Boolean(T27C))('measures a stray brace as a DISCARD', async () => {
    process.env.WORKSPACE_DIR = repoWithCommit([
      {
        path: 'specs/x.t27',
        body: 'module M\nfn a() -> i32 { return 1 }\n}\n',
      },
    ])
    process.env.T27C_BIN = T27C
    const w = await witnessSpecs(ISSUE, ['specs/x.t27'])
    if (w.kind !== 'witnessed') throw new Error('expected a witness')
    expect(w.specs[0].parses).toBe(true)
    expect(w.specs[0].complete).toBe(false)
    expect(w.specs[0].discardedTokens).toBeGreaterThan(0)
  })

  it.if(Boolean(T27C && QUEEND))(
    'sends back a bee whose "met" the compiler contradicts',
    async () => {
      process.env.WORKSPACE_DIR = repoWithCommit([
        {
          path: 'specs/x.t27',
          body: 'module M\nfn a() -> i32 {\n  // TODO: Implement\n  return 1\n}\n}\n',
        },
      ])
      process.env.T27C_BIN = T27C
      process.env.TRIOS_QUEEND_PATH = QUEEND
      const { pool, queries } = reviewPool([finishedRow(block(true))])
      const out = await reviewFinishedDispatches(pool)
      expect(out.acted).toEqual([`#${ISSUE}:sendBack`])
      const update = reviewUpdate(queries)
      const note = String(update?.params[2])
      expect(note).toContain('parses clean')
      expect(note).toContain('stub markers')
      // Judged and found wanting: this attempt spends the retry ceiling.
      expect(update?.params[4]).toBe(true)
    },
  )

  it.if(Boolean(T27C && QUEEND))(
    'accepts a bee whose "met" the compiler confirms',
    async () => {
      process.env.WORKSPACE_DIR = repoWithCommit([
        { path: 'specs/x.t27', body: 'module M\nfn a() -> i32 { return 1 }\n' },
      ])
      process.env.T27C_BIN = T27C
      process.env.TRIOS_QUEEND_PATH = QUEEND
      const { pool, queries } = reviewPool([finishedRow(block(true))])
      const out = await reviewFinishedDispatches(pool)
      expect(out.acted).toEqual([`#${ISSUE}:accept`])
      expect(reviewUpdate(queries)?.params[1]).toBe('accept')
    },
  )
})
