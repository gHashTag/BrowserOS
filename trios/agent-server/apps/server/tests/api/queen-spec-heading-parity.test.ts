import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { specQualityHeadingParity } from '../../../../../tools/spec-quality-heading-parity.mjs'

// One rule, two readers, one file: QueenSpecQuality.swift lists the headings
// under which an issue states what "done" looks like twice - once for the
// extractor (`criteriaHeadings`, matched loosely) and once for the `isSpec`
// `success criteria` check (`hasSection`, matched by exact spelling). When
// the extractor knows a heading the check cannot see, an issue written under
// it gets its criteria extracted AND is told the section does not exist
// (gHashTag/trios#1387). The gate reads both lists out of the source at run
// time; these tests pin it green for both compiled copies of the rule.
const RING_COPY = join(
  import.meta.dir,
  '../../../../../rings/SR-00/QueenSpecQuality.swift',
)
const QUEEN_CORE_COPY = join(
  import.meta.dir,
  '../../../../../agent-server/queen-core/Sources/QueenCore/QueenSpecQuality.swift',
)

describe('queen spec heading parity (gHashTag/trios#1387)', () => {
  test('rings copy: no extractor heading is invisible to the check', () => {
    const result = specQualityHeadingParity(RING_COPY)
    // A fix that deletes a heading instead of widening the check would
    // shrink this list; 10 is the floor the issue set.
    expect(result.extractorHeadings).toHaveLength(10)
    expect(result.orphans).toEqual([])
  })

  test('queen-core copy: no extractor heading is invisible to the check', () => {
    const result = specQualityHeadingParity(QUEEN_CORE_COPY)
    expect(result.extractorHeadings).toHaveLength(10)
    expect(result.orphans).toEqual([])
  })

  test('both copies carry the same extractor list', () => {
    const ring = specQualityHeadingParity(RING_COPY)
    const core = specQualityHeadingParity(QUEEN_CORE_COPY)
    expect(core.extractorHeadings).toEqual(ring.extractorHeadings)
    expect(core.checkNames).toEqual(ring.checkNames)
  })
})
