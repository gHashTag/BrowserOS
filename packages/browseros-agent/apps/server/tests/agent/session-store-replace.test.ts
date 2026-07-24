import { describe, expect, it, mock, spyOn } from 'bun:test'
import { type AgentSession, SessionStore } from '../../src/agent/session-store'
import { logger } from '../../src/lib/logger'

type ReplaceSession = (
  conversationId: string,
  expectedSession: AgentSession,
  replacement: AgentSession,
) => boolean

function createSession(fingerprint: string): AgentSession {
  return {
    agent: {
      dispose: mock(async () => {}),
    } as unknown as AgentSession['agent'],
    executionFingerprint: fingerprint,
  }
}

function getReplace(store: SessionStore): ReplaceSession | undefined {
  const replace = (
    store as unknown as {
      replace?: ReplaceSession
    }
  ).replace
  expect(typeof replace).toBe('function')
  return replace
}

describe('SessionStore atomic session replacement', () => {
  it('replaces only the exact expected session', () => {
    const store = new SessionStore()
    const expected = createSession('expected')
    const stale = createSession('stale')
    const replacement = createSession('replacement')
    store.set('conversation-1', expected)
    const replace = getReplace(store)
    if (!replace) return

    expect(replace.call(store, 'conversation-1', stale, replacement)).toBe(
      false,
    )
    expect(store.get('conversation-1')).toBe(expected)
    expect(replace.call(store, 'conversation-1', expected, replacement)).toBe(
      true,
    )
    expect(store.get('conversation-1')).toBe(replacement)
  })

  it('refuses replacement while deletion is pending', async () => {
    let resolveDisposal: () => void = () => {}
    const disposal = new Promise<void>((resolve) => {
      resolveDisposal = resolve
    })
    const expected = createSession('expected')
    expected.agent.dispose = mock(() => disposal)
    const replacement = createSession('replacement')
    const store = new SessionStore()
    store.set('conversation-1', expected)
    const replace = getReplace(store)
    if (!replace) {
      resolveDisposal()
      await store.delete('conversation-1')
      return
    }

    const deletion = store.delete('conversation-1')
    expect(replace.call(store, 'conversation-1', expected, replacement)).toBe(
      false,
    )
    expect(store.get('conversation-1')).toBe(expected)
    resolveDisposal()
    expect(await deletion).toBe(true)
    expect(store.get('conversation-1')).toBeUndefined()
  })

  it('does not let a logger failure make a successful swap look failed', () => {
    const store = new SessionStore()
    const expected = createSession('expected')
    const replacement = createSession('replacement')
    store.set('conversation-1', expected)
    const replace = getReplace(store)
    if (!replace) return
    const loggerFailure = spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('logger-failure-sentinel')
    })

    try {
      expect(() =>
        replace.call(store, 'conversation-1', expected, replacement),
      ).not.toThrow()
      expect(store.get('conversation-1')).toBe(replacement)
    } finally {
      loggerFailure.mockRestore()
    }
  })
})
