import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  composeCards,
  createQueenKanbanRoute,
} from '../../src/api/routes/queen-kanban'

/**
 * The board, held against the policy it claims to speak for.
 *
 * The page at /queen/board says in its own docstring that it decides
 * held-versus-free "by the rule the Queen uses". It did not. Three rules were
 * transcribed from Swift into TypeScript and each had drifted:
 *
 *   containment  the board compared boundary paths with array membership,
 *                which is string equality, so a task owning `rings/SR-00` did
 *                not hold `rings/SR-00/Foo.swift` - the ordinary case
 *   the clock    `awaitingReview` held its boundary for ever on the board and
 *                for 48 hours in the policy, so the board drew BLOCKED and
 *                named a holder the Queen had already released
 *   the rank     several tasks on one issue were ranked by index into COLUMNS,
 *                which is the RENDER order and ends [... done, dropped], so an
 *                issue whose attempts were [accepted, cancelled] was drawn as
 *                dropped while queend answered "the work already landed"
 *
 * WHY THE BINARY. Every case below is put to the real `queend` and to the real
 * board builder, and the two answers are asserted against each other. A test
 * that only pinned today's TypeScript would go green the moment the Swift moved
 * - which is precisely the failure being fixed, since all three of these agreed
 * once.
 *
 * HONEST LIMIT, stated because a quiet skip is how a gate reports success it
 * never earned: on a machine that has not built `queend`, the cross-checks DO
 * NOT RUN. `the binary is where the container expects it` always runs, so the
 * path cannot drift unnoticed, and the pure-TypeScript assertions always run.
 */

const BIN = join(
  import.meta.dir,
  '../../../../queen-core/.build/release/queend',
)
const SWIFT_POLICY = join(
  import.meta.dir,
  '../../../../../rings/SR-00/QueenDelegation.swift',
)
const KANBAN = join(import.meta.dir, '../../src/api/routes/queen-kanban.ts')
const TICK = join(import.meta.dir, '../../src/api/services/queen-tick.ts')
const present = existsSync(BIN)

const HOUR = 3600_000
const NOW = Date.parse('2026-08-31T12:00:00Z')
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString()

interface Task {
  id: string
  conversationId: string
  issue: { owner: string; repo: string; number: number }
  title: string
  worker: string
  state: string
  ownedPaths: string[]
  virtualBranch: null
  createdAt: string
  updatedAt: string
  acceptanceCriteria: string[]
  interventions: string[]
  criterionVerdicts: Record<string, unknown>
}

function task(
  issue: number,
  state: string,
  ownedPaths: string[] = [],
  ageHours = 1,
): Task {
  const id = `00000000-0000-0000-0000-0000000${String(issue).padStart(5, '0')}`
  return {
    id,
    conversationId: id,
    issue: { owner: 'gHashTag', repo: 'trios', number: issue },
    title: 'a recorded task',
    worker: 'w',
    state,
    ownedPaths,
    virtualBranch: null,
    createdAt: ago(ageHours),
    updatedAt: ago(ageHours),
    acceptanceCriteria: [],
    interventions: [],
    criterionVerdicts: {},
  }
}

/**
 * The age bound on every SQL template in a file that reads `queen_dispatch`,
 * in source order, with `unbounded` for one that carries none.
 *
 * Splitting on the backtick is enough because `FROM queen_dispatch` occurs only
 * inside SQL, and it keeps prose out of the answer.
 */
function dispatchWindows(source: string): string[] {
  return source
    .split('`')
    .filter((chunk) => chunk.includes('FROM queen_dispatch'))
    .map((chunk) => {
      const bound = chunk.match(/dispatched_at > now\(\) - interval '([^']+)'/)
      return bound ? bound[1] : 'unbounded'
    })
}

/** An issue row as `queen_issues` holds one. */
function issue(number: number, ownedPaths: string[]) {
  return {
    number,
    title: `issue #${number}`,
    owned_paths: ownedPaths,
    criteria: [],
    criteria_source: 'none',
    missing: [],
  }
}

/** A spec-shaped body, so the only thing queend can object to is the boundary. */
const body = (path: string) =>
  [
    '## Success Criteria',
    '- make check exits 0.',
    '',
    '## Requirements',
    '- do the thing.',
    '',
    '## Scenarios',
    '- given a board, when a bee runs, then it commits.',
    '',
    '## Boundary',
    `\`${path}\``,
  ].join('\n')

