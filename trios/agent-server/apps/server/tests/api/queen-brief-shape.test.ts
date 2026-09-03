import { describe, expect, it } from 'bun:test'
import { briefShape } from '../../src/api/services/queen-brief-shape'

/**
 * A brief is the bee's whole task, and until #1090 nothing checked its shape:
 * `boundaryPathsOf` read the boundary and the tick dispatched whatever else
 * the body happened to contain. A missing Requirements or Success Criteria
 * section was not refused at the door - it was discovered as a bee that could
 * not be judged. These cases pin the door shut: every section missing alone,
 * the boundary present but empty, and the exact report the Queen reads.
 */
describe('the shape of a Queen brief', () => {
  // One block per section, in the order a spec reads.
  const SECTIONS: Record<string, string> = {
    'user scenarios':
      '## User Scenarios\n\nA bee reads the brief before it works.',
    requirements:
      '## Requirements\n\n- **FR-001**: Pure function, body-in, verdict-out.',
    'success criteria':
      '## Success Criteria\n\n- `bun test` passes with every case.',
    boundary: '## Boundary\n\nsrc/api/services/queen-brief-shape.ts',
  }

  /** The full four-section brief, minus any sections named in `drop`. */
  const bodyWithout = (...drop: string[]) =>
    Object.entries(SECTIONS)
      .filter(([name]) => !drop.includes(name))
      .map(([, text]) => text)
      .join('\n\n')

  it('is delegatable when all four sections are present and the boundary names a path', () => {
    expect(briefShape(bodyWithout())).toEqual({
      delegatable: true,
      missing: [],
    })
  })

  // FR-004: each section missing alone, reported by name.
  it('names a missing Boundary and refuses the brief', () => {
    expect(briefShape(bodyWithout('boundary'))).toEqual({
      delegatable: false,
      missing: ['boundary'],
    })
  })

  it('names a missing User Scenarios and refuses the brief', () => {
    expect(briefShape(bodyWithout('user scenarios'))).toEqual({
      delegatable: false,
      missing: ['user scenarios'],
    })
  })

  it('names missing Requirements and refuses the brief', () => {
    expect(briefShape(bodyWithout('requirements'))).toEqual({
      delegatable: false,
      missing: ['requirements'],
    })
  })

  // The exact array #1090 pins: one section absent, one name in the report.
  it("reports exactly ['success criteria'] when only that section is absent", () => {
    expect(briefShape(bodyWithout('success criteria'))).toEqual({
      delegatable: false,
      missing: ['success criteria'],
    })
  })

  // FR-004: the heading exists, the bee would still be handed nowhere to
  // work - same refusal, same name in the repair list.
  it('refuses a Boundary that is present but names no path', () => {
    const withEmptyBoundary = `${bodyWithout('boundary')}\n\n## Boundary\n\n(never filled in)`
    expect(briefShape(withEmptyBoundary)).toEqual({
      delegatable: false,
      missing: ['boundary'],
    })
  })

  it('accepts the Cyrillic boundary heading boundaryPathsOf accepts', () => {
    const withCyrillicBoundary = `${bodyWithout('boundary')}\n\n## Границы\n\nsrc/api/services/queen-brief-shape.ts`
    expect(briefShape(withCyrillicBoundary)).toEqual({
      delegatable: true,
      missing: [],
    })
  })

  it('names all four sections when the body is empty', () => {
    expect(briefShape('')).toEqual({
      delegatable: false,
      missing: [
        'boundary',
        'user scenarios',
        'requirements',
        'success criteria',
      ],
    })
  })
})
