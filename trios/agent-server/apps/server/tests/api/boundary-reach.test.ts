import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
// The audit tool is the CANONICAL home of the documentation rule. The rule
// in queen-tick.ts is a pinned twin (the agent-server image carries no
// repository-root file to import), and this file is what makes the pinning
// real: it imports the canonical export and fails unless the twin agrees.
import {
  boundaryPathsOf as auditBoundaryPathsOf,
  boundaryReachesSource as auditBoundaryReachesSource,
  DOC_FILE_SUFFIXES,
} from '../../../../../tools/doc-only-boundary-audit.mjs'
import {
  boundaryPathsOf,
  boundaryReachesSource,
  rememberIssues,
} from '../../src/api/services/queen-tick'

/** The four boundary shapes #1358 names, plus the collapsed fifth. */
const DOC_ONLY_BODY = [
  '# A document is the deliverable',
  '',
  'Prose, then a boundary of one markdown file.',
  '',
  '## Boundary',
  '',
  'docs/queen-queue-depth.md',
  '',
  '## Out of scope',
  '',
  'Anything behavioural.',
].join('\n')

const MIXED_BODY = [
  '# A document AND the change it describes',
  '',
  '## Boundary',
  '',
  'docs/queen-queue-depth.md',
  'agent-server/apps/server/src/api/services/queen-tick.ts',
].join('\n')

const SOURCE_ONLY_BODY = [
  '# Behaviour only',
  '',
  '## Boundary',
  '',
  'agent-server/apps/server/src/api/services/queen-tick.ts',
].join('\n')

const NO_SECTION_BODY = [
  '# No boundary anywhere',
  '',
  'The issue never said.',
].join('\n')

const EMPTY_SECTION_BODY = [
  '# A section with nothing in it',
  '',
  '## Boundary',
  '',
  'Nothing yet.',
].join('\n')

/** Records every statement with the parameters it was given. */
function recordingPool() {
  const calls: Array<{ text: string; params: unknown[] }> = []
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text: String(text), params: params ?? [] })
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, calls }
}

/**
 * What rememberIssues stored for one issue, by column position:
 * [4] is delegatable and [5] is boundary_reaches_source.
 */
async function storedFor(
  body: string,
  verdicts?: Parameters<typeof rememberIssues>[3],
): Promise<{ owned: string[]; delegatable: boolean; reachesSource: boolean }> {
  const { pool, calls } = recordingPool()
  await rememberIssues(
    pool,
    [{ number: 4242, title: 't', body }],
    true,
    verdicts,
  )
  const insert = calls.find((c) => c.text.includes('INSERT INTO queen_issues'))
  if (!insert)
    throw new Error('rememberIssues issued no INSERT INTO queen_issues')
  return {
    owned: JSON.parse(String(insert.params[2])),
    delegatable: Boolean(insert.params[4]),
    reachesSource: Boolean(insert.params[5]),
  }
}

describe('boundary_reaches_source, the four shapes (#1358)', () => {
  it('stores false for a documentation-only boundary', async () => {
    const stored = await storedFor(DOC_ONLY_BODY)
    expect(stored.owned).toEqual(['docs/queen-queue-depth.md'])
    expect(stored.reachesSource).toBe(false)
  })

  it('stores true for a mixed boundary - one real path is enough', async () => {
    const stored = await storedFor(MIXED_BODY)
    expect(stored.owned).toEqual([
      'docs/queen-queue-depth.md',
      'agent-server/apps/server/src/api/services/queen-tick.ts',
    ])
    expect(stored.reachesSource).toBe(true)
  })

  it('stores true for a source-only boundary', async () => {
    const stored = await storedFor(SOURCE_ONLY_BODY)
    expect(stored.owned).toEqual([
      'agent-server/apps/server/src/api/services/queen-tick.ts',
    ])
    expect(stored.reachesSource).toBe(true)
  })

  it('stores false for an empty boundary, which is "no boundary", not doc-only', async () => {
    const stored = await storedFor(NO_SECTION_BODY)
    expect(stored.owned).toEqual([])
    expect(stored.reachesSource).toBe(false)
  })

  it('treats an empty ## Boundary section the same as no section', async () => {
    // Both collapse to [], by the documented rule in boundaryPathsOf; the
    // audit reports them separately from doc-only for the same reason.
    expect(boundaryPathsOf(EMPTY_SECTION_BODY)).toEqual([])
    const stored = await storedFor(EMPTY_SECTION_BODY)
    expect(stored.reachesSource).toBe(false)
  })

  it('writes the column in both the INSERT and the upsert', async () => {
    const { pool, calls } = recordingPool()
    await rememberIssues(
      pool,
      [{ number: 4242, title: 't', body: DOC_ONLY_BODY }],
      true,
    )
    const insert = calls.find((c) =>
      c.text.includes('INSERT INTO queen_issues'),
    )
    expect(insert?.text).toContain('boundary_reaches_source')
    expect(insert?.text).toContain(
      'boundary_reaches_source = EXCLUDED.boundary_reaches_source',
    )
  })
})

