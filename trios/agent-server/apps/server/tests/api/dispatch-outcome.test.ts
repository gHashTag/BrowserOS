import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  DISPATCH_OUTCOME_LABELS,
  DISPATCH_OUTCOME_MAX_LENGTH,
  drain,
  finishDispatch,
  recordDispatch,
} from '../../src/api/services/queen-dispatch'
import { logger } from '../../src/lib/logger'

/**
 * #1360. The `outcome` column of `queen_dispatch` is a short label that the
 * board groups by and the status page prints. Three production rows (1331,
 * 1330, 1326) held `provider refused: ` followed by an entire serialized
 * tool-output event - a git log dump that had nothing to do with why the
 * turn stopped. Two defects stacked: a guessed cause standing in for a
 * measured one, and an unbounded blob standing in for a label.
 *
 * This suite pins the fix at each write site: the label set is enumerated in
 * one exported place, every stored outcome is bounded by a named cap, the
 * payload that produced an ending moves to `detail` or to the transcript
 * instead of vanishing, and a cause nobody measured is recorded as
 * undetermined rather than named.
 */

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

/** A stream of SSE frames, the shape /chat answers with. */
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

/** A stream that breaks mid-turn, the way a dropped connection does. */
const brokenStream = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error(message))
      },
    }),
  )

describe('the outcome vocabulary (#1360)', () => {
  it('is exported as DISPATCH_OUTCOME_LABELS, enumerated in one place', () => {
    const labels = Object.values(DISPATCH_OUTCOME_LABELS)
    expect(labels.length).toBeGreaterThan(0)
    // The single word the column has always carried for a healthy turn.
    expect(DISPATCH_OUTCOME_LABELS.finished).toBe('finished')
    // One set, not several that can drift: no label appears twice.
    expect(new Set(labels).size).toBe(labels.length)
  })

  // FR-002 and story 1 scenario 2: the cap is a named constant, and every
  // label in the set fits under it. A label that overran its own cap would
  // make the audit flag rows the writer believed were clean.
  it('keeps every label at or under the named cap', () => {
    expect(DISPATCH_OUTCOME_MAX_LENGTH).toBeGreaterThan(0)
    for (const label of Object.values(DISPATCH_OUTCOME_LABELS)) {
      expect(label.length).toBeLessThanOrEqual(DISPATCH_OUTCOME_MAX_LENGTH)
      // A label is words, never a serialized anything.
      expect(label.startsWith('{')).toBe(false)
      expect(label.startsWith('[')).toBe(false)
    }
  })

  // FR-001 and story 1 scenario 4: the set carries a value that MEANS the
  // cause was not determined. The three production rows were labelled with a
  // cause nobody measured; the replacement label has to admit the gap in its
  // own words rather than swap one guess for another.
  it('includes a label that admits an undetermined cause', () => {
    const undetermined = DISPATCH_OUTCOME_LABELS.endedUnexpectedly
    expect(undetermined).toBe('ended unexpectedly (cause undetermined)')
    expect(undetermined).not.toContain('provider')
    expect(undetermined).not.toContain('refused')
  })
})

