/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen's shaper without a database (gHashTag/t27 specs/queen/shaping.t27
 * and specs/policy/issue_shape.t27, t27#7714). This file covers:
 * - the generated cards, checked against their own spec vectors;
 * - the facts the shaper gathers;
 * - the parse of the model's answer;
 * - the body it writes back.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  C_ALL,
  C_BOUNDARY,
  C_CRITERIA,
  C_REQUIREMENTS,
  C_SCENARIOS,
} from '../../src/api/services/queen-issue-shape.gen'
import {
  attemptDue,
  candidatePaths,
  composeBody,
  isContainer,
  isForeign,
  missingBits,
  missingLines,
  parseShape,
  pathAccepted,
  pathTokens,
  SHAPED_MARKER,
  shapeAction,
  shapeLands,
} from '../../src/api/services/queen-shaper'
import {
  MAX_BOUNDARY_PATHS,
  SH_LEAVE,
  SH_SHAPE,
  SH_TELL,
  SHAPE_ATTEMPT_LIMIT,
  SHAPE_RETRY_MINUTES,
} from '../../src/api/services/queen-shaping.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const PIN = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
const sha = (f: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, f)))
    .digest('hex')

const READY = [
  '## Goal',
  'Make the thing.',
  '## User Scenarios',
  '- Given a spec, When it is compiled, Then it passes.',
  '## Requirements',
  '- FR-001: the compiler MUST accept it.',
  '## Success Criteria',
  '- `./target/release/t27c gen-c specs/queen/app.t27` returns exit 0',
  '## Boundary',
  '- specs/queen/app.t27',
].join('\n')

describe('the vendored cards are the ones PIN names', () => {
  it('shaping and issue_shape match their recorded hashes', () => {
    for (const f of [
      'queen/shaping.t27',
      'queen/shaping.wasm',
      'policy/issue_shape.t27',
      'policy/issue_shape.wasm',
    ])
      expect(PIN).toContain(`${f} sha256 ${sha(f)}`)
  })
})

describe('the generated shaping card answers its own spec', () => {
  it('a_ready_issue_and_a_container_are_left_alone', () => {
    expect(shapeAction(0, false, 0, false)).toBe(SH_LEAVE)
    expect(shapeAction(15, true, 0, false)).toBe(SH_LEAVE)
    expect(shapeAction(1, true, 9, false)).toBe(SH_LEAVE)
  })
  it('an_unready_issue_is_shaped_then_its_author_is_told_once', () => {
    expect(shapeAction(1, false, 0, false)).toBe(SH_SHAPE)
    expect(shapeAction(15, false, SHAPE_ATTEMPT_LIMIT - 1, false)).toBe(
      SH_SHAPE,
    )
    expect(shapeAction(15, false, SHAPE_ATTEMPT_LIMIT, false)).toBe(SH_TELL)
    expect(shapeAction(15, false, SHAPE_ATTEMPT_LIMIT, true)).toBe(SH_LEAVE)
    expect(shapeAction(8, false, SHAPE_ATTEMPT_LIMIT + 3, true)).toBe(SH_LEAVE)
  })
  it('a_boundary_path_must_be_true_of_the_repository', () => {
    expect(pathAccepted(true, true, false, false)).toBe(true)
    expect(pathAccepted(true, true, true, false)).toBe(true)
    expect(pathAccepted(false, true, true, false)).toBe(true)
    expect(pathAccepted(false, true, false, false)).toBe(false)
    expect(pathAccepted(false, false, true, false)).toBe(false)
    expect(pathAccepted(false, true, true, true)).toBe(false)
  })
  it('a_shape_lands_only_when_the_body_is_ready_and_every_path_holds', () => {
    expect(shapeLands(0, 1, 0)).toBe(true)
    expect(shapeLands(0, MAX_BOUNDARY_PATHS, 0)).toBe(true)
    expect(shapeLands(1, 3, 0)).toBe(false)
    expect(shapeLands(0, 0, 0)).toBe(false)
    expect(shapeLands(0, MAX_BOUNDARY_PATHS + 1, 0)).toBe(false)
    expect(shapeLands(0, 3, 1)).toBe(false)
  })
  it('a_refused_shape_is_not_retried_every_round', () => {
    expect(attemptDue(0, 0)).toBe(true)
    expect(attemptDue(1, SHAPE_RETRY_MINUTES - 1)).toBe(false)
    expect(attemptDue(1, SHAPE_RETRY_MINUTES)).toBe(true)
  })
})

