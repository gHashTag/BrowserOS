/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The public status page's skip categories, held against the Swift sentences
 * they are substring-matched against.
 *
 * `classifySkipReason` in src/api/routes/queen-public-status.ts decides every
 * public skip category by matching fixed wording that queend writes in
 * queen-core, in another directory and another language. Nothing in the
 * repository reads one from the other: the route's matchers, the Swift
 * sentences, and the fixtures in queen-public-status.test.ts are three
 * hand-kept copies of the same words. A reword of a Swift sentence leaves
 * every existing test green while the public page starts filing the reason
 * under `other` - which is indistinguishable from the Queen having no reason
 * at all. Measured with the live classifier before this file existed: one
 * plausible reword moved five of seven reasons into `other` and the endpoint
 * still answered 200 with a well-formed body.
 *
 * THE GATE. The route and the two Swift files are read as text. This
 * container has no Swift compiler, so nothing here builds or runs queend; the
 * same limit is documented for its own cross-checks in queen-board.test.ts.
 * The markers are EXTRACTED from the route source, never typed here - a
 * hand-typed list would be a fourth copy of the defect this file exists to
 * catch. Each extracted marker must then be found on a non-comment line of
 * the Swift, every `skipped.append` site in main.swift must classify to a
 * named category with those markers, and a negative control rewords one
 * marker in memory and asserts the comparison reports it.
 *
 * FAILURE IS THE ONLY EXIT. If the route cannot be parsed or either Swift
 * file cannot be read, this file throws and fails. It never skips, never
 * returns early, and catches nothing.
 *
 * SCOPE. Only queend's own sentences are asserted. Round-level sentences
 * written in TypeScript, such as 'no registry mirror published yet' in
 * queen-tick.ts, are documented as `other` by the route's SKIP_CATEGORIES
 * comment and are deliberately outside this parity.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE = join(
  import.meta.dir,
  '../../src/api/routes/queen-public-status.ts',
)
const MAIN_SWIFT = join(
  import.meta.dir,
  '../../../../queen-core/Sources/queend/main.swift',
)
const QUALITY_SWIFT = join(
  import.meta.dir,
  '../../../../queen-core/Sources/QueenCore/QueenSpecQuality.swift',
)
// THE SENTENCES MOVED AND THIS LIST DID NOT FOLLOW THEM.
//
// `main.swift` no longer writes its own words for a live claim. It appends
// `QueenDelegationPolicy.spokenForReport(states:).detail`, and those four
// sentences live here. With only the two files above, this gate could see the
// append site but not the words - so it reported the site as unclassifiable
// whatever the route said, which is a true statement about its own reach
// rather than about the wording. A gate that cannot read where a sentence
// lives cannot tell drift from its own blind spot.
const DELEGATION_SWIFT = join(
  import.meta.dir,
  '../../../../queen-core/Sources/QueenPolicy/QueenDelegation.swift',
)

// Read once, at module scope. A path that cannot be read throws here and
// fails the whole file: this gate reports only success it has earned.
const routeText = readFileSync(ROUTE, 'utf8')
const mainSwiftText = readFileSync(MAIN_SWIFT, 'utf8')
const qualitySwiftText = readFileSync(QUALITY_SWIFT, 'utf8')
const delegationSwiftText = readFileSync(DELEGATION_SWIFT, 'utf8')

/** The Swift sources that own the sentences, concatenated for the search. */
const swiftSources =
  mainSwiftText + '\n' + qualitySwiftText + '\n' + delegationSwiftText

/** The body of classifySkipReason, cut out of the route source by braces. */
function extractClassifierBody(source: string): string {
  const signature = 'function classifySkipReason('
  const signatureAt = source.indexOf(signature)
  if (signatureAt === -1) {
    throw new Error('classifySkipReason not found in ' + ROUTE)
  }
  const openBrace = source.indexOf('{', signatureAt)
  if (openBrace === -1) {
    throw new Error('classifySkipReason has no body in ' + ROUTE)
  }
  let depth = 0
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openBrace, i + 1)
    }
  }
  throw new Error('classifySkipReason body never closes in ' + ROUTE)
}

const classifierBody = extractClassifierBody(routeText)