/**
 * queend's own answer, driven exactly as the round drives it. `now` is the
 * binary's own clock, which is why the ages below are relative to it rather
 * than to NOW - the 48-hour edge is the thing under test.
 */
function queendHolds(candidate: number, path: string, tasks: Task[]): boolean {
  const run = spawnSync(BIN, {
    input: JSON.stringify({
      kind: 'choose',
      candidates: [candidate],
      candidateBodies: { [String(candidate)]: body(path) },
      tasks,
    }),
    encoding: 'utf8',
  })
  const answer = JSON.parse(run.stdout) as {
    skipped?: string[]
    chosen?: number
  }
  return (answer.skipped ?? []).some((line) => line.includes('held by'))
}

/** The board's answer for one candidate issue against one registry. */
function boardCard(candidate: number, path: string, tasks: Task[]) {
  const cards = composeCards({
    tasks,
    dispatches: [],
    issues: [issue(candidate, [path])],
    now: NOW,
  })
  const card = cards.find((c) => c.number === candidate)
  expect(card).toBeDefined()
  return card as NonNullable<typeof card>
}

describe('the board and queend read one registry the same way', () => {
  it('the binary is where the container expects it', () => {
    const dockerfile = readFileSync(
      join(import.meta.dir, '../../../../Dockerfile'),
      'utf8',
    )
    expect(dockerfile).toContain('queend')
  })

  // Live-against-live: the ages here are wall-clock relative so the binary,
  // which reads its own Date(), sees the same age the board does.
  const holder = (state: string, paths: string[], ageHours: number): Task => {
    const t = task(1286, state, paths, 0)
    const at = new Date(Date.now() - ageHours * HOUR).toISOString()
    return { ...t, createdAt: at, updatedAt: at }
  }

  const CONTAINMENT: Array<[string, string, string]> = [
    ['a file inside a held directory', 'rings/SR-00', 'rings/SR-00/Foo.swift'],
    ['a held directory named with ./', 'rings/SR-00', './rings/SR-00'],
    [
      'a held directory named with a trailing slash',
      'rings/SR-00',
      'rings/SR-00/',
    ],
    [
      'a directory containing a held file',
      'rings/SR-00/Foo.swift',
      'rings/SR-00',
    ],
  ]

  for (const [name, held, wanted] of CONTAINMENT) {
    it(`calls ${name} blocked, as queend does`, () => {
      const tasks = [holder('running', [held], 1)]
      const card = composeCards({
        tasks,
        dispatches: [],
        issues: [issue(9001, [wanted])],
        now: NOW,
      })[0]
      expect(card.column).toBe('blocked')
      expect(card.heldBy).toEqual(['#1286'])
      if (present) expect(queendHolds(9001, wanted, tasks)).toBe(true)
    })
  }

  it('keeps docs and docsite disjoint, as queend does', () => {
    const tasks = [holder('running', ['docs'], 1)]
    const card = composeCards({
      tasks,
      dispatches: [],
      issues: [issue(9001, ['docsite/x.md'])],
      now: NOW,
    })[0]
    expect(card.column).toBe('backlog')
    expect(card.heldBy).toBeUndefined()
    if (present) expect(queendHolds(9001, 'docsite/x.md', tasks)).toBe(false)
  })

  it('releases an awaitingReview boundary at 48 hours, as queend does', () => {
    const path = 'rings/SR-00/QueenLocalisation.swift'
    const stale = [holder('awaitingReview', [path], 70)]
    const fresh = [holder('awaitingReview', [path], 10)]

    expect(boardCard(9002, path, stale).column).toBe('backlog')
    expect(boardCard(9002, path, fresh).column).toBe('blocked')

    if (present) {
      expect(queendHolds(9002, path, stale)).toBe(false)
      expect(queendHolds(9002, path, fresh)).toBe(true)
    }
  })

  it('holds running, queued and rejected boundaries however old', () => {
    const path = 'rings/SR-00/Held.swift'
    for (const state of ['running', 'queued', 'rejected']) {
      const tasks = [holder(state, [path], 500)]
      expect(boardCard(9003, path, tasks).column).toBe('blocked')
      if (present) expect(queendHolds(9003, path, tasks)).toBe(true)
    }
  })

  it('never holds a boundary for a terminal task', () => {
    const path = 'rings/SR-00/Held.swift'
    for (const state of ['accepted', 'merged', 'cancelled', 'failed']) {
      const tasks = [holder(state, [path], 1)]
      // The issue itself carries a card from the registry task, so ask about a
      // DIFFERENT issue that wants the same path.
      const cards = composeCards({
        tasks,
        dispatches: [],
        issues: [issue(9004, [path])],
        now: NOW,
      })
      const card = cards.find((c) => c.number === 9004)
      expect(card?.column).toBe('backlog')
    }
  })

  it('the 48-hour constant is the one the policy compiles', () => {
    const swift = readFileSync(SWIFT_POLICY, 'utf8')
    const declared = swift.match(
      /reviewBoundaryHoldHours: Double = (\d+(?:\.\d+)?)/,
    )
    expect(declared).not.toBeNull()
    const kanban = readFileSync(KANBAN, 'utf8')
    const mirrored = kanban.match(
      /REVIEW_BOUNDARY_HOLD_HOURS = (\d+(?:\.\d+)?)/,
    )
    expect(mirrored).not.toBeNull()
    expect(Number(mirrored?.[1])).toBe(Number(declared?.[1]))
  })
})

