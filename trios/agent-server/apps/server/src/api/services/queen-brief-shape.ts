/**
 * Shape check for a Queen brief (#1090).
 *
 * `boundaryPathsOf` in `queen-tick.ts` reads the file boundary of an issue and
 * nothing else: the tick dispatched bodies with no Requirements and no Success
 * Criteria all the same, and the gap surfaced later as a bee whose finished
 * work could not be judged. This file is the door a malformed brief should not
 * pass: body in, verdict out - no fetching, no database, no clock (FR-003).
 *
 * The four sections are the Spec Kit ones the issue rule names (FR-002),
 * matched on `## ` headings the way `boundaryPathsOf` matches Boundary,
 * including the Cyrillic heading it already accepts. Section names in
 * `missing` are lowercase, in FR-002 order.
 *
 * A Boundary section that exists but names no path is refused as 'boundary':
 * the heading is present and the bee would still be handed nowhere to work,
 * which is the same dispatch failure one section earlier. So `missing` is
 * always the complete repair list, and `delegatable` is exactly
 * `missing.length === 0` for every input.
 */

/** The verdict: may this brief be dispatched, and what does it still lack? */
export interface BriefShape {
  delegatable: boolean
  /** Lowercase section names the body must grow before dispatch. */
  missing: string[]
}

/** The `## ` headings each section answers to, lowercased. FR-002 order. */
const SECTIONS: Array<{ name: string; headings: string[] }> = [
  { name: 'boundary', headings: ['## boundary', '## границы'] },
  { name: 'user scenarios', headings: ['## user scenarios'] },
  { name: 'requirements', headings: ['## requirements'] },
  { name: 'success criteria', headings: ['## success criteria'] },
]

/** Pure shape check of an issue body against the four brief sections. */
export function briefShape(body: string): BriefShape {
  const headings = body
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => line.startsWith('## '))
    .map((line) => line.toLowerCase())

  const missing = SECTIONS.filter(
    (section) =>
      !section.headings.some((heading) =>
        headings.some((line) => line.startsWith(heading)),
      ),
  ).map((section) => section.name)

  if (missing.length === 0 && boundaryPathsOf(body).length === 0) {
    missing.push('boundary')
  }

  return { delegatable: missing.length === 0, missing }
}

/**
 * The same reading of the boundary section as `boundaryPathsOf` in
 * `queen-tick.ts`, duplicated here because that copy is module-private and
 * `queen-tick.ts` carries `pg`, which this file must not import. If the Swift
 * rule grows a case, both copies follow it.
 */
function boundaryPathsOf(body: string): string[] {
  let inside = false
  const paths: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      if (inside) break
      inside = line.startsWith('## Boundary') || line.startsWith('## Границы')
      continue
    }
    if (!inside || line.length === 0) continue
    for (const token of line.split(/\s+/)) {
      const cleaned = token
        .replace(/^[`"'(]+/, '')
        .replace(/[`"'.,;:!?)]+$/, '')
      if (cleaned.includes('/') || /\.\w{1,10}$/.test(cleaned)) {
        paths.push(cleaned)
        break
      }
    }
  }
  return paths
}
