/**
 * Contract suite for the exports of SkillsPage.tsx.
 *
 * The module exports exactly one symbol: `SkillsPage`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`SkillsPage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the agent server that
 * `./useSkills` fetches from over HTTP. The hook is swapped for an
 * in-memory stub via `mock.module`, so this suite needs no network, no
 * database and no container.
 *
 * Not pinned, and why: user interactions (opening the create/edit dialog,
 * toggling the enabled switch, confirming a deletion) dispatch DOM events
 * through Radix widgets. There is no DOM environment available to
 * `bun test` in this project - `@testing-library`, `happy-dom` and `jsdom`
 * are all absent from the lockfile - so only the component's rendered
 * output is pinned. That is a gap in interaction coverage, not an export
 * left unexercised: the export itself is rendered and asserted on, so no
 * export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { SkillDetail, SkillMeta } from './useSkills'

type UseSkillsResult = {
  skills: SkillMeta[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<unknown>
  createSkill: (input: {
    name: string
    description: string
    content: string
  }) => Promise<SkillMeta>
  updateSkill: (id: string, input: { enabled?: boolean }) => Promise<SkillMeta>
  deleteSkill: (id: string) => Promise<void>
  fetchSkillDetail: (id: string) => Promise<SkillDetail>
}

let hookResult: UseSkillsResult

mock.module('./useSkills', () => ({
  useSkills: () => hookResult,
}))

const { SkillsPage } = await import('./SkillsPage')

const userSkill: SkillMeta = {
  id: 'user-read-later',
  name: 'Read Later',
  description: 'Save the current page for later reading',
  location: '/skills/user-read-later',
  enabled: true,
  builtIn: false,
}

const builtInSkill: SkillMeta = {
  id: 'builtin-summarize-page',
  name: 'Summarize Page',
  description: 'Summarize the current page',
  location: '/skills/builtin-summarize-page',
  enabled: false,
  builtIn: true,
}

const settledHook: Omit<UseSkillsResult, 'skills'> = {
  isLoading: false,
  error: null,
  refetch: () => Promise.resolve(undefined),
  createSkill: () => Promise.resolve(userSkill),
  updateSkill: () => Promise.resolve(userSkill),
  deleteSkill: () => Promise.resolve(undefined),
  fetchSkillDetail: () =>
    Promise.resolve({ ...builtInSkill, content: '# Summarize' }),
}

const render = (result: UseSkillsResult): string => {
  hookResult = result
  return renderToString(createElement(SkillsPage))
}

// One skeleton placeholder avatar is rendered per loading card, so the
// count of these avatar blocks in the markup is the count of skeleton
// cards the user sees.
const skeletonCardCount = (html: string): number =>
  (html.match(/size-10 animate-pulse/g) ?? []).length

describe('SkillsPageTsxContract', () => {
  it('renders the page header with live counts and no open dialog', () => {
    const html = render({ ...settledHook, skills: [userSkill, builtInSkill] })

    expect(html).toContain('>Skills</h1>')
    expect(html).toContain('Define reusable instructions')
    expect(html).toContain('New Skill')
    expect(html).toContain('2 skills')
    expect(html).toContain('1 enabled')
    // The create/edit dialog and the delete confirmation start closed.
    expect(html).not.toContain('Create Skill')
    expect(html).not.toContain('Delete Skill')
  })

  it('renders a skeleton card grid while skills are still loading', () => {
    const html = render({ ...settledHook, skills: [], isLoading: true })

    expect(skeletonCardCount(html)).toBe(6)
    expect(html).toContain('New Skill')
    expect(html).not.toContain('No skills yet')
    // The apostrophe in the failure title is HTML-escaped in the output.
    expect(html).not.toContain('Couldn&#x27;t load skills')
    expect(html).not.toContain('My Skills')
  })

  it('renders a failure card with a retry control when loading fails', () => {
    const html = render({
      ...settledHook,
      skills: [],
      error: new Error('agent server unreachable'),
    })

    // The apostrophe in the failure title is HTML-escaped in the output.
    expect(html).toContain('Couldn&#x27;t load skills')
    expect(html).toContain(
      'Check that the local agent services are running, then retry.',
    )
    expect(html).toContain('Retry')
    expect(html).not.toContain('No skills yet')
    expect(skeletonCardCount(html)).toBe(0)
  })

  it('renders an empty-state card inviting creation when no skills exist', () => {
    const html = render({ ...settledHook, skills: [] })

    expect(html).toContain('0 skills')
    expect(html).toContain('No skills yet')
    expect(html).toContain('teach your agent how to handle repeatable tasks')
    expect(html).toContain('Create your first skill')
    expect(html).not.toContain('My Skills')
    expect(html).not.toContain('BrowserOS Skills')
    expect(skeletonCardCount(html)).toBe(0)
  })

  it('splits user skills and built-in skills into their own sections', () => {
    const html = render({ ...settledHook, skills: [userSkill, builtInSkill] })

    const mySkillsAt = html.indexOf('My Skills')
    const userSkillAt = html.indexOf('Read Later')
    const builtInSectionAt = html.indexOf('BrowserOS Skills')
    const builtInSkillAt = html.indexOf('Summarize Page')

    expect(mySkillsAt).toBeGreaterThanOrEqual(0)
    expect(userSkillAt).toBeGreaterThan(mySkillsAt)
    expect(builtInSectionAt).toBeGreaterThan(userSkillAt)
    expect(builtInSkillAt).toBeGreaterThan(builtInSectionAt)
    expect(html).toContain('Save the current page for later reading')
    expect(html).toContain('Summarize the current page')
  })

  it('gives built-in cards view affordances and user cards edit affordances', () => {
    const html = render({ ...settledHook, skills: [userSkill, builtInSkill] })

    expect(html).toContain('Built-in')
    expect(html).toContain('>View<')
    expect(html).toContain('>Edit<')
    expect(html).toContain('aria-label="Toggle Read Later"')
    expect(html).toContain('aria-label="Toggle Summarize Page"')
    expect(html).toContain('aria-label="Delete Read Later"')
    // A built-in skill cannot be deleted from the card.
    expect(html).not.toContain('aria-label="Delete Summarize Page"')
  })

  it('pluralises the header count only when more than one skill exists', () => {
    const html = render({ ...settledHook, skills: [userSkill] })

    expect(/1 skill(?!s)/.test(html)).toBe(true)
    expect(html).not.toContain('1 skills')
    expect(html).toContain('1 enabled')
  })
})
