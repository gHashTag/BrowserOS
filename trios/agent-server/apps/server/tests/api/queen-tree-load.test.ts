/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Three states of tech-tree.json are three different answers.
 *
 * The file is hand-maintained - nothing in the repository generates it, and
 * `git grep tech-tree.json` finds only the loader that reads it - so a
 * hand-edit is the normal way it changes, and a hand-edit is exactly what
 * breaks it. Until now every breakage read the same sentence: "Expected
 * .trinity/dashboard/tech-tree.json in the checkout. This is a missing FILE",
 * which sent the reader hunting for a file that was sitting right there,
 * truncated or mistyped. And a file that parsed but had the wrong shape
 * escaped as a 500 through /queen/public-research - a wildcard-CORS public
 * endpoint - because the loader cast without checking and the consumer
 * trusted the cast.
 *
 * These tests drive the REAL loader through the real candidate paths by
 * pointing WORKSPACE_DIR at a throwaway directory, and hold each route to a
 * sentence that names a cause the loader actually established. The two
 * cwd-based candidates never resolve inside this checkout, so the temp file is
 * the only tree the loader can see.
 *
 * The tests deliberately import nothing that the fix introduces, so this file
 * runs unchanged against the old code - where the wrong-shape case fails with
 * the 500 it is here to condemn.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createQueenPublicResearchRoute } from '../../src/api/routes/queen-public-research'
import { createQueenTreeRoute, loadTree } from '../../src/api/routes/queen-tree'

const treeRoute = createQueenTreeRoute()

// The public route uses the real loader too; only the database and capacity
// are pinned so the answer depends on the tree file and nothing else.
const researchRoute = createQueenPublicResearchRoute({
  databaseUrl: () => undefined,
  workerCapacityBreakdown: () => ({
    connectedCredentials: 0,
    lanesPerCredential: 1,
    effectiveCapacity: 0,
  }),
})

const VALID_TREE = JSON.stringify(
  {
    nodes: [
      {
        id: 'compiler',
        label: 'Compiler',
        layer: 'seed',
        status: 'shipped',
        evidence: 't27c/src/main.rs:1',
      },
      {
        id: 'rings',
        label: 'Generated rings',
        layer: 'ring',
        status: 'partial',
        evidence: 'rings/T27-00/queen_core.t27',
      },
    ],
    edges: [{ from: 'compiler', to: 'rings' }],
    conflicts: ['one documented disagreement'],
    staleSkills: [
      {
        skill: 'a-skill',
        staleClaim: 'says zero stubs',
        shouldSay: 'stubs exist',
      },
    ],
  },
  null,
  2,
)

// A hand-edit saved mid-keystroke: valid so far, and then the file ends.
const TRUNCATED = '{"nodes": [{"id": "seed", "label": "Seed"'

// Parses cleanly, but the nodes are gone - the state that reached the
// consumers as `tree.nodes.reduce` and `tree.nodes.map` on undefined.
const WRONG_SHAPE = JSON.stringify(
  { edges: [], conflicts: [], staleSkills: [] },
  null,
  2,
)

// Parses cleanly, nodes intact, but a node is missing the evidence field the
// page prints - the state that used to render as a silent 200 with a blank
// where the evidence belongs.
const EVIDENCE_MISSING = JSON.stringify(
  {
    nodes: [
      { id: 'compiler', label: 'Compiler', layer: 'seed', status: 'shipped' },
    ],
    edges: [],
    conflicts: [],
    staleSkills: [],
  },
  null,
  2,
)

type TreeState = string | null

let workspace = ''
let previousWorkspaceDir: string | undefined

const treePath = () =>
  join(
    workspace,
    'BrowserOS',
    'trios',
    '.trinity',
    'dashboard',
    'tech-tree.json',
  )

function givenTree(content: TreeState) {
  rmSync(treePath(), { force: true })
  if (content === null) return
  mkdirSync(dirname(treePath()), { recursive: true })
  writeFileSync(treePath(), content)
}

async function requestTree(state: TreeState) {
  givenTree(state)
  const response = await treeRoute.request('/')
  return { response, body: await response.text() }
}

async function requestResearch(state: TreeState) {
  givenTree(state)
  const response = await researchRoute.request('/')
  return { status: response.status, body: await response.text() }
}

/**
 * The discriminator a consumer of the loader reads: a failure carries
 * `ok: false`, a Tree never carries an `ok` at all. Declared locally so the
 * file needs nothing the fix introduces.
 */
function asFailure(
  value: unknown,
): { ok: false; kind: string; detail: Record<string, unknown> } | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  ) {
    return value as { ok: false; kind: string; detail: Record<string, unknown> }
  }
  return null
}

beforeAll(() => {
  previousWorkspaceDir = process.env.WORKSPACE_DIR
})

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'queen-tree-load-'))
  process.env.WORKSPACE_DIR = workspace
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  if (previousWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = previousWorkspaceDir
})