describe('recording a bounded outcome', () => {
  it('stores the single-word label for a normal finish', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'text-delta', delta: 'working' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
        { type: 'finish', finishReason: 'stop' },
      ]),
      'conv-1360',
      1360,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing.length).toBe(1)
    expect(closing[0].params[1]).toBe('finished')
    expect(String(closing[0].params[1]).length).toBeLessThanOrEqual(
      DISPATCH_OUTCOME_MAX_LENGTH,
    )
  })

  // Story 1 scenario 1 and FR-004: the recording path for a dispatch that
  // never started used to copy the refusal detail verbatim into `outcome` -
  // and a detail can be an entire error body, because an exception message
  // has no length limit of its own. Twenty thousand characters go in; a
  // one-word label comes out; the payload itself is not discarded, it lives
  // in the `detail` column, which is where a reader looks for the reason.
  it('never lets a 20,000-character payload reach the outcome column, and keeps it in detail', async () => {
    const { pool, asked } = recordingPool()
    const payload = 'x'.repeat(20_000)
    await recordDispatch(pool, 1360, 'queen-1360', false, payload, [])
    const upsert = touching(asked, 'ON CONFLICT (issue)')[0]
    expect(upsert).toBeDefined()
    // The outcome is a label from the set, bounded by the named cap.
    const outcome = upsert.params[11]
    expect(outcome).toBe(DISPATCH_OUTCOME_LABELS.refused)
    expect(String(outcome).length).toBeLessThanOrEqual(
      DISPATCH_OUTCOME_MAX_LENGTH,
    )
    // The payload survived, whole, in the detail field.
    expect(upsert.params[3]).toBe(payload)
    expect(String(upsert.params[3]).length).toBe(20_000)
    // And the column is no longer fed from the detail parameter at all.
    expect(upsert.sql).not.toContain('ELSE $4 END')
    expect(upsert.sql).toContain('ELSE $12 END')
  })

  // A dispatch that starts has no ending yet: `outcome` stays NULL while the
  // turn runs, exactly as before.
  it('leaves the outcome NULL for a dispatch that started', async () => {
    const { pool, asked } = recordingPool()
    await recordDispatch(pool, 1360, 'queen-1360', true, 'cut from dev', [])
    const upsert = touching(asked, 'ON CONFLICT (issue)')[0]
    expect(upsert.params[11]).toBeNull()
  })

  // Story 1 scenario 2, on the stream path: a transport failure can carry a
  // huge message. The label stays closed; the words go to the two places a
  // reader already looks - the transcript (bounded by that table's own
  // 8000-character column) and the server log, which is unbounded.
  it('keeps an over-length stream error out of the outcome and moves the words', async () => {
    const { pool, asked } = recordingPool()
    const warns: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const original = logger.warn.bind(logger)
    logger.warn = (message: string, meta?: Record<string, unknown>) => {
      warns.push({ message, meta })
    }
    try {
      await drain(pool, brokenStream('y'.repeat(20_000)), 'conv-1360', 1360)
    } finally {
      logger.warn = original
    }
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(closing.params[1]).toBe(DISPATCH_OUTCOME_LABELS.streamEndedBadly)
    expect(String(closing.params[1]).length).toBeLessThanOrEqual(
      DISPATCH_OUTCOME_MAX_LENGTH,
    )
    // The transcript row keeps the head of the payload...
    const errorNote = touching(asked, 'queen_transcript').find(
      (q) => q.params[3] === 'error',
    )
    expect(errorNote).toBeDefined()
    expect(
      String(errorNote?.params[4]).startsWith('stream ended badly: '),
    ).toBe(true)
    expect(String(errorNote?.params[4]).length).toBe(8_000)
    // ...and the log line keeps all of it.
    const said = warns.find((w) => w.message.includes('stream ended badly'))
    expect(said).toBeDefined()
    expect(String(said?.meta?.error).length).toBe(
      'stream ended badly: '.length + 20_000,
    )
  })

  // Story 1 scenario 4, the measured case behind the three rows: a tool
  // event arrived where a completion was expected and the stream closed
  // without ever saying why. The ending is labelled cause-undetermined. It
  // is NOT labelled `provider refused` - that names a cause nothing in the
  // stream measured - and the event that ended the turn is not discarded: it
  // is already a row in the transcript, where every frame Scribe reads goes.
  it('labels an undetermined cause as undetermined, not as a named cause', async () => {
    const { pool, asked } = recordingPool()
    const gitLogDump =
      '01e16a13 Merge pull request #99 from gHashTag/feat/queen-hardware-registry\n' +
      '303d5e70 fix(queen): derive the registry signing key\n' +
      'a2595957 feat(queen): add signed FPGA registry'
    await drain(
      pool,
      sse([
        {
          type: 'tool-output-available',
          toolCallId: 'call_42993ec65988444a98b7932d',
          output: { text: gitLogDump },
        },
        // ...and nothing else. No completion frame ever arrives.
      ]),
      'conv-1360',
      1360,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(closing.params[1]).toBe(DISPATCH_OUTCOME_LABELS.endedUnexpectedly)
    expect(String(closing.params[1])).not.toContain('provider')
    expect(String(closing.params[1])).not.toContain('refused')
    // The payload moved to the feed rather than vanishing: the tool output
    // is a transcript row, and the ending itself is said out loud there too.
    const rows = touching(asked, 'queen_transcript')
    expect(
      rows.some(
        (r) =>
          r.params[3] === 'result' &&
          String(r.params[4]).includes('Merge pull request #99'),
      ),
    ).toBe(true)
    expect(
      rows.some(
        (r) =>
          r.params[3] === 'error' &&
          String(r.params[4]).includes('without a completion frame'),
      ),
    ).toBe(true)
  })

  // The guard against over-labelling: a completion frame is what separates a
  // turn that ended from a stream that merely stopped. With one present, a
  // tool event as the last payload is an ordinary finish.
  it('keeps the finished label when the turn did complete', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        {
          type: 'tool-output-available',
          toolCallId: 'call_1',
          output: { text: 'done' },
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
      'conv-1360',
      1360,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(closing.params[1]).toBe('finished')
  })

  // #1301 must survive #1360: a measured Z.ai quota code is a real cause and
  // keeps its closed classification, which still fits under the cap.
  it('keeps the quota classification, bounded by the cap', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        {
          type: 'error',
          errorText: '[1308] Usage limit reached for 5 prompts.',
        },
        { type: 'finish', finishReason: 'error' },
      ]),
      'conv-1360',
      1360,
      'zai',
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(closing.params[1]).toBe(
      `${DISPATCH_OUTCOME_LABELS.providerQuotaExhausted} (zai code 1308)`,
    )
    expect(String(closing.params[1]).length).toBeLessThanOrEqual(
      DISPATCH_OUTCOME_MAX_LENGTH,
    )
  })

  // The backstop at the write boundary: a future caller that smuggles a
  // payload through this path still cannot put more than the cap into the
  // column. The slice is the named constant, not a literal at the call site.
  it('bounds whatever finishDispatch is handed by the named cap', async () => {
    const { pool, asked } = recordingPool()
    await finishDispatch(pool, 1360, 'z'.repeat(20_000))
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(String(closing.params[1]).length).toBe(DISPATCH_OUTCOME_MAX_LENGTH)
  })
})