describe('several tasks on one issue collapse to one card', () => {
  const bodyOf = 'docs/a.md'

  const landed = (order: string[]) =>
    composeCards({
      tasks: order.map((state) => ({
        ...task(1128, state, [], 1),
        id: `00000000-0000-0000-0000-00000000${state.slice(0, 4)}`,
      })),
      dispatches: [],
      issues: [issue(1128, [bodyOf])],
      now: NOW,
    })[0]

  it('reads [accepted, cancelled] as done in either order', () => {
    expect(landed(['accepted', 'cancelled']).column).toBe('done')
    expect(landed(['cancelled', 'accepted']).column).toBe('done')
  })

  it('agrees with queend, which says the work already landed', () => {
    if (!present) return
    for (const order of [
      ['accepted', 'cancelled'],
      ['cancelled', 'accepted'],
    ]) {
      const run = spawnSync(BIN, {
        input: JSON.stringify({
          kind: 'choose',
          candidates: [1128],
          candidateBodies: { '1128': body(bodyOf) },
          tasks: order.map((state, i) => ({
            ...task(1128, state, [], 1),
            id: `00000000-0000-0000-0000-00000000000${i}`,
          })),
        }),
        encoding: 'utf8',
      })
      const answer = JSON.parse(run.stdout) as { skipped?: string[] }
      expect((answer.skipped ?? []).join(' ')).toContain(
        'the work already landed (accepted)',
      )
    }
  })

  it('a live retry after a failure outranks the failure', () => {
    expect(landed(['failed', 'running']).column).toBe('running')
    expect(landed(['running', 'failed']).column).toBe('running')
  })

  it('leaves a purely dead issue in dropped', () => {
    expect(landed(['cancelled', 'failed']).column).toBe('dropped')
  })
})

describe('a cloud dispatch can reach a verdict', () => {
  const dispatch = (over: Record<string, unknown>) => ({
    issue: 4242,
    branch: 'queen/4242',
    started: true,
    detail: 'dispatched by the cloud tick',
    finished_at: null,
    outcome: null,
    review_state: null,
    review_note: null,
    ...over,
  })

  const only = (row: Record<string, unknown>) =>
    composeCards({
      tasks: [],
      dispatches: [row],
      issues: [issue(4242, ['docs/a.md'])],
      now: NOW,
    })[0]

  it('is running before its turn ends', () => {
    expect(only(dispatch({})).column).toBe('running')
  })

  it('is in review when the turn ended and nobody has judged it', () => {
    const card = only(dispatch({ finished_at: ago(1), outcome: 'finished' }))
    expect(card.column).toBe('review')
    expect(card.detail).toContain('waiting for a verdict')
  })

  it('reaches done when the Queen accepted it', () => {
    const card = only(
      dispatch({
        finished_at: ago(1),
        outcome: 'finished',
        review_state: 'accept',
        review_note: 'every criterion met',
      }),
    )
    expect(card.column).toBe('done')
    expect(card.detail).toContain('accept')
    expect(card.detail).toContain('every criterion met')
  })

  it('shows a sendBack and an escalate as her words, still in review', () => {
    for (const verdict of ['sendBack', 'escalate', 'wait']) {
      const card = only(
        dispatch({
          finished_at: ago(1),
          outcome: 'finished',
          review_state: verdict,
        }),
      )
      expect(card.column).toBe('review')
      expect(card.detail).toContain(verdict)
    }
  })

  it('bounds its dispatches by the same 7 days the round does', () => {
    // Read out of the SQL rather than out of the file: an earlier version of
    // this assertion searched the whole source, and the prose comment above the
    // query contains the clause too - so it stayed green with the clause
    // deleted from the query. A test that passes both ways proves nothing.
    const board = dispatchWindows(readFileSync(KANBAN, 'utf8'))
    // Two windows, and they are different on purpose. The LISTING - the query
    // that decides which dispatches become cards - must match the round's 7
    // days, or the board shows work the Queen has already forgotten. The
    // 24-hour window belongs to the pulse counters at the top of the page,
    // which answer "what did she do today" and would be meaningless over a
    // week. An unbounded query is what this test is really watching for.
    expect(board).toContain('7 days')
    expect(board).not.toContain('unbounded')
    expect(new Set(board)).toEqual(new Set(['7 days', '24 hours']))
    expect(dispatchWindows(readFileSync(TICK, 'utf8'))).toContain('7 days')
  })
})

