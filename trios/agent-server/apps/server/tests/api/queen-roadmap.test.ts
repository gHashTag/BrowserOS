/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The first suite for src/api/routes/queen-roadmap.ts (trios#1415).
 *
 * The module exports two symbols and, until this file, no test anywhere named
 * either of them. This is not a rewrite and the subject is not touched: the
 * behaviour that already exists is pinned, so the next change to the file has
 * something to fail against.
 *
 * EXPORTS THIS SUITE COULD NOT PIN: none (0 of 2). Both exports are exercised
 * below. The module's one live dependency is Postgres - the data route reads
 * queen_issues through a pg Pool - and rather than let that block anything, pg
 * is stood in for by a fake that answers what Postgres would, the same stand-in
 * convention as tests/api/routes/queen-lease.test.ts. Nothing here opens a
 * socket, needs a container, or leaves the process.
 *
 * The roadmap index is real file IO, not mocked: loadRoadmap() reads
 * `$WORKSPACE_DIR/BrowserOS/trios/.trinity/dashboard/roadmap.json` and falls
 * back to `$(cwd)/../.trinity/dashboard/roadmap.json`. Both candidate paths are
 * aimed into one temp tree this suite owns, so a hit or a miss is decided by
 * what a test planted there - never by whichever checkout happens to be
 * running the suite, and the checkout this suite was born in really does carry
 * an index at the default location.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// pg, stood in for.
// ---------------------------------------------------------------------------

/**
 * The real module, snapshotted before the mock and put back by hand in afterAll.
 *
 * Two bun 1.3 facts shape this, both learned the hard way: `mock.restore()` does
 * NOT undo `mock.module`, and `import('pg')` hands back a LIVE namespace that
 * the mock overwrites in place - so restoring "from the namespace" would
 * reinstall the mock onto itself, leaving every later file in the run (the
 * queen-lease route tests construct real pools) holding a fake. A plain-object
 * copy taken before the mock survives, and re-installing it puts the real
 * BoundPool back for whoever runs next.
 */
const realPg = { ...(await import('pg')) } as typeof import('pg')

/** One row of queen_issues, with only the columns the route reads. */
interface BoardRow {
  number: number
  title: string
  is_spec: boolean
  delegatable: boolean
  missing: string[] | null
}

/** Every pool the route has constructed, in order. */
const pools: FakePool[] = []

/** The rows the fake queen_issues table is holding for the current test. */
let table: BoardRow[] = []

class FakePool {
  ended = false
  constructor() {
    pools.push(this)
  }
  async query() {
    return { rowCount: table.length, rows: table }
  }
  async end() {
    this.ended = true
  }
}

mock.module('pg', () => ({ ...realPg, Pool: FakePool }))

const { createQueenRoadmapDataRoute, createQueenRoadmapRoute } = await import(
  '../../src/api/routes/queen-roadmap'
)

// ---------------------------------------------------------------------------
// A workspace the suite owns end to end.
// ---------------------------------------------------------------------------

const saved = {
  workspace: process.env.WORKSPACE_DIR,
  database: process.env.DATABASE_URL,
  ssot: process.env.RAILWAY_SSOT_URL,
  cwd: process.cwd(),
}

// `workspace` is WORKSPACE_DIR for the request; `home`, inside it, is the cwd,
// so the handler's fallback `${cwd}/../.trinity/...` also resolves into
// `workspace`. One tree decides both candidate paths, and it holds exactly
// what a test put there.
const workspace = mkdtempSync(join(tmpdir(), 'queen-roadmap-suite-'))
const home = mkdtempSync(join(workspace, 'cwd-'))
process.chdir(home)

const INDEX_PATH = join(
  workspace,
  'BrowserOS',
  'trios',
  '.trinity',
  'dashboard',
  'roadmap.json',
)

/** The index the route is supposed to serve back verbatim. */
const ROADMAP_INDEX = {
  source: {
    file: 'Queen_T27_MVP_Architecture.md',
    bytes: 91776,
    inGit: false,
    note: 'The file is the author; this is only the index.',
  },
  epics: [
    {
      id: 'E0',
      title: 'Evidence baseline and repository truth',
      issues: [
        { id: 'E0-I1', title: 'Record canonical repository snapshot' },
        { id: 'E0-I2', title: 'Reproduce documented T27 quick start' },
      ],
    },
    {
      id: 'E1',
      title: 'Language contract and source AST',
      issues: [{ id: 'E1-I1', title: 'Publish T27 language version policy' }],
    },
  ],
  milestones: [
    { id: 'M1', title: 'Core loop', gate: 'Every round leaves a verdict' },
    { id: 'M2', title: 'Swarm', gate: 'Three bees, one boundary each' },
  ],
  dod: {
    open: ['Definition of done item A', 'Definition of done item B'],
    done: ['Definition of done item C'],
    total: 3,
  },
}

function plantRoadmapIndex() {
  mkdirSync(dirname(INDEX_PATH), { recursive: true })
  writeFileSync(INDEX_PATH, JSON.stringify(ROADMAP_INDEX))
}

/** Parseable, and refuses instantly if it were ever dialled. With pg mocked it
 * never is; the port is a seatbelt, not the mechanism. */
const UNREACHABLE = 'postgres://queen:none@127.0.0.1:1/queen'

const row = (number: number, over: Partial<BoardRow> = {}): BoardRow => ({
  number,
  title: `issue #${number}`,
  is_spec: false,
  delegatable: false,
  missing: [],
  ...over,
})

/** The board half of the data route's answer. */
interface BoardFacts {
  open: number
  specs: number
  delegatable: number
  missingTally: Record<string, number>
  worst: BoardRow[]
}

interface DataBody {
  roadmap: typeof ROADMAP_INDEX | null
  board: BoardFacts
}

/** Point the process at a database and ask the data route for its answer. */
async function askData() {
  process.env.DATABASE_URL = UNREACHABLE
  const response = await createQueenRoadmapDataRoute().request('/')
  return { response, body: (await response.json()) as DataBody }
}

afterAll(() => {
  if (saved.workspace === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = saved.workspace
  if (saved.database === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = saved.database
  if (saved.ssot === undefined) delete process.env.RAILWAY_SSOT_URL
  else process.env.RAILWAY_SSOT_URL = saved.ssot
  process.chdir(saved.cwd)
  rmSync(workspace, { recursive: true, force: true })
  mock.module('pg', () => ({ ...realPg }))
})

describe('queenRoadmapContract', () => {
  beforeEach(() => {
    table = []
    pools.length = 0
    process.env.WORKSPACE_DIR = workspace
    delete process.env.DATABASE_URL
    delete process.env.RAILWAY_SSOT_URL
    // A previous test may have planted an index; each test decides its own.
    rmSync(INDEX_PATH, { force: true })
  })

  describe('createQueenRoadmapDataRoute - the numbers at /queen/roadmap/data', () => {
    it('refuses with 503 and a plain sentence when no database is configured', async () => {
      const response = await createQueenRoadmapDataRoute().request('/')
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'No database configured' })
    })

    it('derives the board counts from the issues the table holds', async () => {
      // The spec carries FOUR missing items - more than any non-spec - so a
      // worst-list that forgot to exclude specs is caught, not accommodated.
      // The bare row carries missing: NULL, as Postgres renders an absent
      // array, and must count in `open` without breaking the tally.
      const spec = row(1, {
        is_spec: true,
        delegatable: true,
        missing: ['specification', 'boundary', 'repro', 'review'],
      })
      const partial = row(2, { missing: ['acceptance criteria', 'boundary'] })
      const worse = row(3, {
        missing: ['boundary', 'acceptance criteria', 'repro'],
      })
      const bare = row(4, { missing: null })
      table = [spec, partial, worse, bare]

      const { response, body } = await askData()
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')

      expect(body.board.open).toBe(4)
      expect(body.board.specs).toBe(1)
      expect(body.board.delegatable).toBe(1)
      // Every row is tallied, the spec's four included: the panel is about the
      // whole board's gaps, not the backlog's.
      expect(body.board.missingTally).toEqual({
        specification: 1,
        boundary: 3,
        repro: 2,
        review: 1,
        'acceptance criteria': 2,
      })
      // Worst first, the NULL-missing row last, the spec nowhere - and the
      // rows arrive whole, because the page links by number and shows title.
      expect(body.board.worst).toEqual([worse, partial, bare])
    })

    it('keeps only the twelve furthest from a spec in the worst table', async () => {
      // Fifteen non-spec issues, least-missing first in insertion order, so
      // passing needs the sort and the cap, not luck of arrangement.
      table = Array.from({ length: 15 }, (_, i) =>
        row(100 + i, {
          missing: Array.from({ length: i + 1 }, (_, k) => `gap ${k + 1}`),
        }),
      )
      const { body } = await askData()
      expect(body.board.worst).toHaveLength(12)
      expect(body.board.worst.map((r) => r.number)).toEqual([
        114, 113, 112, 111, 110, 109, 108, 107, 106, 105, 104, 103,
      ])
    })

    it('serves the roadmap index it finds, exactly as the file holds it', async () => {
      plantRoadmapIndex()
      const { response, body } = await askData()
      expect(response.status).toBe(200)
      expect(body.roadmap).toEqual(ROADMAP_INDEX)
    })

    it('answers roadmap: null - not an error - when no index exists', async () => {
      // The page has a named panel for this ("No roadmap index"). A 500 here
      // would turn a missing file into a broken page, which is the one thing
      // the route exists to avoid.
      const { response, body } = await askData()
      expect(response.status).toBe(200)
      expect(body.roadmap).toBeNull()
      expect(body.board.open).toBe(0)
    })

    it('opens one pool per request and has it closed by the time it answers', async () => {
      // The route builds its own pool and ends it in a finally, so from the
      // outside no answer may leave a live pool behind, and no later request
      // may be handed a pool an earlier one already ended. (The lease route
      // keeps its pool alive on purpose - its suite says so - so the two
      // contracts read differently by design.)
      await askData()
      await askData()
      expect(pools).toHaveLength(2)
      expect(pools[0]).not.toBe(pools[1])
      expect(pools.every((p) => p.ended)).toBe(true)
    })
  })

  describe('createQueenRoadmapRoute - the shell at /queen/roadmap', () => {
    it('serves an HTML page that must not be cached', async () => {
      const response = await createQueenRoadmapRoute().request('/')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      // The board moves while the page is open; a cached shell would show a
      // stale prompt to whoever reopens it.
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await response.text()).startsWith('<!doctype html>')).toBe(true)
    })

    it('points its script at the data route and carries no data of its own', async () => {
      const bare = await (await createQueenRoadmapRoute().request('/')).text()
      // The shell's only source of numbers is this fetch; if it pointed
      // anywhere else the page would render an error panel forever.
      expect(bare).toContain("fetch('/queen/roadmap/data'")

      // And it must hold no state of its own - the rule every queen shell
      // follows - pinned here as byte-identical output no matter what the
      // database, the workspace, or the index looks like when it is asked.
      plantRoadmapIndex()
      process.env.DATABASE_URL = UNREACHABLE
      table = [row(5, { missing: ['boundary'] })]
      const loaded = await (await createQueenRoadmapRoute().request('/')).text()
      expect(loaded).toBe(bare)
      expect(bare).not.toContain('E0-I1')
      expect(bare).not.toContain('Queen_T27_MVP_Architecture.md')
    })
  })
})