/**
 * FR-006: the audit reads rows from a JSON file the caller supplies, because
 * the worker container has no database credential and a silent connection
 * failure would report the table as clean. It opens no connection at all; it
 * reports, it never rewrites (FR-003).
 */

/** Where the audit tool lives, found by walking up from this test file. */
const auditTool = (() => {
  let dir = import.meta.dir
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'tools/outcome-shape-audit.mjs')
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  throw new Error('tools/outcome-shape-audit.mjs not found above this test')
})()

/**
 * The three production rows, verbatim as quoted in the issue (the quote was
 * truncated by the reader, so each outcome continues with the git-log lines
 * that follow the truncation point and closes the JSON the way the original
 * event must have closed).
 */
function historicalRows() {
  const logTail = [
    'a2595957 feat(queen): add signed FPGA registry',
    '942647e9 Merge pull request #98 from gHashTag/queen-1306',
    '87f4fd32 Merge pull request #106 from gHashTag/fix/queen-review-torn-verdict',
    'cb8b146b fix(queen): a verdict split across two transcript rows was read as no verdict',
    '441b46e5 Merge pull request #105 from gHashTag/fix/queen-public-cors-and-key',
  ].join('\\n')
  const blob = (toolCallId: string, head: string) =>
    `provider refused: {"type":"tool-output-available","toolCallId":"${toolCallId}","output":{"text":"${head}\\n${logTail}\\n"}}`
  return [
    {
      issue: 1331,
      branch: 'queen-1331',
      outcome: blob(
        'call_42993ec65988444a98b7932d',
        'exit: 2\\n01e16a13 Merge pull request #99 from gHashTag/feat/queen-hardware-registry\\n303d5e70 fix(queen): derive the registry signing key',
      ),
    },
    {
      issue: 1330,
      branch: 'queen-1330',
      outcome: blob(
        'call_bc76a39b03e249c4a11df541',
        '01e16a13 Merge pull request #99 from gHashTag/feat/queen-hardware-registry\\n303d5e70 fix(queen): derive the registry signing key',
      ),
    },
    {
      issue: 1326,
      branch: 'queen-1326',
      outcome: blob(
        'call_1252c3bdb8b14229badb207e',
        '01e16a13 Merge pull request #99 from gHashTag/feat/queen-hardware-registry\\n303d5e70 fix(queen): derive the registry signing key',
      ),
    },
  ]
}

/** Run the audit as the issue specifies: node <tool> <rows.json>. */
function runAudit(rows: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-audit-'))
  const file = join(dir, 'rows.json')
  writeFileSync(file, JSON.stringify(rows, null, 2))
  const before = readFileSync(file, 'utf8')
  const run = Bun.spawnSync(['node', auditTool, file])
  return {
    file,
    before,
    after: readFileSync(file, 'utf8'),
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  }
}

describe('the outcome-shape audit (#1360)', () => {
  // Story 1 scenario 3: the three historical rows are reported as malformed,
  // each with the label it should have carried, and a total is printed. The
  // honest label for all three is the undetermined one - nothing in the
  // stored blob measured why the turn stopped.
  it('reports all three quoted rows and the label they should have carried', () => {
    const run = runAudit(historicalRows())
    expect(run.stdout).toContain('issue 1331')
    expect(run.stdout).toContain('issue 1330')
    expect(run.stdout).toContain('issue 1326')
    // All three are over the cap; the reader's truncation never shortened
    // them below it.
    expect(run.stdout).toContain('over cap')
    expect(run.stdout).toContain(
      `"${DISPATCH_OUTCOME_LABELS.endedUnexpectedly}"`,
    )
    expect(run.stdout).toContain('total: 3 malformed of 3 rows read')
    // Finding malformed rows is a failure worth gating on.
    expect(run.exitCode).toBe(1)
  })

  it('reports a clean table as clean', () => {
    const run = runAudit([
      { issue: 1, outcome: 'finished' },
      { issue: 2, outcome: DISPATCH_OUTCOME_LABELS.refused },
      {
        issue: 3,
        outcome: `${DISPATCH_OUTCOME_LABELS.providerQuotaExhausted} (zai code 1308)`,
      },
      { issue: 4, outcome: null },
    ])
    expect(run.stdout).toContain('total: 0 malformed of 4 rows read')
    expect(run.exitCode).toBe(0)
  })

  // A short string that parses as JSON is a payload wearing a label's
  // length, and the audit catches it on shape alone.
  it('flags an outcome that parses as JSON even under the cap', () => {
    const run = runAudit([{ issue: 7, outcome: '{"type":"finish"}' }])
    expect(run.stdout).toContain('issue 7')
    expect(run.stdout).toContain('parses as JSON')
    expect(run.exitCode).toBe(1)
  })

  // FR-003: history is not edited to make a report clean. The audit reads
  // the file and leaves it byte-identical.
  it('does not rewrite the rows it audits', () => {
    const run = runAudit(historicalRows())
    expect(run.after).toBe(run.before)
  })
})
