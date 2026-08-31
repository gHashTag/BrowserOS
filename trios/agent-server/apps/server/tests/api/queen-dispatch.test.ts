import { afterEach, describe, expect, it } from 'bun:test'
import {
  missingProviderRefusal,
  resolveWorkerProvider,
  workspaceRoot,
} from '../../src/api/services/queen-dispatch'

const KEYS = [
  'ZAI_API_KEY',
  'ZAI_API_KEY_2',
  'ZAI_API_KEY_3',
  'ZAI_API_KEY_4',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'TRIOS_QUEEN_WORKER_MODEL',
]

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe('queen dispatch precheck', () => {
  // The state of the deployment on 2026-08-29, measured rather than assumed:
  // the live /chat answered `z.ai provider requires apiKey`. Dispatch must
  // refuse BEFORE it cuts a worktree, or every round leaves a branch and a
  // directory behind for a bee that was never going to run.
  it('refuses when the deployment has no provider credential', () => {
    expect(resolveWorkerProvider()).toBeNull()
  })

  it('names every variable that would fix it, and who may set it', () => {
    const refusal = missingProviderRefusal()
    for (const key of KEYS.filter((k) => k.endsWith('API_KEY'))) {
      expect(refusal).toContain(key)
    }
    expect(refusal).toContain('operator')
  })

  // An empty string is the trap this repository has already been caught by:
  // `~/.trios/config.json` holds two provider keys with zero-length values, so
  // every check for the NAME passes and every read of the VALUE gets nothing.
  it('treats an empty key as absent, not as configured', () => {
    process.env.ZAI_API_KEY = ''
    expect(resolveWorkerProvider()).toBeNull()
  })

  it('takes the first provider in preference order', () => {
    process.env.OPENAI_API_KEY = 'x'
    expect(resolveWorkerProvider()?.provider).toBe('openai')
    process.env.ZAI_API_KEY = 'y'
    expect(resolveWorkerProvider()?.provider).toBe('zai')
  })

  it('lets the deployment pin a model without pinning a provider', () => {
    process.env.ANTHROPIC_API_KEY = 'x'
    process.env.TRIOS_QUEEN_WORKER_MODEL = 'claude-opus-4-1'
    const chosen = resolveWorkerProvider()
    expect(chosen?.provider).toBe('anthropic')
    expect(chosen?.model).toBe('claude-opus-4-1')
  })

  it('roots the checkout under the workspace volume, not the app directory', () => {
    expect(workspaceRoot()).toBe('/workspace/BrowserOS')
  })

  // Four bees on one key share one rate limit, so the swarm's real ceiling
  // becomes whatever that key allows rather than what the Queen permits - and
  // the 429 arrives blamed on the work.
  describe('key rotation', () => {
    it('hands out the lowest key index nobody is holding', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      process.env.ZAI_API_KEY_3 = 'c'
      expect(resolveWorkerProvider([])?.keyIndex).toBe(0)
      expect(resolveWorkerProvider([0])?.keyIndex).toBe(1)
      expect(resolveWorkerProvider([0, 1])?.keyIndex).toBe(2)
      // A gap is filled rather than skipped past: bee 1 finished, its key is
      // free, and the next bee should take it instead of reaching for a fourth
      // that does not exist.
      expect(resolveWorkerProvider([0, 2])?.keyIndex).toBe(1)
    })

    it('reports exhaustion by name instead of reusing a key', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      const chosen = resolveWorkerProvider([0, 1])
      expect(chosen?.exhausted).toBe(2)
      expect(chosen?.apiKey).toBeUndefined()
    })

    // The trap this design exists to avoid. The four issues in flight when it
    // was written - 1176, 1216, 1240, 1244 - are ALL 0 mod 4, so an
    // issue-number hash would have put every bee on one key while looking like
    // rotation.
    it('does not distribute by issue number', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      process.env.ZAI_API_KEY_3 = 'c'
      process.env.ZAI_API_KEY_4 = 'd'
      const byIssue = [1176, 1216, 1240, 1244].map((n) => n % 4)
      expect(new Set(byIssue).size).toBe(1)
      const bySlot = [[], [0], [0, 1], [0, 1, 2]].map(
        (taken) => resolveWorkerProvider(taken)?.keyIndex,
      )
      expect(new Set(bySlot).size).toBe(4)
    })

    // A platform variable saved with an empty box leaves the NAME behind. A
    // rotation that counted names would hand a bee a key that authenticates
    // with nothing.
    it('does not count an empty key as a key', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = ''
      process.env.ZAI_API_KEY_3 = 'c'
      expect(resolveWorkerProvider([])?.keyCount).toBe(2)
      expect(resolveWorkerProvider([0])?.apiKey).toBe('c')
    })
  })
})