describe('the generated issue_shape card judges a body', () => {
  it('passes a body with all four sections', () => {
    expect(missingBits(READY)).toBe(0)
  })
  it('counts a Boundary heading with prose and no path as missing (#7703, #7642)', () => {
    const prose = READY.replace(
      '- specs/queen/app.t27',
      'The CSE pass shared by gen-zig and gen-verilog.',
    )
    expect(missingBits(prose)).toBe(C_BOUNDARY)
  })
  it("names every missing section in the card's own words", () => {
    expect(missingBits('')).toBe(C_ALL)
    expect(missingLines(C_ALL)).toHaveLength(4)
    expect(missingLines(C_CRITERIA)[0]).toContain('## Success Criteria')
  })
})

describe('the facts the shaper gathers', () => {
  const files = new Set([
    'specs/queen/app.t27',
    'specs/queen/control.t27',
    'bootstrap/src/codegen_zig.rs',
    'docs/now/x.md',
  ])
  it('reads path-shaped tokens and drops URLs', () => {
    expect(
      pathTokens(
        'see `specs/queen/app.t27`, and https://x.y/z or ./bootstrap/src/a.rs.',
      ),
    ).toEqual(['specs/queen/app.t27', 'bootstrap/src/a.rs'])
  })
  it('offers cited files first, then files a title word names, specs before the rest', () => {
    const c = candidatePaths(
      'codegen_zig: hoists over control',
      'Touches specs/queen/app.t27 and a new specs/queen/new_card.t27; not specs/nowhere/x.t27.',
      files,
    )
    expect(c.map((x) => x.path)).toEqual([
      'specs/queen/app.t27',
      'specs/queen/new_card.t27',
      'specs/queen/control.t27',
      'bootstrap/src/codegen_zig.rs',
    ])
    expect(c[1]).toEqual({
      path: 'specs/queen/new_card.t27',
      exists: false,
      cited: true,
    })
  })
  it('knows a container and a foreign new file', () => {
    expect(isContainer(['Epic'])).toBe(true)
    expect(isContainer(['roadmap', 'x'])).toBe(true)
    expect(isContainer(['epic-ish'])).toBe(false)
    expect(isForeign('tools/x.py')).toBe(true)
    expect(isForeign('a/Dockerfile')).toBe(true)
    expect(isForeign('specs/x.t27')).toBe(false)
  })
})

describe("the model's answer and the body written back", () => {
  const answer = [
    '## User Scenarios',
    '- Given app.t27, When gen-c runs, Then it compiles.',
    '## Requirements',
    '- FR-001: the generated C MUST compile.',
    '## Success Criteria',
    '- `./target/release/t27c gen-c specs/queen/app.t27` returns exit 0',
    '## Boundary',
    '- `specs/queen/app.t27`',
    '- ./specs/queen/control.t27',
  ].join('\n')
  it('parses the sections and the boundary paths', () => {
    const p = parseShape(answer)
    expect(p.notATask).toBe(null)
    expect([...p.sections.keys()]).toEqual([
      '## User Scenarios',
      '## Requirements',
      '## Success Criteria',
      '## Boundary',
    ])
    expect(p.paths).toEqual(['specs/queen/app.t27', 'specs/queen/control.t27'])
  })
  it('hears NOT_A_TASK', () => {
    expect(parseShape('NOT_A_TASK: a discussion').notATask).toBe('a discussion')
  })
  it('keeps the issue text, renames a prose Boundary, puts the new Boundary last, and the result is ready', () => {
    const original =
      '## Goal\nFix it.\n\n## Boundary\n\nThe CSE pass, plus a test.\n'
    const missing = missingBits(original)
    expect(missing).toBe(C_ALL)
    const body = composeBody(
      original,
      parseShape(answer),
      missing,
      '2026-10-08',
    )
    expect(body.startsWith('## Goal\nFix it.')).toBe(true)
    expect(body).toContain('## Scope note\n\nThe CSE pass, plus a test.')
    expect(body).toContain(`<!-- ${SHAPED_MARKER}:`)
    expect(
      body.trim().endsWith('- specs/queen/app.t27\n- specs/queen/control.t27'),
    ).toBe(true)
    expect(body.match(/^## Boundary/gm)).toHaveLength(1)
    expect(missingBits(body)).toBe(0)
  })
  it('adds only what is missing', () => {
    const original = READY.replace(
      /## Requirements\n- FR-001: the compiler MUST accept it.\n/,
      '',
    )
    const missing = missingBits(original)
    expect(missing).toBe(C_REQUIREMENTS)
    const body = composeBody(
      original,
      parseShape(answer),
      missing,
      '2026-10-08',
    )
    expect(body.match(/^## User Scenarios/gm)).toHaveLength(1)
    expect(body.match(/^## Requirements/gm)).toHaveLength(1)
    expect(missingBits(body)).toBe(0)
    expect(C_SCENARIOS).toBe(2)
  })
})