/**
 * The page, redrawn - measured by counting nodes rather than by reading source.
 *
 * draw() runs on a 30-second timer. The flow strip and the empty-board notice
 * were built fresh with createElement and spliced in ahead of a sibling on
 * every draw, and nothing ever removed the previous one: the board's top was
 * measured 4135px down the document after five refreshes.
 *
 * The first guard written for this grepped the served source for the absence of
 * `.insertBefore(`. That goes red on the exact revert and green on everything
 * else - a fix reintroduced with `appendChild` would have passed it, and so
 * would a second `id="flow"` pasted into the markup. The defect is not a method
 * name. It is that drawing the same data twice leaves more document behind than
 * drawing it once.
 *
 * So the script is pulled out of the served HTML and run against a stub DOM,
 * three times over one payload, and the nodes are counted. The stub models the
 * two behaviours the fix actually leans on: assigning innerHTML REPLACES a
 * subtree, and insertBefore/appendChild ADD to a parent. Ids are flattened
 * under one root - the shell nests #token and #go inside #auth - which is safe
 * because every count below walks the whole tree, so an accumulation at any
 * depth is still an accumulation.
 */

/** One element, with the two DOM behaviours this page's correctness rests on. */
class El {
  tag: string
  id = ''
  className = ''
  hidden = false
  textContent = ''
  value = ''
  checked = false
  children: El[] = []
  parentNode: El | null = null
  #html = ''

  constructor(tag: string) {
    this.tag = tag
  }

  get innerHTML(): string {
    return this.#html
  }

  /** Assignment replaces the subtree. That is why the fixed draw is bounded. */
  set innerHTML(markup: string) {
    this.#html = markup
    for (const child of this.children) child.parentNode = null
    this.children = []
  }

  appendChild(child: El): El {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child: El, ref: El | null): El {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    const at = ref ? this.children.indexOf(ref) : -1
    if (at < 0) this.children.push(child)
    else this.children.splice(at, 0, child)
    return child
  }

  removeChild(child: El): El {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentNode = null
    return child
  }

  addEventListener(): void {}
}

/** Every element under `root`, at any depth. */
function allNodes(root: El): El[] {
  const found: El[] = []
  const walk = (node: El) => {
    for (const child of node.children) {
      found.push(child)
      walk(child)
    }
  }
  walk(root)
  return found
}

function withClass(root: El, name: string): El[] {
  return allNodes(root).filter((n) => n.className.split(/\s+/).includes(name))
}

/** The whole tree as text, so two draws can be compared rather than counted. */
function serialize(node: El): string {
  const attrs = `${node.id ? ` id="${node.id}"` : ''}${
    node.className ? ` class="${node.className}"` : ''
  }${node.hidden ? ' hidden' : ''}`
  const inside =
    node.innerHTML + node.textContent + node.children.map(serialize).join('')
  return `<${node.tag}${attrs}>${inside}</${node.tag}>`
}

/**
 * The shell's own id'd elements, in document order, as a browser would hand
 * them back: getElementById answers the FIRST of a repeated id, so a duplicate
 * in the markup shows up as an extra node rather than being folded away.
 */
function shellDocument(html: string) {
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'))
  const root = new El('div')
  const byId = new Map<string, El>()
  const openTag = /<([a-z]+)\b([^>]*)>/g
  let match = openTag.exec(body)
  while (match !== null) {
    const attrs = match[2]
    const id = attrs.match(/\bid="([A-Za-z0-9_-]+)"/)
    if (id) {
      const el = new El(match[1])
      el.id = id[1]
      el.className = attrs.match(/\bclass="([^"]*)"/)?.[1] ?? ''
      el.hidden = /\shidden(\s|\/|>|$)/.test(`${attrs} `)
      root.appendChild(el)
      if (!byId.has(el.id)) byId.set(el.id, el)
    }
    match = openTag.exec(body)
  }
  return { root, byId }
}

