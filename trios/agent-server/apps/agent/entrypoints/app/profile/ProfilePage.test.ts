/**
 * Contract suite for `entrypoints/app/profile/ProfilePage.tsx`.
 *
 * The module exports a single symbol, `ProfilePage`, and this suite pins the
 * behaviour of that export exactly as the file stands today: the three views
 * it renders (signed out, profile loading, profile loaded), how the stored
 * record seeds the form and the avatar, and how a save outcome is reported.
 *
 * The suite is fully offline. React is mounted on a linkedom document, which
 * is resolved through wxt's own dependency closure so that no new package is
 * needed beyond `bun install`. The boundaries the component reaches through -
 * the router, the session store and the two GraphQL hooks - are swapped for
 * in-memory doubles; everything else (react-hook-form, the UI kit, the query
 * client) is the real thing. No network, database or container is touched.
 */
import { describe, expect, it, mock, vi } from 'bun:test'
import { createRequire } from 'node:module'
import type { FC } from 'react'
import { act, createElement } from 'react'

type SessionShape = { user?: { id?: string } } | undefined

type ProfileRecord = {
  rowId: number
  firstName: string
  lastName: string
  avatarUrl: string | null
}

type ProfileQueryResult = {
  data?: { profileByUserId?: ProfileRecord }
  isLoading: boolean
}

type MutationObservers = {
  onSuccess?: (data: unknown) => void
  onError?: (error: unknown) => void
}

let sessionInfo: SessionShape
let profileQuery: ProfileQueryResult
let mutationObservers: MutationObservers | undefined
const navigationCalls: Array<[unknown, unknown?]> = []

mock.module('react-router', () => ({
  useNavigate: () => (to: unknown, options?: unknown) => {
    navigationCalls.push([to, options])
  },
}))

mock.module('@/lib/auth/sessionStorage', () => ({
  useSessionInfo: () => ({
    sessionInfo,
    isLoading: false,
    updateSessionInfo: async () => {},
  }),
}))

mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: () => profileQuery,
}))

mock.module('@/lib/graphql/useGraphqlMutation', () => ({
  useGraphqlMutation: (_document: unknown, observers: MutationObservers) => {
    mutationObservers = observers
    return { mutate: (_variables: unknown) => {} }
  },
}))

mock.module('./graphql/profileDocument', () => ({
  // Stand-ins shaped as valid GraphQL so the real query-key parser, which
  // the component drives on save, can read an operation name from them.
  GetProfileByUserIdDocument:
    'query GetProfileByUserId { profileByUserId { rowId } }',
  UpdateProfileByUserIdDocument:
    'mutation UpdateProfileByUserId { updateProfileByUserId { profile { rowId } } }',
}))

// Offline document for react-dom. linkedom is not a direct dependency of this
// package; it is resolved from wxt's dependency closure in the lockfile.
const nodeRequire = createRequire(import.meta.url)
const wxtPackageJson = nodeRequire.resolve('wxt/package.json')
const { parseHTML } = createRequire(wxtPackageJson)('linkedom') as {
  parseHTML: (html: string) => { document: Document; window: Window }
}

const dom = parseHTML('<!doctype html><html><body></body></html>')
globalThis.document = dom.document
globalThis.window = dom.window
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { ProfilePage } = await import('./ProfilePage')
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import(
  '@tanstack/react-query'
)

describe('ProfilePageTsxContract', () => {
  it('ProfilePage renders its signed-out, loading and loaded views, seeds the form from the stored profile, and reports save outcomes', async () => {
    sessionInfo = undefined
    profileQuery = { data: undefined, isLoading: false }
    mutationObservers = undefined
    navigationCalls.length = 0

    const container = document.createElement('div')
    document.body.appendChild(container)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const root = createRoot(container)
    const renderSubject = async () => {
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ProfilePage as FC),
          ),
        )
      })
    }
    const view = () => container.textContent ?? ''

    // Signed out: nothing but a spinner renders, the visitor is routed to the
    // login screen, and no form is offered.
    await renderSubject()
    expect(view()).toBe('')
    expect(navigationCalls).toContainEqual(['/login', { replace: true }])
    expect(container.querySelector('form')).toBeNull()

    // Signed in while the profile is still loading: still no form.
    sessionInfo = { user: { id: 'user-1' } }
    profileQuery = { data: undefined, isLoading: true }
    await renderSubject()
    expect(view()).toBe('')
    expect(container.querySelector('form')).toBeNull()

    // Profile loaded: the editable form appears, seeded from the record.
    profileQuery = {
      data: {
        profileByUserId: {
          rowId: 7,
          firstName: 'Ada',
          lastName: 'Lovelace',
          avatarUrl: null,
        },
      },
      isLoading: false,
    }
    await renderSubject()
    expect(view()).toContain('Update Profile')
    expect(view()).toContain('Update your profile information')
    expect(view()).toContain('First Name')
    expect(view()).toContain('Last Name')
    expect(view()).toContain('Save Changes')
    expect(view()).toContain('Click to upload profile picture')
    // With no stored avatar, the initials derived from the record stand in.
    expect(view()).toContain('AL')
    expect(container.querySelector('img')).toBeNull()
    const firstNameInput = container.querySelector(
      'input[name="firstName"]',
    ) as HTMLInputElement | null
    expect(firstNameInput?.value).toBe('Ada')
    const lastNameInput = container.querySelector(
      'input[name="lastName"]',
    ) as HTMLInputElement | null
    expect(lastNameInput?.value).toBe('Lovelace')

    // A stored avatar replaces the initials.
    profileQuery = {
      data: {
        profileByUserId: {
          rowId: 7,
          firstName: 'Ada',
          lastName: 'Lovelace',
          avatarUrl: 'https://cdn.example/ada.png',
        },
      },
      isLoading: false,
    }
    await renderSubject()
    const avatar = container.querySelector('img')
    expect(avatar?.getAttribute('src')).toBe('https://cdn.example/ada.png')
    expect(avatar?.getAttribute('alt')).toBe('Profile')

    // A successful save is confirmed, and the confirmation clears itself
    // three seconds later.
    expect(view()).not.toContain('Profile updated successfully!')
    vi.useFakeTimers()
    try {
      await act(async () => {
        mutationObservers?.onSuccess?.({})
      })
      expect(view()).toContain('Profile updated successfully!')
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(view()).not.toContain('Profile updated successfully!')
    } finally {
      vi.useRealTimers()
    }

    // A failed save surfaces the failure message.
    await act(async () => {
      mutationObservers?.onError?.(new Error('Upload backend unreachable'))
    })
    expect(view()).toContain('Upload backend unreachable')

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