describe('delegatable is unchanged by the new value (FR-001 of #1358)', () => {
  /**
   * This is the tripwire. A documentation-only boundary has length 1, so
   * `v?.delegatable ?? boundary.length > 0` stores true today, and MUST go
   * on storing true: narrowing it would silently stop the Queen picking up
   * prose-only work, which is the operator's decision to make, not this
   * change's. Wire `boundaryReachesSource` into delegatable and this test
   * fails.
   */
  it('keeps a documentation-only issue delegatable', async () => {
    const stored = await storedFor(DOC_ONLY_BODY)
    expect(stored.delegatable).toBe(true)
    expect(stored.reachesSource).toBe(false)
  })

  it('keeps the other three shapes exactly as they were', async () => {
    expect((await storedFor(MIXED_BODY)).delegatable).toBe(true)
    expect((await storedFor(SOURCE_ONLY_BODY)).delegatable).toBe(true)
    expect((await storedFor(NO_SECTION_BODY)).delegatable).toBe(false)
  })

  it('still lets the policy verdict override the boundary, in both directions', async () => {
    const allow = {
      '4242': { delegatable: true, isSpec: false, missing: [], remedy: '' },
    }
    const refuse = {
      '4242': { delegatable: false, isSpec: false, missing: [], remedy: '' },
    }
    expect((await storedFor(NO_SECTION_BODY, allow)).delegatable).toBe(true)
    expect((await storedFor(SOURCE_ONLY_BODY, refuse)).delegatable).toBe(false)
    // The recorded value is a fact about the boundary, not a policy verdict,
    // so the verdict does not move it.
    expect((await storedFor(SOURCE_ONLY_BODY, refuse)).reachesSource).toBe(true)
  })
})

describe("the rule is the audit's rule, not a second opinion (FR-002 of #1358)", () => {
  /** Boundaries where the two implementations must agree, with the answer
   * stated outright so a change to EITHER copy fails this test. */
  const cases: Array<{ paths: string[]; reaches: boolean; why: string }> = [
    {
      paths: [],
      reaches: false,
      why: 'no boundary is neither doc-only nor reaching',
    },
    {
      paths: ['docs/queen-queue-depth.md'],
      reaches: false,
      why: 'one .md file, the shape of #1333',
    },
    {
      paths: ['trios/docs/t27/T27-04-salience-purity.md'],
      reaches: false,
      why: 'the shape of #1351, repository-relative',
    },
    {
      paths: ['docs/a.md', 'README.MD', 'notes.Md'],
      reaches: false,
      why: 'case-insensitive suffix',
    },
    {
      paths: ['docs/a.md', 'src/x.ts'],
      reaches: true,
      why: 'mixed: one real path is enough',
    },
    {
      paths: ['agent-server/apps/server/src/api/services/queen-tick.ts'],
      reaches: true,
      why: 'source only',
    },
    {
      paths: ['tools/audit.mjs'],
      reaches: true,
      why: 'an .mjs is not documentation',
    },
    {
      paths: ['notes.markdown'],
      reaches: true,
      why: 'only .md counts, not .markdown',
    },
    {
      paths: ['docs/diagram.png'],
      reaches: true,
      why: 'a docs/ directory does not sanctify a png',
    },
    { paths: ['docs/'], reaches: true, why: 'a directory is not a .md file' },
    {
      paths: ['a.md.ts'],
      reaches: true,
      why: 'the suffix must be at the end of the file name',
    },
  ]

  it('agrees with the audit export on every case, and each answer is stated', () => {
    for (const { paths, reaches, why } of cases) {
      expect(boundaryReachesSource(paths)).toBe(reaches)
      expect(auditBoundaryReachesSource(paths)).toBe(reaches)
      // The twin and the canonical export must never disagree - stated
      // twice so a failure names the case.
      expect(boundaryReachesSource(paths)).toBe(
        auditBoundaryReachesSource(paths),
      )
      expect(why).toBe(why)
    }
  })

  it('pins the documentation suffixes as exactly .md', () => {
    expect(DOC_FILE_SUFFIXES).toEqual(['.md'])
  })

  /** Bodies run through BOTH parsers; each expected array is stated so a
   * change to either parser fails here rather than in production. */
  const parsedCases: Array<{ body: string; paths: string[] }> = [
    { body: DOC_ONLY_BODY, paths: ['docs/queen-queue-depth.md'] },
    {
      body: MIXED_BODY,
      paths: [
        'docs/queen-queue-depth.md',
        'agent-server/apps/server/src/api/services/queen-tick.ts',
      ],
    },
    {
      body: SOURCE_ONLY_BODY,
      paths: ['agent-server/apps/server/src/api/services/queen-tick.ts'],
    },
    { body: NO_SECTION_BODY, paths: [] },
    // One path per line: two paths sharing a line yield the first. Both
    // parsers must keep doing this, so it is pinned rather than implied.
    {
      body: '## Boundary\n\n`docs/x.md`, and `tools/y.mjs`.',
      paths: ['docs/x.md'],
    },
    {
      body: '## Boundary\n\ndocs/x.md\n\ntools/y.mjs',
      paths: ['docs/x.md', 'tools/y.mjs'],
    },
    { body: '## Границы\n\ndocs/x.md', paths: ['docs/x.md'] },
    {
      body: '## Boundary\n\nsee docs/old.md below.\n\n## Later\n\ndocs/other.md',
      paths: ['docs/old.md'],
    },
  ]

  it('parses every body the same way the audit parses it', () => {
    for (const { body, paths } of parsedCases) {
      expect(boundaryPathsOf(body)).toEqual(paths)
      expect(auditBoundaryPathsOf(body)).toEqual(paths)
    }
  })
})