/** Every `line.includes(` call in the classifier, counted, not assumed. */
const includeCallCount = (
  classifierBody.match(/line\.includes\(/g) ?? []
).length

/** One rule of the classifier: its marker and its category. */
type SkipRule = { marker: string; category: string }

const rules: SkipRule[] = [
  ...classifierBody.matchAll(
    /line\.includes\('([^']*)'\)\)\s*return\s+'([^']+)'/g,
  ),
].map((match) => ({ marker: match[1], category: match[2] }))

/**
 * The wording queend's skip sentences must keep containing for the public
 * page to name a category. DERIVED from the route source by the extraction
 * above; the strings below appear in this file only as assertions about this
 * value and as the negative control's reword target, never as its source.
 */
export const QUEEND_SKIP_MARKERS: readonly string[] = rules.map(
  (rule) => rule.marker,
)

/** The route's classifier, rebuilt from the extracted rules in route order. */
function classifyWithMarkers(text: string): string {
  for (const rule of rules) {
    if (text.includes(rule.marker)) return rule.category
  }
  return 'other'
}

/**
 * Markers that no NON-COMMENT line of the given Swift text contains. A
 * sentence whose wording survives only inside a `//` or `///` comment is not
 * a sentence queend emits, so comment lines never count as an occurrence.
 */
function findMissingMarkers(swiftText: string): readonly string[] {
  const codeLines = swiftText
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => !line.startsWith('//'))
  return QUEEND_SKIP_MARKERS.filter(
    (marker) => !codeLines.some((line) => line.includes(marker)),
  )
}

/** One `skipped.append(...)` call in main.swift: its text and its line. */
type AppendSite = { line: number; text: string }

/**
 * Every `skipped.append(` site in the file, counted from the text. The scan
 * walks balanced parentheses and steps over double-quoted string bodies, so
 * parentheses inside a sentence or an interpolation cannot end a site early.
 */
function extractAppendSites(swiftText: string): readonly AppendSite[] {
  const needle = 'skipped.append('
  const sites: AppendSite[] = []
  let at = swiftText.indexOf(needle)
  while (at !== -1) {
    const openParen = at + needle.length - 1
    let depth = 0
    let closeParen = -1
    let i = openParen
    while (i < swiftText.length) {
      const ch = swiftText[i]
      if (ch === '"') {
        i += 1
        while (i < swiftText.length) {
          if (swiftText[i] === '\\') {
            i += 2
            continue
          }
          if (swiftText[i] === '"') break
          i += 1
        }
      } else if (ch === '(') {
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          closeParen = i
          break
        }
      }
      i += 1
    }
    if (closeParen === -1) {
      throw new Error(
        'skipped.append( at line ' +
          (swiftText.slice(0, at).split('\n').length + 1) +
          ' of ' +
          MAIN_SWIFT +
          ' never closes',
      )
    }
    sites.push({
      line: swiftText.slice(0, at).split('\n').length,
      text: swiftText.slice(openParen + 1, closeParen),
    })
    at = swiftText.indexOf(needle, closeParen + 1)
  }
  return sites
}

/** The site's own double-quoted string literals, joined into one sentence. */
function siteSentence(site: AppendSite): string {
  return [...site.text.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1])
    .join('')
}

/**
 * The sentences a policy function returns, for a site that appends a call
 * instead of writing its own words.
 *
 * A SITE THAT APPENDS A CALL WAS BEING CALLED DRIFT. `main.swift:262` appends
 * `QueenDelegationPolicy.spokenForReport(states:).detail`, so its own literals
 * are `"#\(number): "` and nothing else - no marker, ever, whatever the route
 * says. The check reported it as a site the public page can only file under
 * `other`, which is a true statement about this gate's reach and reads as a
 * statement about the wording. That is the same defect the gate exists to
 * catch, in the gate.
 *
 * So the one call it can follow is named here and resolved from the source it
 * lives in. NARROW ON PURPOSE: a site that appends a call this list does not
 * know is reported as exactly that, and never as drift. Widening the list is a
 * decision somebody makes on purpose; guessing is how a gate starts lying.
 */
const FOLLOWABLE_CALLS: Record<string, string> = {
  spokenForReport: delegationSwiftText,
}

