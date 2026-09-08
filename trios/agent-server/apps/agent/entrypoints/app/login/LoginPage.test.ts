/**
 * Contract suite for the exports of LoginPage.tsx.
 *
 * The module exports exactly one symbol: `LoginPage`. The single `it`
 * below renders that export in each of its two server-renderable
 * states and asserts on the markup it emits, so the suite pins
 * observable behaviour rather than the shape of the implementation.
 * The `it` names the export it covers, so a reader can map assertions
 * to exports.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`LoginPage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies - the router and the auth client -
 * are swapped for in-memory stubs via `mock.module`, so this suite
 * needs no network, no database and no container.
 *
 * Not pinned, and why: everything the component does after first
 * paint. Sending a magic link, signing in with Google, the loading,
 * error and sent-confirmation screens, and the redirect-away for an
 * established session all live in event handlers and effects, and both
 * dispatching DOM events and running effects require a DOM
 * environment. There is none available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - and `renderToString` never runs effects. That is a gap in
 * interaction coverage, not an export left unexercised: the export
 * itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type SessionProbe = { data: unknown; isPending: boolean }

let sessionProbe: SessionProbe = { data: null, isPending: false }

mock.module('react-router', () => ({
  useNavigate: () => () => undefined,
}))

mock.module('@/lib/auth/auth-client', () => ({
  signIn: {
    magicLink: () => Promise.resolve({ error: null }),
    social: () => Promise.resolve({ error: null }),
  },
  useSession: () => sessionProbe,
}))

const { LoginPage } = await import('./LoginPage')

const render = (probe: SessionProbe): string => {
  sessionProbe = probe
  return renderToString(createElement(LoginPage))
}

// One spinner svg is rendered while the session is unresolved, so the
// count of svg tags in the markup is the count of icons the user sees.
const svgCount = (html: string): number => (html.match(/<svg/g) ?? []).length

describe('LoginPageTsxContract', () => {
  it('renders LoginPage as a lone full-screen spinner while the session is unresolved, and as the sign-in card with a required email field and an engaged-only-after-typing magic-link control once the session has settled', () => {
    // While the session is still loading, the page offers nothing but
    // a centred spinner: no card, no heading, no email field, and
    // neither sign-in control.
    const pendingHtml = render({ data: null, isPending: true })

    expect(pendingHtml).toContain('min-h-screen')
    expect(pendingHtml).toContain('animate-spin')
    expect(svgCount(pendingHtml)).toBe(1)
    expect(pendingHtml).not.toContain('Welcome to BrowserOS')
    expect(pendingHtml).not.toContain('Send Magic Link')
    expect(pendingHtml).not.toContain('Continue with Google')
    expect(pendingHtml).not.toContain('id="email"')

    // Once the session has settled with nobody signed in, the page is
    // the sign-in card: a welcome heading with its subtitle, a labelled
    // required email field, the magic-link control, the divider, and
    // the Google control with its Google-marked icon.
    const html = render({ data: null, isPending: false })

    expect(html).toContain('Welcome to BrowserOS')
    expect(html).toContain('Sign in to your account to continue')
    expect(html).toContain('for="email"')
    expect(html).toContain('id="email"')
    expect(html).toContain('type="email"')
    expect(html).toContain('placeholder="you@example.com"')
    expect(html).toContain('required=""')
    expect(html).toContain('Send Magic Link')
    expect(html).toContain('Or continue with')
    expect(html).toContain('Continue with Google')
    expect(html).toContain('aria-label="Google"')

    // First paint of the card is neither a loading state nor an error
    // state, and shows no sent-confirmation screen.
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('Check your email')

    // The email field starts empty, so the magic-link control cannot be
    // engaged until an address has been typed into it. The disabled
    // state is an HTML attribute, not merely a CSS affordance.
    const submitTag = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? ''
    expect(submitTag).not.toBe('')
    expect(submitTag).toContain('disabled=""')
  })
})