describe('GET /queen/tree: three states, three answers', () => {
  it('absent file answers 503, says not found, and lists every path tried', async () => {
    const { response, body } = await requestTree(null)

    expect(response.status).toBe(503)
    expect(body).toContain('No technology tree found')
    expect(body).toContain('missing FILE, not an empty project')
    // Every path the loader tried, so a reader can go and look.
    expect(body).toContain(
      `${workspace}/BrowserOS/trios/.trinity/dashboard/tech-tree.json`,
    )
    expect(body).toContain(
      `${process.cwd()}/../.trinity/dashboard/tech-tree.json`,
    )
    expect(body).toContain(`${process.cwd()}/.trinity/dashboard/tech-tree.json`)
    // Causes that were not established are not asserted either.
    expect(body).not.toContain('could not be parsed')
    expect(body).not.toContain('expected shape')
  })

  it('truncated file answers 503, names the path and the parse position', async () => {
    const { response, body } = await requestTree(TRUNCATED)

    expect(response.status).toBe(503)
    expect(body).toContain('was found but could not be parsed')
    expect(body).toContain(`path: ${treePath()}`)
    expect(body).toContain(`parse position: ${TRUNCATED.length} (end of input)`)
    expect(body).not.toContain('No technology tree found')
    expect(body).not.toContain('missing FILE')
  })

  it('wrong shape answers 503, names the first missing or mistyped field', async () => {
    const { response, body } = await requestTree(WRONG_SHAPE)

    expect(response.status).toBe(503)
    expect(body).toContain('does not have the expected shape')
    expect(body).toContain(`path: ${treePath()}`)
    expect(body).toContain('first failing field: nodes')
    expect(body).toContain('expected an array of nodes, found undefined')
    expect(body).not.toContain('No technology tree found')
    expect(body).not.toContain('could not be parsed as JSON')
  })

  it('a node short of a field is a wrong shape too, named at the node', async () => {
    const { response, body } = await requestTree(EVIDENCE_MISSING)

    expect(response.status).toBe(503)
    expect(body).toContain('first failing field: nodes[0].evidence')
    expect(body).toContain('expected string, found undefined')
  })

  it('never answers the same sentence for two different states', async () => {
    const sentences = [
      (await requestTree(null)).body,
      (await requestTree(TRUNCATED)).body,
      (await requestTree(WRONG_SHAPE)).body,
    ]

    expect(new Set(sentences).size).toBe(3)
  })
})

describe('GET /queen/public-research: one fixed sentence, never a 500', () => {
  it('answers 503 for all three states with a body that does not change', async () => {
    const answers = [
      await requestResearch(null),
      await requestResearch(TRUNCATED),
      await requestResearch(WRONG_SHAPE),
    ]

    for (const answer of answers) {
      // The wrong-shape state used to escape here as an unhandled 500.
      expect(answer.status).toBe(503)
      expect(answer.body).toBe(
        '{"error":"Canonical research graph is unavailable"}',
      )
    }
    // The endpoint is public and wildcard-CORS: no cause detail leaks into it.
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1)
  })
})

describe('a valid tree keeps the current responses', () => {
  it('still renders the full page: 200, no-store, every node shown', async () => {
    const { response, body } = await requestTree(VALID_TREE)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('Compiler')
    expect(body).toContain('2 nodes, 1 dependencies')
    expect(body).toContain('one documented disagreement')
    expect(body).toContain('says zero stubs')
    expect(body).not.toContain('No technology tree found')
  })

  // The committed tree, not a stand-in: if the checks were stricter than the
  // real file, every deployment would answer 503 the day this shipped.
  it('still renders the tree committed to this checkout', async () => {
    mkdirSync(dirname(treePath()), { recursive: true })
    copyFileSync(
      join(import.meta.dir, '../../../../../.trinity/dashboard/tech-tree.json'),
      treePath(),
    )

    const { response, body } = await requestTree(
      await Bun.file(treePath()).text(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).not.toContain('No technology tree found')
  })

  it('still serves the projected graph through the same loader', async () => {
    const { status, body } = await requestResearch(VALID_TREE)

    expect(status).toBe(200)
    const graph = JSON.parse(body)
    expect(graph.summary.total).toBe(2)
    expect(graph.nodes[1].prerequisites).toEqual(['compiler'])
  })
})

describe('the loader says which of the failures occurred', () => {
  it('reports not-found when no candidate path exists', async () => {
    givenTree(null)

    const failure = asFailure(await loadTree())

    expect(failure?.kind).toBe('not-found')
    expect(failure?.detail.tried).toContain(
      `${workspace}/BrowserOS/trios/.trinity/dashboard/tech-tree.json`,
    )
  })

  it('reports unparseable with the path and the parse position', async () => {
    givenTree(TRUNCATED)

    const failure = asFailure(await loadTree())

    expect(failure?.kind).toBe('unparseable')
    expect(failure?.detail.path).toBe(treePath())
    expect(failure?.detail.position).toBe(TRUNCATED.length)
  })

  it('reports wrong-shape with the first failing field', async () => {
    givenTree(EVIDENCE_MISSING)

    const failure = asFailure(await loadTree())

    expect(failure?.kind).toBe('wrong-shape')
    expect(failure?.detail.field).toBe('nodes[0].evidence')
  })

  it('reports a mistyped status at the node that carries it', async () => {
    givenTree(
      JSON.stringify({
        nodes: [
          {
            id: 'compiler',
            label: 'Compiler',
            layer: 'seed',
            status: 'Shiped',
            evidence: 't27c/src/main.rs:1',
          },
        ],
        edges: [],
        conflicts: [],
        staleSkills: [],
      }),
    )

    const failure = asFailure(await loadTree())

    expect(failure?.kind).toBe('wrong-shape')
    expect(failure?.detail.field).toBe('nodes[0].status')
  })

  it('returns a Tree, not a failure, when the file is sound', async () => {
    givenTree(VALID_TREE)

    const loaded = await loadTree()

    expect(asFailure(loaded)).toBeNull()
    expect((loaded as { nodes: unknown[] }).nodes).toHaveLength(2)
  })
})