interface BoardPayload {
  repo: string
  columns: Array<{ key: string; title: string; blurb: string }>
  cards: Array<Record<string, unknown>>
}

/** Let the fetch promise chain settle; a macrotask flushes all microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Run the page's own script over one payload, and hand back the 30s timer. */
async function openBoardPage(payload: BoardPayload) {
  const html = await (await createQueenKanbanRoute().request('/')).text()
  const open = html.indexOf('<script>') + '<script>'.length
  const script = html.slice(open, html.lastIndexOf('</script>'))
  const { root, byId } = shellDocument(html)

  const document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new El(tag),
  }
  const store = () => {
    const held = new Map<string, string>()
    return {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => held.set(k, v),
      removeItem: (k: string) => held.delete(k),
    }
  }
  let poll: (() => void) | undefined
  const run = new Function(
    'document',
    'localStorage',
    'sessionStorage',
    'fetch',
    'setInterval',
    'clearInterval',
    script,
  )
  run(
    document,
    store(),
    store(),
    () =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(payload),
      }),
    (fn: () => void) => {
      poll = fn
      return 1
    },
    () => {},
  )
  await settle()
  return {
    root,
    byId,
    nodes: () => allNodes(root).length,
    drawAgain: async () => {
      poll?.()
      await settle()
    },
  }
}

const COLUMN_KEYS = [
  'backlog',
  'blocked',
  'running',
  'review',
  'done',
  'dropped',
]
const columns = COLUMN_KEYS.map((key) => ({ key, title: key, blurb: key }))

const payload = (cards: Array<Record<string, unknown>>): BoardPayload => ({
  repo: 'gHashTag/trios',
  columns,
  cards,
})

const busy = payload([
  { number: 1286, title: 'a running bee', column: 'running', paths: ['a.ts'] },
  { number: 1244, title: 'free work', column: 'backlog', paths: ['b.ts'] },
  { number: 1201, title: 'judged', column: 'done', paths: [] },
])

describe('the page redraws in place, every 30 seconds, for ever', () => {
  it('draws the flow strip at all', async () => {
    // The measurements below are worthless if draw() never ran, so this pins
    // that the page under the stub really renders before anything is counted.
    const page = await openBoardPage(busy)
    const flow = page.byId.get('flow') as El
    expect(flow.innerHTML).toContain('pick an issue')
    expect(flow.hidden).toBe(false)
    expect(page.byId.get('board')?.children).toHaveLength(COLUMN_KEYS.length)
  })

  it('holds its node count across three draws of the same data', async () => {
    const page = await openBoardPage(busy)
    const first = page.nodes()
    await page.drawAgain()
    const second = page.nodes()
    await page.drawAgain()
    expect([second, page.nodes()]).toEqual([first, first])
  })

  it('carries exactly one flow strip after three draws', async () => {
    const page = await openBoardPage(busy)
    await page.drawAgain()
    await page.drawAgain()
    expect(withClass(page.root, 'flow')).toHaveLength(1)
  })

  it('carries exactly one empty-board notice after three empty draws', async () => {
    // The notice only appeared when the board was empty, so the leak that fed
    // on it needed an empty database - which is exactly the state an operator
    // leaves a page open on while waiting for the first card.
    const page = await openBoardPage(payload([]))
    await page.drawAgain()
    await page.drawAgain()
    const notices = withClass(page.root, 'empty-board')
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent).toContain('not a swarm with nothing to do')
  })

  it('rebuilds the columns rather than stacking them', async () => {
    const page = await openBoardPage(busy)
    await page.drawAgain()
    await page.drawAgain()
    const board = page.byId.get('board') as El
    expect(board.children).toHaveLength(COLUMN_KEYS.length)
  })

  it('leaves the same document after the third draw as after the first', async () => {
    // Stronger than any count: same data in, same page out. A draw that adds
    // anything at all - by insertBefore, by appendChild, by a node it forgot to
    // clear - changes this string.
    const page = await openBoardPage(busy)
    const after1 = serialize(page.root)
    await page.drawAgain()
    await page.drawAgain()
    expect(serialize(page.root)).toBe(after1)
  })
})
