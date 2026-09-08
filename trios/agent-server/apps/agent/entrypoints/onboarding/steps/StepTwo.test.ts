/**
 * Contract suite for the exports of StepTwo.tsx.
 *
 * The module exports exactly one symbol: `StepTwo`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`StepTwo`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies are swapped for in-memory stubs via
 * `mock.module`, so this suite needs no network, no database and no
 * container:
 *   - `@/lib/auth/auth-client` builds a real better-auth client bound to
 *     the hosted BrowserOS API at import time;
 *   - `@/lib/metrics/track` reads the extension manifest off the Chrome
 *     runtime at import time;
 *   - `@/lib/onboarding/onboardingStorage` is backed by WebExtension
 *     storage, which does not exist outside a browser.
 *
 * Not pinned, and why: the component's state machine lives behind DOM
 * events - skipping calls `onContinue` after emitting two metrics,
 * submitting the email form calls `signIn.magicLink` and swaps to the
 * "Check your email" screen, clicking Google persists the redirect path
 * and calls `signIn.social`, and failures surface an error alert. None of
 * those transitions can be triggered from `renderToString`, and there is
 * no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the component's rendered output is pinned. FR-001
 * forbids modifying the subject to reach into its internal state. That is
 * a gap in interaction coverage, not an export left unexercised: the
 * export itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

mock.module('@/lib/auth/auth-client', () => ({
  signIn: {
    magicLink: mock(() => Promise.resolve({})),
    social: mock(() => Promise.resolve({})),
  },
}))
mock.module('@/lib/metrics/track', () => ({
  track: mock(() => {}),
}))
mock.module('@/lib/onboarding/onboardingStorage', () => ({
  authRedirectPathStorage: {
    setValue: mock(() => Promise.resolve()),
  },
}))

const { StepTwo } = await import('./StepTwo')

const render = (direction: -1 | 1 = 1): string =>
  renderToString(createElement(StepTwo, { direction, onContinue: () => {} }))

// Returns the full opening tag of the first <button> whose attribute list
// contains the given fragment, so assertions can target one button of the
// three this screen renders.
const buttonTagContaining = (html: string, fragment: string): string => {
  const match = html.match(/<button[^>]*>/g) ?? []
  const found = match.find((tag) => tag.includes(fragment))
  if (found === undefined) {
    throw new Error(`no <button> opening tag contains ${fragment}`)
  }
  return found
}

describe('StepTwoTsxContract', () => {
  it('renders the sign-in heading and value proposition on entry', () => {
    const html = render()

    expect(html).toContain('Sign in to BrowserOS')
    expect(html).toContain('Sync your settings and unlock cloud features')
    // The step starts idle: no failure alert, no confirmation screen.
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('Check your email')
  })

  it('offers Google and email tracks separated by a divider', () => {
    const html = render()

    expect(html).toContain('Continue with Google')
    // The Google affordance is an icon that screen readers can name.
    expect(html).toContain('aria-label="Google"')
    expect(html).toContain('Or continue with email')
  })

  it('binds the email field to its label with the expected input contract', () => {
    const html = render()

    expect(html).toContain('for="signin-email"')
    const input = html.match(/<input[^>]*id="signin-email"[^>]*>/)?.[0] ?? ''
    expect(input).not.toBe('')
    expect(input).toContain('type="email"')
    expect(input).toContain('placeholder="you@example.com"')
    expect(input).toContain('required=""')
    // Idle state leaves the field editable (Tailwind class names mention
    // "disabled" too, so assert on the rendered attribute, not the word).
    expect(input).not.toContain('disabled=""')
  })

  it('disables the magic-link submit while the email is empty', () => {
    const html = render()

    const submit = buttonTagContaining(html, 'type="submit"')
    expect(submit).toContain('disabled=""')
    // The Google button, by contrast, is ready to use on entry.
    const google = buttonTagContaining(html, 'data-variant="outline"')
    expect(google).not.toContain('disabled=""')
    expect(html).toContain('Send Magic Link')
  })

  it('offers a skip affordance that stays visible on entry', () => {
    const html = render()

    expect(html).toContain('Skip for now')
    const skip = buttonTagContaining(html, 'data-variant="ghost"')
    expect(skip).not.toContain('disabled=""')
  })

  it('enters a forward step from the right and a backward step from the left', () => {
    const forward = render(1)
    const backward = render(-1)

    expect(forward).toContain('transform:translateX(1000px)')
    expect(forward).not.toContain('translateX(-1000px)')
    expect(backward).toContain('transform:translateX(-1000px)')
    expect(backward).not.toContain('transform:translateX(1000px)')
  })
})
