// The boundary rule, read by all three of its implementations at once.
//
// "Which paths may this bee touch?" is answered in three places, in three
// languages: the loop's own `verdict-audit.mjs`, the deployed
// `queen-tick.ts`, and the `QueenIssueBoundary` ring in Swift. A fourth copy
// sits in `queen-brief-shape.ts`, whose comment says it exists because the
// other TypeScript copy "is module-private" - that copy is exported now, so
// the stated reason has expired and nobody noticed.
//
// This rule has already cost real work. Two of the three copies knew
// `## Границы` and one did not, and seven bees were accused of straying
// outside a boundary they had honoured. The heading was added everywhere; what
// was never added was anything that would notice the NEXT divergence.
//
// So this runs all three over the real issue bodies and reports where they
// differ. It emits rows; `agree.mjs` decides what they mean, because a
// comparator that also gathers its own inputs is two tools in one and only the
// gathering ever gets tested.
//
// A MISSING COMPILER IS NOT AGREEMENT. If `swiftc` is absent the Swift side is
// reported as absent, never as matching - a gate that quietly drops the side it
// could not build is how "all green" comes to mean "we looked at two of three".
//
// Usage: bun run boundary-parity.ts [--cache <issues.json>]

import { boundaryOf } from './verdict-audit.mjs'

const CACHE = (() => {
  const i = process.argv.indexOf('--cache')
  return i >= 0 ? String(process.argv[i + 1]) : '/tmp/trios-all-issues.json'
})()

const ROOT = '/Users/playra/BrowserOS'
const SHIP = process.env.TRIOS_SHIP_REF || 'origin/feat/queen-supervisor'
const TS_IN_SHIP = 'trios/agent-server/apps/server/src/api/services/queen-tick.ts'
const SWIFT_RING = `${ROOT}/trios/rings/SR-00/QueenIssueBoundary.swift`

/** The named function's source text, brace-matched out of a larger file. */
function functionText(src: string, signature: string): string | null {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const open = src.indexOf('{', src.indexOf('):', start))
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(start, j + 1)
    }
  }
  return null
}

async function shipSource(): Promise<string | null> {
  const p = Bun.spawn(['git', 'show', `${SHIP}:${TS_IN_SHIP}`], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(p.stdout).text()
  return (await p.exited) === 0 && text.length > 0 ? text : null
}

/**
 * The deployed TypeScript parser, compiled from the shipping ref's own text.
 *
 * Extracted rather than reimplemented: a reimplementation here would be the
 * FIFTH copy of this rule, in the file whose whole purpose is to complain about
 * there being four.
 */
async function tsParser(): Promise<((body: string) => string[]) | null> {
  const src = await shipSource()
  if (!src) return null
  const fn = functionText(src, 'export function boundaryPathsOf(')
  if (!fn) return null
  const file = `${process.env.TMPDIR || '/tmp'}/trios-boundary-ts-${process.pid}.ts`
  await Bun.write(file, `${fn}\n`)
  try {
    const mod = await import(file)
    return typeof mod.boundaryPathsOf === 'function' ? mod.boundaryPathsOf : null
  } catch {
    return null
  }
}

/** The Swift ring, built and driven over stdin. Null when it cannot be built. */
async function swiftAnswers(bodies: string[]): Promise<string[] | null> {
  const dir = `${process.env.TMPDIR || '/tmp'}/trios-boundary-swift-${process.pid}`
  const bin = `${dir}/probe`
  await Bun.write(
    `${dir}/main.swift`,
    'import Foundation\n' +
      'while let line = readLine(strippingNewline: true) {\n' +
      '    guard let d = Data(base64Encoded: line), let body = String(data: d, encoding: .utf8) else { print("<undecodable>"); continue }\n' +
      '    let got = QueenIssueBoundary.paths(from: body)\n' +
      '    print(got == nil ? "<nil>" : got!.joined(separator: "|||"))\n' +
      '}\n',
  )
  const build = Bun.spawn(
    ['swiftc', '-O', SWIFT_RING, `${dir}/main.swift`, '-o', bin],
    { env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Library/Developer/CommandLineTools' }, stdout: 'ignore', stderr: 'pipe' },
  )
  if ((await build.exited) !== 0) return null
  const run = Bun.spawn([bin], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  run.stdin.write(bodies.map((b) => Buffer.from(b, 'utf8').toString('base64')).join('\n') + '\n')
  run.stdin.end()
  const out = await new Response(run.stdout).text()
  if ((await run.exited) !== 0) return null
  const lines = out.split('\n')
  // One answer per body, or the mapping is meaningless and nothing is claimed.
  return lines.length - 1 >= bodies.length ? lines : null
}

const rows: Array<Record<string, unknown>> = []
let issues: Array<{ number: number; body?: string }> | null = null
try {
  issues = JSON.parse(await Bun.file(CACHE).text())
} catch {
  issues = null
}

if (!issues || !issues.length) {
  console.log(`@@${JSON.stringify([{ fatal: `the issue cache ${CACHE} could not be read` }])}`)
  process.exit(0)
}

const ts = await tsParser()
const withBoundary = issues.filter((i) => boundaryOf(String(i.body || '')).reason !== 'absent')
const bodies = withBoundary.map((i) => String(i.body || ''))
const swift = await swiftAnswers(bodies)

for (const [k, it] of withBoundary.entries()) {
  const body = bodies[k]
  const js = boundaryOf(body).paths as string[]
  const tsPaths = ts ? ts(body) : null
  const raw = swift ? swift[k] : undefined
  const swPaths =
    swift === null || raw === undefined
      ? null
      : raw === '<nil>' || raw === ''
        ? []
        : raw.split('|||')
  rows.push({ id: it.number, js, ts: tsPaths, swift: swPaths })
}

console.log(
  `@@${JSON.stringify({
    rows,
    sides: {
      js: true,
      ts: ts !== null,
      swift: swift !== null,
    },
    cache: CACHE,
    considered: withBoundary.length,
    total: issues.length,
  })}`,
)
