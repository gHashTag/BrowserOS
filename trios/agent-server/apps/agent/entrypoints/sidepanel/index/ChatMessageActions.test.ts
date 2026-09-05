import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatMessageActions } from './ChatMessageActions'

// Contract suite for the exports of ChatMessageActions.tsx.
//
// Exports not exercised: none. The module's single export (ChatMessageActions)
// is rendered below through react-dom/server, so the suite needs no DOM host,
// no network, no database and no container. Pointer-driven flows of the same
// export (copy to clipboard, opening the dislike dialog, submit and cancel)
// additionally require a DOM event host, which no test group in this
// repository provides; they belong to the same export and are out of reach
// here without a browser, not silently dropped from the module's coverage.

const baseProps = {
  messageId: 'msg-1',
  messageText: 'A response worth rating',
  liked: false,
  disliked: false,
  onClickLike: () => {},
  onClickDislike: () => {},
}

const render = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ChatMessageActions, { ...baseProps, ...overrides }),
  )

describe('ChatMessageActionsTsxContract', () => {
  it('ChatMessageActions shows copy with like and dislike while feedback is pending, and a submitted marker instead once liked or disliked', () => {
    const pending = render()
    expect(pending).toContain('Copy')
    expect(pending).toContain('Like')
    expect(pending).toContain('Dislike')
    expect(pending).not.toContain('Feedback submitted')
    // The dislike dialog stays closed until the user opens it.
    expect(pending).not.toContain('What went wrong?')

    const liked = render({ liked: true })
    expect(liked).toContain('Feedback submitted')
    expect(liked).not.toContain('Like')
    expect(liked).not.toContain('Dislike')
    expect(liked).toContain('Copy')

    const disliked = render({ disliked: true })
    expect(disliked).toContain('Feedback submitted')
    expect(disliked).not.toContain('Like')
    expect(disliked).not.toContain('Dislike')
    expect(disliked).toContain('Copy')
  })
})
