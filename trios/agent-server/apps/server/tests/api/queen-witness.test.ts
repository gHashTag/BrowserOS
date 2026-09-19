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
  baseRef,
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

  // The order these lines come out in, named once so the cases below index by
  // meaning rather than by a number. A fourth line (empty function bodies) was
  // added to `witnessVerdicts` between the parse and typecheck lines, and the
  // cases here went on reading index 2 as "typecheck" -- one of them went red,
  // and the DISCARD case below went GREEN on a line about empty bodies while
  // its comment talked about the ratchet.
  const PARSE = 0
  const STUB_LINE = 1
  const EMPTY_BODY = 2
  const TYPECHECK = 3

  it('emits four met lines for a clean file', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', CLEAN)]),
    )
    expect(lines).toHaveLength(4)
    expect(lines.every((l) => l.met)).toBe(true)
    expect(lines[PARSE].criterion).toBe('t27c: specs/a.t27 parses clean')
    expect(lines[EMPTY_BODY].criterion).toContain('no empty function body')
    expect(lines[TYPECHECK].criterion).toContain('typecheck does not regress')
  })

  it('fails the parse line on a DISCARD and names the count', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', DISCARD)]),
    )
    const parse = lines[PARSE]
    expect(parse.met).toBe(false)
    expect(parse.criterion).toContain('DISCARDED 1 token')
    // The base already failed typecheck: not a regression, so not held
    // against the bee. A ratchet, not a gate.
    expect(lines[TYPECHECK].met).toBe(true)
    expect(lines[TYPECHECK].criterion).toContain('typecheck does not regress')
  })

  it('fails the stub line and names how many', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', STUB)]),
    )
    expect(lines[STUB_LINE].met).toBe(false)
    expect(lines[STUB_LINE].criterion).toContain('(1 found)')
  })

  it('holds a new file that fails typecheck as a regression', () => {
    const lines = witnessVerdicts(
      witnessed([readWitnessLines('specs/a.t27', NO_PARSE)]),
    )
    expect(lines[PARSE].met).toBe(false)
    expect(lines[PARSE].criterion).toContain('Parse error')
    expect(lines[TYPECHECK].met).toBe(false)
    expect(lines[TYPECHECK].criterion).toContain('new file fails typecheck')
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
  // `baseRef()` qualifies a bare branch name with `origin/`, so a fixture with
  // no remote can never resolve the base and every diff against it fails.
  // Until `committedFiles` learned to say so, that failure arrived as an empty
  // file list -- indistinguishable from a bee that committed nothing.
  git('remote', 'add', 'origin', repo)
  git('checkout', '-b', `queen-${ISSUE}`)
  for (const file of files) {
    mkdirSync(dirname(join(repo, file.path)), { recursive: true })
    writeFileSync(join(repo, file.path), file.body)
  }
  git('add', '-A')
  git('commit', '-m', 'work')
  git('checkout', 'main')
  git('fetch', '-q', 'origin')
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
    const out = await reviewFinishedDispatches(pool, {
      laneCandidates: () => [],
    })
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
      // No reviewer lane: the compiler's refusal needs no adversary, and a
      // suite must never reach a paid model through a key in the environment.
      const out = await reviewFinishedDispatches(pool, {
        laneCandidates: () => [],
      })
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
      // The compiler's yes is not an accept on its own (#1127): with no
      // reviewer lane the commit waits for one, never passing on the bee's
      // word...
      const held = reviewPool([finishedRow(block(true))])
      const waited = await reviewFinishedDispatches(held.pool, {
        laneCandidates: () => [],
      })
      expect(waited.acted).toEqual([`#${ISSUE}:wait`])
      // ...and an adversary that could not refute it, citing the committed
      // spec, accepts it - over the real git, t27c and queend.
      const { pool, queries } = reviewPool([finishedRow(block(true))])
      const out = await reviewFinishedDispatches(pool, {
        laneCandidates: () => [
          {
            provider: 'openai-compatible',
            model: 'reviewer-model',
            baseUrl: 'https://reviewer.example.invalid',
            apiKey: 'not-a-real-key',
            poolNumber: 2,
            laneIndex: 0,
          },
        ],
        llm: async () => ({
          ok: true,
          text: [
            '## VERDICT',
            ...CRITERIA.map(
              (_, i) => `- ${i + 1}. specs/x.t27:2 returns 1 as asked: met`,
            ),
          ].join('\n'),
        }),
      })
      expect(out.acted).toEqual([`#${ISSUE}:accept`])
      expect(reviewUpdate(queries)?.params[1]).toBe('accept')
    },
  )
})

