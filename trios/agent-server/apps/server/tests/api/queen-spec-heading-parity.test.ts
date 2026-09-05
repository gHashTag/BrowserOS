import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  findOrphans,
  specQualityHeadingParity,
} from '../../../../../tools/spec-quality-heading-parity.mjs'

// One rule, two readers, two compiled copies of one file. QueenSpecQuality
// states the headings under which an issue says what "done" looks like
// twice: `static let criteriaHeadings` is the EXTRACTOR's list, matched
// loosely (a section title that CONTAINS one of these yields its bullets as
// criteria), while the `success criteria` Check's `met:` expression passes
// names to `hasSection`, which matches by exact anchored spelling. When the
// extractor knows a heading the check cannot see, an issue written under it
// has its criteria extracted AND is told the section does not exist
// (gHashTag/trios#1387, re-landed on this base as gHashTag/trios#1539).
//
// On the base as it stands the check reads the bare identifier
// `criteriaHeadings`, so the two lists are one list - but nothing pinned
// that, and this container has no Swift compiler to notice it drifting
// apart again. The gate reads both lists out of the source at run time;
// these tests pin it green for both compiled copies of the rule: the ring
// copy the app builds from, and the queen-core copy queend builds from.
const RING_COPY = join(
  import.meta.dir,
  '../../../../../rings/SR-00/QueenSpecQuality.swift',
)
const QUEEN_CORE_COPY = join(
  import.meta.dir,
  '../../../../../agent-server/queen-core/Sources/QueenCore/QueenSpecQuality.swift',
)

describe('queen spec heading parity (gHashTag/trios#1539)', () => {
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

  test('negative control: a heading no check name can see is reported', () => {
    // In memory only: no file on disk is written, moved, or truncated to
    // run this control. Splice a plausible new heading into the extractor's
    // own list and the gate must name it as the one orphan - a gate that
    // cannot fail was never a gate.
    const { extractorHeadings, checkNames } =
      specQualityHeadingParity(RING_COPY)
    const doctored = [...extractorHeadings, 'definition of done']
    expect(findOrphans(doctored, checkNames)).toEqual([
      { index: 10, heading: 'definition of done' },
    ])
    expect(findOrphans(extractorHeadings, checkNames)).toEqual([])
  })
})
