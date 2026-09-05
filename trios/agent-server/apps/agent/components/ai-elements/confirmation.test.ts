/**
 * Contract suite for the exports of confirmation.tsx.
 *
 * The module has 7 runtime exports, each marked @public in the source:
 * Confirmation, ConfirmationTitle, ConfirmationRequest, ConfirmationAccepted,
 * ConfirmationRejected, ConfirmationActions and ConfirmationAction. (The
 * module's `export type` aliases only describe prop shapes and are erased at
 * compile time, so they are not part of the runtime surface that a suite
 * under `bun test` can exercise.)
 *
 * Export accounting (the module has 7 runtime exports in total):
 *   - exercised by assertions below: 7 (one `it` block per export, named for
 *     the export that block pins, so assertions map one-to-one onto exports)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 7 + 0 = 7, matching the export count of the module.
 *
 * Nothing was blocked. Every import of confirmation.tsx is a pure
 * render-time helper - the Alert/AlertDescription/Button wrappers, the `cn`
 * class merger and React itself - so the real components render under
 * react-dom/server with no stubs at all. The suite therefore needs no
 * network, no database and no container. What it deliberately does not pin
 * is click handling: there is no DOM environment available to `bun test` in
 * this project (`@testing-library`, `happy-dom` and `jsdom` are all absent
 * from the lockfile), so only markup and render-time errors are asserted.
 * That is a gap in interaction coverage, not an export left unexercised:
 * each of the 7 exports above is rendered and asserted on directly.
 */
import { describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

import type { ConfirmationProps } from './confirmation'
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from './confirmation'

const granted = { id: 'toolu_confirm', approved: true }
const refused = { id: 'toolu_confirm', approved: false }

type Approval = { id: string; approved: boolean }

/** Renders `child` inside a real Confirmation shell for the given state. */
const renderInsideConfirmation = (
  state: ConfirmationProps['state'],
  child: ReactNode,
  approval: Approval = granted,
): string =>
  renderToString(createElement(Confirmation, { approval, state }, child))

describe('confirmationTsxContract', () => {
  describe('Confirmation', () => {
    it('stays hidden until approval is pending, then renders an alert that merges className and spreads props', () => {
      // No approval yet: nothing is shown at all.
      expect(
        renderToString(
          createElement(Confirmation, { state: 'approval-requested' }),
        ),
      ).toBe('')
      // Approval exists but the tool input has not finished: still hidden.
      expect(
        renderToString(
          createElement(Confirmation, {
            approval: granted,
            state: 'input-streaming',
          }),
        ),
      ).toBe('')
      expect(
        renderToString(
          createElement(Confirmation, {
            approval: granted,
            state: 'input-available',
          }),
        ),
      ).toBe('')

      const html = renderToString(
        createElement(Confirmation, {
          approval: granted,
          state: 'approval-requested',
          className: 'w-96',
          'data-testid': 'confirmation-card',
        }),
      )
      expect(html).toContain('role="alert"')
      expect(html).toContain('data-testid="confirmation-card"')
      // The shell's own layout classes survive next to the caller's class.
      expect(html).toContain('flex flex-col gap-2')
      expect(html).toContain('w-96')
    })
  })

  describe('ConfirmationTitle', () => {
    it('renders its children as an inline alert description in every state where the shell shows', () => {
      const title = (className?: string) =>
        createElement(
          ConfirmationTitle,
          className ? { className } : null,
          'Allow file access?',
        )

      const requested = renderInsideConfirmation('approval-requested', title())
      expect(requested).toContain('data-slot="alert-description"')
      expect(requested).toContain('inline')
      expect(requested).toContain('Allow file access?')

      // The caller's class is merged onto the description slot.
      const styled = renderInsideConfirmation(
        'approval-requested',
        title('text-xs'),
      )
      expect(styled).toContain('inline')
      expect(styled).toContain('text-xs')

      // Unlike the gated sections below, the title is not state-gated:
      // it still renders once the tool has answered.
      const answered = renderInsideConfirmation('output-available', title())
      expect(answered).toContain('Allow file access?')
    })
  })

  describe('ConfirmationRequest', () => {
    it('reveals children only while approval is requested, and demands a surrounding Confirmation', () => {
      const request = createElement(
        ConfirmationRequest,
        null,
        'Approve this action?',
      )

      const requested = renderInsideConfirmation('approval-requested', request)
      expect(requested).toContain('role="alert"')
      expect(requested).toContain('Approve this action?')

      // In the states after the request the shell keeps rendering, but the
      // request copy disappears from the markup.
      for (const state of [
        'output-available',
        'approval-responded',
        'output-denied',
      ] as const) {
        const html = renderInsideConfirmation(state, request)
        expect(html).toContain('role="alert"')
        expect(html).not.toContain('Approve this action?')
      }

      // While the tool input has not finished, the whole shell hides, so the
      // request is unreachable there as well.
      expect(renderInsideConfirmation('input-available', request)).toBe('')

      // Used outside a Confirmation there is no context to read, which is
      // surfaced as a render-time error naming the required parent.
      expect(() =>
        renderToString(createElement(ConfirmationRequest, null, 'orphan')),
      ).toThrow('Confirmation components must be used within Confirmation')
    })
  })

  describe('ConfirmationAccepted', () => {
    it('reveals children only after approval was granted and the tool has moved past the request', () => {
      const child = 'Running with your approval'
      const accepted = createElement(ConfirmationAccepted, null, child)

      for (const state of [
        'approval-responded',
        'output-denied',
        'output-available',
      ] as const) {
        const html = renderInsideConfirmation(state, accepted)
        expect(html).toContain('role="alert"')
        expect(html).toContain(child)
      }

      // Still awaiting an answer: hidden even though approval is granted.
      const awaiting = renderInsideConfirmation('approval-requested', accepted)
      expect(awaiting).toContain('role="alert"')
      expect(awaiting).not.toContain(child)

      // The answer was a refusal: hidden in the responded states.
      const refusedHtml = renderInsideConfirmation(
        'approval-responded',
        accepted,
        refused,
      )
      expect(refusedHtml).toContain('role="alert"')
      expect(refusedHtml).not.toContain(child)
    })
  })

  describe('ConfirmationRejected', () => {
    it('reveals children only after approval was refused and the tool has moved past the request', () => {
      const child = 'Blocked at your request'
      const rejected = createElement(ConfirmationRejected, null, child)

      for (const state of [
        'approval-responded',
        'output-denied',
        'output-available',
      ] as const) {
        const html = renderInsideConfirmation(state, rejected, refused)
        expect(html).toContain('role="alert"')
        expect(html).toContain(child)
      }

      // Still awaiting an answer: hidden even though the refusal is recorded.
      const awaiting = renderInsideConfirmation(
        'approval-requested',
        rejected,
        refused,
      )
      expect(awaiting).toContain('role="alert"')
      expect(awaiting).not.toContain(child)

      // The answer was a grant: hidden in the responded states.
      const grantedHtml = renderInsideConfirmation(
        'approval-responded',
        rejected,
      )
      expect(grantedHtml).toContain('role="alert"')
      expect(grantedHtml).not.toContain(child)
    })
  })

  describe('ConfirmationActions', () => {
    it('reveals a right-aligned action row only while approval is requested', () => {
      const allow = createElement('button', { type: 'button' }, 'Allow')
      const deny = createElement('button', { type: 'button' }, 'Deny')

      const requested = renderInsideConfirmation(
        'approval-requested',
        createElement(
          ConfirmationActions,
          { className: 'pt-1', 'data-testid': 'confirmation-row' },
          allow,
          deny,
        ),
      )
      expect(requested).toContain('data-testid="confirmation-row"')
      // The row's own alignment classes survive next to the caller's class.
      expect(requested).toContain(
        'flex items-center justify-end gap-2 self-end',
      )
      expect(requested).toContain('pt-1')
      expect(requested).toContain('>Allow<')
      expect(requested).toContain('>Deny<')

      // Once answered, the shell renders but the action row is gone.
      const answered = renderInsideConfirmation(
        'approval-responded',
        createElement(ConfirmationActions, null, allow),
      )
      expect(answered).toContain('role="alert"')
      expect(answered).not.toContain('>Allow<')
    })
  })

  describe('ConfirmationAction', () => {
    it('renders its children on a compact button of type="button", with caller props overriding the default', () => {
      const html = renderToString(
        createElement(ConfirmationAction, null, 'Allow'),
      )
      expect(html).toContain('<button')
      expect(html).toContain('type="button"')
      // The compact sizing classes from this wrapper survive the merge.
      expect(html).toContain('h-8')
      expect(html).toContain('px-3')
      expect(html).toContain('>Allow<')

      // A caller-supplied type wins over the wrapper default.
      const overridden = renderToString(
        createElement(ConfirmationAction, { type: 'submit' }, 'Send'),
      )
      expect(overridden).toContain('type="submit"')
      expect(overridden).not.toContain('type="button"')
      expect(overridden).toContain('>Send<')
    })
  })
})