describe('the oracle verdict, which is the only line about code working', () => {
  const witnessed = (specs: SpecWitness[]): Witness => ({
    kind: 'witnessed',
    t27c: 't27c 0.2.0',
    specs,
  })
  const base = [
    'W parse ok',
    'W pc parse and consume all 1',
    'W todo 0',
    'W empty 0',
    'W typecheck ok',
    'W base ok',
  ]
  const lines = (extra: string[]) =>
    witnessVerdicts(
      witnessed([
        readWitnessLines('specs/a.t27', [...base, ...extra].join('\n')),
      ]),
    )

  it('says nothing at all when zig never ran', () => {
    // An unmeasured file must not read as a passing one. This is the state on
    // any image without zig, and the reason the field is `boolean | null`
    // rather than a boolean defaulting to false.
    const w = readWitnessLines('specs/a.t27', base.join('\n'))
    expect(w.oracle).toBeNull()
    expect(lines([]).some((l) => l.criterion.startsWith('zig:'))).toBe(false)
  })

  it('records a met line when the generated Zig compiles and its tests pass', () => {
    const l = lines(['W oracle pass']).find((x) =>
      x.criterion.startsWith('zig:'),
    )
    expect(l).toBeDefined()
    expect(l?.met).toBe(true)
  })

  it('holds a regression against the bee, naming the file the error is in', () => {
    const l = lines([
      'W oracle fail [a.zig] @intCast must have a known result type',
    ]).find((x) => x.criterion.startsWith('zig:'))
    expect(l?.met).toBe(false)
    expect(l?.criterion).toContain('[a.zig]')
  })

  it('stays silent when the base was already broken', () => {
    // 384 of 946 specs did not compile on 2026-09-16. Failing a bee for
    // landing on one of those stops the queue instead of improving it, which
    // is the exact failure this loop exists to prevent -- so the line is
    // omitted rather than emitted unmet.
    const w = readWitnessLines(
      'specs/a.t27',
      [...base, 'W oracle pre-broken [b.zig] some inherited error'].join('\n'),
    )
    expect(w.oracle).toBe(false)
    expect(w.oraclePreBroken).toBe(true)
    expect(
      lines(['W oracle pre-broken [b.zig] some inherited error']).some((l) =>
        l.criterion.startsWith('zig:'),
      ),
    ).toBe(false)
  })
})

describe('baseRef, the ref a review compares against', () => {
  const saved = process.env.TRIOS_REPO_REF
  afterEach(() => {
    if (saved === undefined) delete process.env.TRIOS_REPO_REF
    else process.env.TRIOS_REPO_REF = saved
  })

  it('qualifies a bare branch name', () => {
    // Production sets `master`. Read raw, that is the container's LOCAL master:
    // checked out once, never moved, and ~100 commits behind by the time a
    // review used it. Every bee was then judged against a base that had drifted.
    process.env.TRIOS_REPO_REF = 'master'
    expect(baseRef()).toBe('origin/master')
  })

  it('leaves an already-qualified ref alone', () => {
    // The old default was `origin/dev`, and the export route prefixed
    // `origin/` unconditionally. Setting the variable to `origin/master` to
    // work around that produced `origin/origin/master` and broke publishing.
    process.env.TRIOS_REPO_REF = 'origin/master'
    expect(baseRef()).toBe('origin/master')
  })

  it('falls back to the historical default', () => {
    delete process.env.TRIOS_REPO_REF
    expect(baseRef()).toBe('origin/dev')
  })
})
