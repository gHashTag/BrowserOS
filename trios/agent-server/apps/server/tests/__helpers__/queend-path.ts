/**
 * One answer for where the queend policy binary is.
 *
 * Production resolves it in `queendPath()` inside `queen-tick.ts`: an
 * environment variable first, then the path the container installs it at.
 * The api suites used to restate a third answer of their own - a path
 * hard-coded relative to each test file - so on every CI run and on the
 * deployed container every parity case silently skipped, and a test file
 * that copied the hard-coding looked normal. This helper is the only place
 * outside `queen-tick.ts` allowed to know the spellings: the variable name
 * and the container fallback are parsed out of `queen-tick.ts` at run time,
 * never written down here, so the tests cannot disagree with production
 * about what they are resolving.
 *
 * `trios/tools/queend-path-audit.mjs` keeps it that way: a test file that
 * names a queend path without importing this helper fails the audit.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The production resolver. Read at run time; never edited, never restated. */
export const QUEEN_TICK_PATH = join(
  import.meta.dir,
  '../../src/api/services/queen-tick.ts',
)

/** The agent-server image definition that installs queend at runtime. */
export const DOCKERFILE_PATH = join(import.meta.dir, '../../../../Dockerfile')

/**
 * Pull `process.env.<VAR> || '<literal>'` out of the body of `queendPath()`.
 *
 * Throws when any piece is missing. A silent default here would put this
 * helper back in the business of guessing, which is the defect it exists to
 * remove.
 */
function parseQueenTick(source: string): { envVar: string; fallback: string } {
  const fn = /(?:export\s+)?function\s+queendPath\s*\([^)]*\)[^{]*\{/.exec(
    source,
  )
  if (!fn) throw new Error('queendPath() not found in queen-tick.ts')
  const open = fn.index + fn[0].length - 1
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(open + 1, i)
        const ret =
          /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\|\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/.exec(
            body,
          )
        if (!ret) {
          throw new Error(
            'no `process.env.<VAR> || "<literal>"` inside queendPath()',
          )
        }
        return { envVar: ret[1], fallback: ret[3] }
      }
    }
  }
  throw new Error('queendPath() body is unterminated')
}

/**
 * The name of the environment variable `queendPath()` reads, taken from
 * `queen-tick.ts` itself so a rename there cannot leave tests pointing an
 * operator's setting at a variable nothing reads.
 */
export function queendPathEnvVar(queenTickPath: string = QUEEN_TICK_PATH) {
  return parseQueenTick(readFileSync(queenTickPath, 'utf8')).envVar
}

/**
 * The fallback literal `queendPath()` returns when the variable is unset -
 * where the container installs the binary. Throws when it cannot be found,
 * because a test that cannot state the production answer must fail, not
 * pass on a guess.
 */
export function productionQueendFallback(
  queenTickPath: string = QUEEN_TICK_PATH,
): string {
  return parseQueenTick(readFileSync(queenTickPath, 'utf8')).fallback
}

/**
 * Where the Dockerfile's runtime stage installs queend: the destination of
 * the `COPY --from=queen-core /queen-core/queend <DEST>` line. Throws when
 * that line is absent, so an image that ships without the binary cannot
 * pass a sentinel built on this parser.
 */
export function containerQueendPath(
  dockerfilePath: string = DOCKERFILE_PATH,
): string {
  const source = readFileSync(dockerfilePath, 'utf8')
  for (const line of source.split('\n')) {
    const copy =
      /^\s*COPY\s+--from=queen-core\s+\/queen-core\/queend\s+(\S+)/.exec(line)
    if (copy) return copy[1]
  }
  throw new Error(
    `no COPY --from=queen-core /queen-core/queend <dest> line in ${dockerfilePath}`,
  )
}

/**
 * Where a test drives queend from, resolved exactly as production resolves
 * it, in the same order:
 *
 *   1. the environment variable `queendPath()` reads, returned unchanged
 *      and untrimmed when it is a non-empty string - an operator's explicit
 *      pointer is trusted before the filesystem is consulted at all;
 *   2. the container fallback, when it exists on this machine;
 *   3. the repository-local release build, which on a machine without a
 *      build does not exist - so the `skipIf` / `it.if` gates stay honest
 *      instead of the resolver inventing a path to force cases to run.
 */
export function resolveQueendPath(): string {
  const fromEnv = process.env[queendPathEnvVar()]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const container = productionQueendFallback()
  if (existsSync(container)) return container
  return join(import.meta.dir, '../../../../queen-core/.build/release/queend')
}
