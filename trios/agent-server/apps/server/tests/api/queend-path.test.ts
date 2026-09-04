import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  containerQueendPath,
  productionQueendFallback,
} from '../__helpers__/queend-path'

/**
 * The parsers behind the sentinel, proven falsifiable.
 *
 * The old "is where the container expects it" case compared a literal
 * against a substring of itself, so mutations that broke the deployed
 * container - queend installed elsewhere, or not installed at all - left it
 * green. `containerQueendPath` and `productionQueendFallback` exist so the
 * sentinel can compare two independently derived answers instead. A parser
 * that cannot fail proves nothing, so every case here feeds one of them a
 * wrong fixture under `node:os` tmpdir and asserts the specific wrong answer
 * comes back - a different destination, a thrown error, a different literal.
 *
 * This file has no `present` gate and must never acquire one: it tests
 * text parsing, not the binary, and nothing here depends on a build.
 */

/** Mirrors the real Dockerfile: several COPY lines from the same stage. */
const DOCKERFILE_INSTALLING_ELSEWHERE = [
  'FROM debian:bookworm-slim AS runtime',
  'COPY --from=queen-core /queen-core/PROOF /app/queen-core-linux.proof',
  'COPY --from=queen-core /queen-core/queend /opt/queend',
  'COPY --from=queen-core /lib/swift/linux /lib/swift/linux',
].join('\n')

/** A runtime image that never installs the policy binary. */
const DOCKERFILE_WITHOUT_QUEEND = [
  'FROM debian:bookworm-slim AS runtime',
  'COPY --from=queen-core /queen-core/PROOF /app/queen-core-linux.proof',
  'COPY --from=queen-core /lib/swift/linux /lib/swift/linux',
].join('\n')

/** A resolver whose fallback is not the one production ships. */
const QUEEN_TICK_WITH_OTHER_FALLBACK = [
  'export function queendPath(): string {',
  "  return process.env.QUEEND_FIXTURE_VAR || '/opt/policy/queend'",
  '}',
].join('\n')

/** A resolver with no fallback literal to find. */
const QUEEN_TICK_WITHOUT_FALLBACK = [
  'export function queendPath(): string {',
  '  return process.env.QUEEND_FIXTURE_VAR',
  '}',
].join('\n')

/** A scratch directory removed however the case ends. */
function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `queend-path-${name}-`))
}

describe('queend path parsers are falsifiable', () => {
  it('reads the COPY destination out of a Dockerfile', () => {
    const dir = scratch('dockerfile')
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, DOCKERFILE_INSTALLING_ELSEWHERE)
      expect(containerQueendPath(dockerfile)).toBe('/opt/queend')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when the Dockerfile never installs queend', () => {
    const dir = scratch('no-install')
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, DOCKERFILE_WITHOUT_QUEEND)
      expect(() => containerQueendPath(dockerfile)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the fallback literal out of a queen-tick copy', () => {
    const dir = scratch('fallback')
    try {
      const queenTick = join(dir, 'queen-tick.ts')
      writeFileSync(queenTick, QUEEN_TICK_WITH_OTHER_FALLBACK)
      expect(productionQueendFallback(queenTick)).toBe('/opt/policy/queend')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when queendPath() has no fallback literal', () => {
    const dir = scratch('no-fallback')
    try {
      const queenTick = join(dir, 'queen-tick.ts')
      writeFileSync(queenTick, QUEEN_TICK_WITHOUT_FALLBACK)
      expect(() => productionQueendFallback(queenTick)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
