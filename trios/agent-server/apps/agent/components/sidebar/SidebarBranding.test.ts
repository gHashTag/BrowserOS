/**
 * Contract suite for the exports of SidebarBranding.tsx.
 *
 * The module exports exactly one symbol: `SidebarBranding`. Every
 * assertion below renders that export and asserts on the markup it
 * emits, so the suite pins observable behaviour rather than the shape
 * of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`SidebarBranding`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies - the workspace storage behind
 * `useWorkspace`, the session storage behind `useSessionInfo`, the
 * GraphQL client behind `useGraphqlQuery`, and the router behind
 * `useNavigate` - are swapped for in-memory stubs via `mock.module`,
 * so this suite needs no network, no database and no container.
 * (`GetProfileByUserIdDocument` is also stubbed: its real module
 * imports generated GraphQL code that only exists after codegen.)
 *
 * Not pinned, and why: user interactions (opening the dropdown,
 * clicking "Sign in", "Update Profile" or "Sign out") dispatch DOM
 * events through Radix widgets wired to `navigate`. There is no DOM
 * environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so the destinations those menu items navigate to are not
 * asserted. That is a gap in interaction coverage, not an export left
 * unexercised: the export itself is rendered and asserted on, so no
 * export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type StubUser = {
  id: string
  name?: string | null
  image?: string | null
}

type StubProfile = {
  firstName?: string | null
  lastName?: string | null
  avatarUrl?: string | null
}

type QueryCall = {
  userId: string
  enabled: boolean | undefined
}

let stubSelectedFolderName: string | null = null

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({ selectedFolder: { name: stubSelectedFolderName } }),
}))

let stubUser: StubUser | null = null

mock.module('@/lib/auth/sessionStorage', () => ({
  useSessionInfo: () => ({
    sessionInfo: stubUser ? { user: stubUser } : {},
  }),
}))

mock.module('react-router', () => ({
  useNavigate: () => () => {
    // The suite has no DOM, so navigation is never triggered; the
    // stub exists so the hook call does not throw outside a router.
  },
}))

let queryCall: QueryCall | null = null
let queryData: { profileByUserId: StubProfile | null } | undefined

mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: (
    _document: unknown,
    variables: { userId: string },
    options: { enabled: boolean },
  ) => {
    queryCall = {
      userId: variables?.userId ?? '',
      enabled: options?.enabled,
    }
    return { data: queryData }
  },
}))

mock.module('@/entrypoints/app/profile/graphql/profileDocument', () => ({
  GetProfileByUserIdDocument: 'GetProfileByUserIdDocument',
}))

mock.module('@/assets/product_logo.svg', () => ({
  default: 'product_logo.svg',
}))

// The real ThemeToggle transitively imports web-extension storage
// (@wxt-dev/storage), which has no meaning outside a browser
// extension; the stub keeps a visible, clickable marker so the suite
// can still assert that the branding row renders the toggle.
mock.module('@/components/elements/theme-toggle', () => ({
  ThemeToggle: () =>
    createElement('button', { type: 'button', 'data-testid': 'theme-toggle' }),
}))

const { SidebarBranding } = await import('./SidebarBranding')

interface RenderInput {
  expanded?: boolean
  folderName?: string | null
  user?: StubUser | null
  profile?: StubProfile | null
}

const render = (input: RenderInput = {}): string => {
  stubSelectedFolderName = input.folderName ?? null
  stubUser = input.user ?? null
  queryData = input.profile ? { profileByUserId: input.profile } : undefined
  queryCall = null

  return renderToString(
    createElement(SidebarBranding, { expanded: input.expanded }),
  )
}

// The name block and the theme-toggle block are the only two regions
// the component hides when the sidebar is collapsed, so the count of
// "hidden" occurrences in the markup is the count of collapsed regions.
const collapsedRegionCount = (html: string): number =>
  (html.match(/(^|["' ])hidden(["' ]|$)/g) ?? []).length

describe('SidebarBrandingTsxContract', () => {
  it('shows the signed-out branding with the folder name and a sign-in invitation', () => {
    const html = render({ folderName: 'Marketing' })

    // Signed out, the header falls back to the product logo image.
    expect(html).toContain('src="product_logo.svg"')
    expect(html).toContain('alt="BrowserOS"')
    // The primary label is the selected workspace folder, not a user.
    expect(html).toContain('>Marketing<')
    expect(html).not.toContain('>User<')
    // The secondary label invites sign-in and is styled as an action.
    expect(html).toContain('Sign in')
    expect(html).toContain('text-primary')
  })

  it('falls back to the product name when signed out with no folder selected', () => {
    const html = render({ folderName: null })

    expect(html).toContain('>BrowserOS<')
    expect(html).not.toContain('>Marketing<')
  })

  it('prefers the profile name over the account name when signed in', () => {
    const html = render({
      user: { id: 'user-1', name: 'Ada Lovelace' },
      profile: { firstName: 'Grace', lastName: 'Hopper', avatarUrl: null },
    })

    expect(html).toContain('>Grace Hopper<')
    expect(html).not.toContain('>Ada Lovelace<')
    // Signed in, the secondary label reads "Personal", not "Sign in".
    expect(html).toContain('>Personal<')
    expect(html).not.toContain('Sign in')
  })

  it('falls back to the account name when the profile has none', () => {
    const html = render({ user: { id: 'user-1', name: 'Ada Lovelace' } })

    expect(html).toContain('>Ada Lovelace<')
    expect(html).toContain('>Personal<')
  })

  it('derives the avatar from the profile image, then the account image', () => {
    const fromProfile = render({
      user: { id: 'user-1', image: 'https://accounts.example/ada.png' },
      profile: { avatarUrl: 'https://profiles.example/grace.png' },
    })
    expect(fromProfile).toContain('src="https://profiles.example/grace.png"')

    const fromAccount = render({
      user: { id: 'user-1', image: 'https://accounts.example/ada.png' },
    })
    expect(fromAccount).toContain('src="https://accounts.example/ada.png"')
  })

  it('renders initials instead of an avatar when the user has no image', () => {
    const html = render({ user: { id: 'user-1', name: 'Ada Lovelace' } })

    // Both name parts contribute an initial, uppercased, at most two.
    expect(html).toContain('>AL<')
    expect(html).not.toContain('<img')
    expect(html).toContain('rounded-full')

    const singleName = render({ user: { id: 'user-2', name: 'Cher' } })
    expect(singleName).toContain('>C<')

    const anonymous = render({ user: { id: 'user-3', name: '' } })
    // With no usable name at all the component shows "User".
    expect(anonymous).toContain('>User<')
    expect(anonymous).toContain('>U<')
  })

  it('asks for the profile of the signed-in user only while signed in', () => {
    render({ user: { id: 'user-1', name: 'Ada Lovelace' } })
    expect(queryCall).toEqual({ userId: 'user-1', enabled: true })

    render({ user: null })
    expect(queryCall).toEqual({ userId: '', enabled: false })
  })

  it('keeps the labels and the theme toggle visible while expanded', () => {
    const html = render({ folderName: 'Marketing' })

    expect(html).toContain('opacity-100')
    expect(html).toContain('pr-3')
    expect(collapsedRegionCount(html)).toBe(0)
    // The theme toggle's trigger button is part of the branding row.
    expect(html).toContain('data-testid="theme-toggle"')
  })

  it('hides the labels and the theme toggle while collapsed', () => {
    const html = render({ folderName: 'Marketing', expanded: false })

    expect(collapsedRegionCount(html)).toBe(2)
    expect(html).not.toContain('pr-3')
    expect(html).not.toContain('opacity-100')
  })
})