function calledSentences(site: AppendSite): string[] | null {
  for (const [name, source] of Object.entries(FOLLOWABLE_CALLS)) {
    if (!site.text.includes(name)) continue
    const at = source.indexOf(`func ${name}(`)
    if (at === -1) {
      throw new Error(
        `this gate claims it can follow ${name}, and that function is not in the source it was told to read`,
      )
    }
    // Every `detail:` literal in the function body. The bodies interpolate
    // state names, so only the fixed part of each sentence is compared - the
    // same rule the route's matchers keep.
    const body = source.slice(at)
    const end = body.indexOf('\n    }')
    const found = [
      ...body.slice(0, end === -1 ? undefined : end).matchAll(
        /detail:\s*"((?:[^"\\]|\\.)*)"/g,
      ),
    ].map((m) => m[1])
    if (!found.length) {
      throw new Error(`no detail sentence found in ${name} - this gate is checking nothing`)
    }
    return found
  }
  return null
}

const appendSites = extractAppendSites(mainSwiftText)

describe('queen skip reason parity', () => {
  test('markers come from the route classifier, not from this file', () => {
    if (includeCallCount === 0) {
      throw new Error(
        'marker extraction found zero line.includes( calls inside ' +
          'classifySkipReason in ' +
          ROUTE +
          ' - refusing to pass by reading nothing',
      )
    }
    // One marker per includes call: a call the extraction cannot parse means
    // the classifier was rewritten, and that must fail here, not pass quietly.
    expect(QUEEND_SKIP_MARKERS.length).toBe(includeCallCount)
    expect(rules.length).toBe(includeCallCount)
    expect(new Set(QUEEND_SKIP_MARKERS).size).toBe(QUEEND_SKIP_MARKERS.length)
    for (const marker of QUEEND_SKIP_MARKERS) {
      expect(marker.length).toBeGreaterThan(0)
    }
    // What today's route yields. Each line is an assertion about the derived
    // value; QUEEND_SKIP_MARKERS itself is built only by the extraction.
    expect(QUEEND_SKIP_MARKERS).toContain(' held by ')
    // A SAMPLE, and it has to be one the route still has. This pinned the
    // single sentence a live claim used to write; the policy now returns four
    // and the route matches all four, so the sample names one of them.
    expect(QUEEND_SKIP_MARKERS).toContain('a worker already has it')
    expect(QUEEND_SKIP_MARKERS).toContain('the work already landed')
    expect(QUEEND_SKIP_MARKERS).toContain('no issue body was supplied')
    expect(QUEEND_SKIP_MARKERS).toContain('delegatable but')
    expect(QUEEND_SKIP_MARKERS).toContain('not yet a spec')
    expect(QUEEND_SKIP_MARKERS).toContain('declares no boundary')
    expect(QUEEND_SKIP_MARKERS).toContain('not first')
  })

  test('every marker is on a non-comment line of the Swift sources', () => {
    const missing = findMissingMarkers(swiftSources)
    expect(
      missing,
      'markers with no non-comment line in main.swift or ' +
        'QueenSpecQuality.swift - the Swift wording has drifted from the route',
    ).toEqual([])
  })

  test('every skipped.append site classifies to a named category', () => {
    console.log(
      '[parity] skipped.append sites measured in main.swift:',
      appendSites.length,
    )
    expect(appendSites.length).toBeGreaterThan(0)
    const unclassified = appendSites
      .map((site) => {
        // A site that appends a call is judged by every sentence that call can
        // return: if any one of them would land in `other`, the public page has
        // a reason it cannot name, and that is the same defect.
        const called = calledSentences(site)
        if (called) {
          const worst = called.find(
            (sentence) => classifyWithMarkers(sentence) === 'other',
          )
          return {
            line: site.line,
            category: worst === undefined ? 'classified' : 'other',
          }
        }
        return { line: site.line, category: classifyWithMarkers(siteSentence(site)) }
      })
      .filter((result) => result.category === 'other')
    expect(
      unclassified,
      'skipped.append sites whose own literals match no marker - queend ' +
        'writes a sentence the public page can only file under other',
    ).toEqual([])
  })

  test('negative control: the reworded marker is the only missing one', () => {
    // In memory only: no file on disk is written, moved, or truncated to run
    // this control.
    const reworded = swiftSources
      .split('the work already landed')
      .join('the work has already gone in')
    expect(findMissingMarkers(reworded)).toEqual(['the work already landed'])
  })
})
