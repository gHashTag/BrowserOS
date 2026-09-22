import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  beesRunElsewhere,
  classifyQuotaExhaustion,
  closeDispatch,
  committedFileCount,
  committedFiles,
  configuredWorkerCapacity,
  configuredWorkerLanesPerCredential,
  dispatchBee,
  drain,
  endpointPoolProblems,
  finishDispatch,
  MAX_KEYS_PER_POOL,
  MAX_POOL_NUMBER,
  missingProviderRefusal,
  POOL_KEY_STRIDE,
  prepareWorktree,
  queenWorkerLimit,
  reapWorktrees,
  recordDispatch,
  resolveWorkerProvider,
  runClaimedBee,
  setDurableCloseListener,
  workerCapacityBreakdown,
  workerProviderForKeyIndex,
  workspaceRoot,
} from '../../src/api/services/queen-dispatch'
import { resetYoungBees } from '../../src/api/services/queen-resources'
import { logger } from '../../src/lib/logger'

const GENERIC_WORKER_KEYS = [
  'TRIOS_QUEEN_WORKER_API_KEY',
  ...Array.from(
    { length: 15 },
    (_, index) => `TRIOS_QUEEN_WORKER_API_KEY_${index + 2}`,
  ),
]

// Additional endpoint pools (TRIOS_QUEEN_WORKER_POOL_<n>_*). Listed for the same
// reason as every other name here: one process runs every api test file, and a
// pool left behind makes the next file's "one endpoint" case read two.
const POOL_VARIABLES = [2, 3].flatMap((pool) => [
  ...['BASE_URL', 'MODEL', 'PROVIDER', 'CONTEXT', 'API_KEY'].map(
    (name) => `TRIOS_QUEEN_WORKER_POOL_${pool}_${name}`,
  ),
  ...[2, 3, 4].map(
    (index) => `TRIOS_QUEEN_WORKER_POOL_${pool}_API_KEY_${index}`,
  ),
])

const KEYS = [
  'ZAI_API_KEY',
  'ZAI_API_KEY_2',
  'ZAI_API_KEY_3',
  'ZAI_API_KEY_4',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  // #1308's factorisation table configures a second OpenAI slot. Bun runs the
  // api test files in ONE process, so a suffixed name missing from this list
  // is not a tidiness problem: it survives into the next FILE and makes a
  // "nothing is connected" case read one connected credential.
  'OPENAI_API_KEY_2',
  ...GENERIC_WORKER_KEYS,
  'TRIOS_QUEEN_WORKER_PROVIDER',
  'TRIOS_QUEEN_WORKER_BASE_URL',
  'TRIOS_QUEEN_WORKER_MODEL',
  'TRIOS_QUEEN_WORKER_CONTEXT',
  'TRIOS_QUEEN_WORKER_LANES_PER_KEY',
  'TRIOS_QUEEN_MAX_WORKERS',
  // Every variable the container guard reads. One of them left in a developer's
  // shell moves the line the fixtures below are written against, and a fixture
  // that stops being "full" walks past the gate into a real `prepareWorktree`.
  'TRIOS_QUEEN_RESOURCE_GUARD',
  'TRIOS_QUEEN_BEE_MEMORY_MB',
  'TRIOS_QUEEN_MEMORY_HEADROOM_PERCENT',
  'TRIOS_QUEEN_BEE_WARMUP_SECONDS',
  'TRIOS_QUEEN_BEE_DISK_MB',
  'TRIOS_QUEEN_DISK_HEADROOM_PERCENT',
  'TRIOS_QUEEN_MEMORY_LIMIT_MB',
  'TRIOS_QUEEN_BEES_RUN_ELSEWHERE',
  // The far end of the key list (MAX_KEYS_PER_POOL) and the first name past it.
  'TRIOS_QUEEN_WORKER_API_KEY_17',
  'TRIOS_QUEEN_WORKER_API_KEY_1024',
  'TRIOS_QUEEN_WORKER_API_KEY_4096',
  // Names that look like key variables and are not: see the suffix rule.
  'TRIOS_QUEEN_WORKER_API_KEY_02',
  'TRIOS_QUEEN_WORKER_API_KEY_1',
  'TRIOS_QUEEN_WORKER_API_KEY_x',
  // A ninth pool, and one whose number no durable index can address.
  'TRIOS_QUEEN_WORKER_POOL_9_BASE_URL',
  'TRIOS_QUEEN_WORKER_POOL_9_MODEL',
  'TRIOS_QUEEN_WORKER_POOL_9_API_KEY',
  'TRIOS_QUEEN_WORKER_POOL_300000_BASE_URL',
  'TRIOS_QUEEN_WORKER_POOL_300000_MODEL',
  'TRIOS_QUEEN_WORKER_POOL_300000_API_KEY',
  'TRIOS_ZAI_CONCURRENCY_PER_KEY',
  ...POOL_VARIABLES,
]

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

// The suite must pass under the environment #1293's independent test describes:
// `ZAI_API_KEY=x ZAI_API_KEY_2=x bun test ...`. Variables present when the
// process starts would otherwise walk into the FIRST case, which asserts that a
// deployment with no credential refuses - and clearing only between cases is
// one case too late. Clearing here also keeps any real secret sitting in the
// runner's environment out of every assertion below, so a failure can never
// print one.
beforeAll(() => {
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
    for (const key of [
      'ZAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'MOONSHOT_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      expect(refusal).toContain(key)
    }
    expect(refusal).not.toContain('TRIOS_QUEEN_WORKER_API_KEY')
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

  describe('configured OpenAI-compatible endpoint key pool', () => {
    /**
     * Production contract measured on 2026-09-13: Railway held seven named,
     * non-empty generic worker-key variables with six distinct values, aimed
     * at the ordinary Z.ai Model API. Capacity, selection, and the provider
     * sent to /chat must all describe that same six-key pool. A duplicated
     * value is one credential, and no key value may enter public telemetry.
     */
    it('connects six distinct credentials behind the four-worker policy ceiling', () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://api.z.ai/api/paas/v4'
      process.env.TRIOS_QUEEN_WORKER_MODEL = 'glm-4.5-flash'

      const configured = ['a', 'b', 'c', 'c', 'd', 'e', 'f']
      configured.forEach((value, index) => {
        process.env[GENERIC_WORKER_KEYS[index]] = value
      })

      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 6,
        lanesPerCredential: 1,
        effectiveCapacity: 4,
      })
      const choices = Array.from({ length: 6 }, (_, occupied) =>
        resolveWorkerProvider(Array.from({ length: occupied }, (_, i) => i)),
      )
      expect(choices.map((choice) => choice?.provider)).toEqual(
        Array(6).fill('zai'),
      )
      expect(choices.map((choice) => choice?.keyIndex)).toEqual([
        0, 1, 2, 3, 4, 5,
      ])
      expect(choices.map((choice) => choice?.keyCount)).toEqual(
        Array(6).fill(6),
      )
      expect(resolveWorkerProvider([0, 1, 2, 3, 4, 5])?.exhausted).toBe(6)
    })

    it('continues after the last assigned key so all six participate across four-Bee waves', () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://api.z.ai/api/paas/v4'
      process.env.TRIOS_QUEEN_WORKER_MODEL = 'glm-4.5-flash'
      ;['a', 'b', 'c', 'd', 'e', 'f'].forEach((value, index) => {
        process.env[GENERIC_WORKER_KEYS[index]] = value
      })

      const wave = (after: number | undefined) => {
        const selected: number[] = []
        let cursor = after
        for (let bee = 0; bee < 4; bee++) {
          const choice = resolveWorkerProvider(selected, cursor)
          expect(choice?.apiKey).toBeDefined()
          selected.push(choice?.keyIndex ?? -1)
          cursor = choice?.keyIndex
        }
        return { selected, cursor }
      }

      const first = wave(undefined)
      const second = wave(first.cursor)
      expect(first.selected).toEqual([0, 1, 2, 3])
      expect(second.selected).toEqual([4, 5, 0, 1])
    })

    it('does not invent a credential for a remote endpoint with no API key', () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://api.z.ai/api/paas/v4'
      process.env.TRIOS_QUEEN_WORKER_MODEL = 'glm-4.5-flash'
      // An explicit endpoint is authoritative. A legacy provider key must not
      // silently bypass it and send the turn to a different API.
      process.env.ZAI_API_KEY = 'legacy-key-for-another-route'

      expect(resolveWorkerProvider()).toBeNull()
      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 0,
        lanesPerCredential: 1,
        effectiveCapacity: 0,
      })
      expect(missingProviderRefusal()).toContain('TRIOS_QUEEN_WORKER_API_KEY')
      expect(missingProviderRefusal()).not.toContain('ZAI_API_KEY')
    })

    it('names the generic endpoint variable when every configured key is busy', async () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://api.z.ai/api/paas/v4'
      process.env.TRIOS_QUEEN_WORKER_API_KEY = 'a'
      process.env.TRIOS_QUEEN_WORKER_API_KEY_2 = 'b'
      const pool = {
        query: async () => ({ rowCount: 1, rows: [] }),
      } as unknown as Pool

      const outcome = await dispatchBee(pool, 1308, 'brief', [], [0, 1])

      expect(outcome.started).toBe(false)
      expect(outcome.detail).toContain('TRIOS_QUEEN_WORKER_API_KEY_3')
      expect(outcome.detail).not.toContain('ZAI_API_KEY_3')
    })

    it('keeps an explicitly local endpoint as one measured lane on any hostname', () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'ollama'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'http://ollama:11434/v1'

      expect(resolveWorkerProvider()?.provider).toBe('ollama')
      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 1,
        lanesPerCredential: 1,
        effectiveCapacity: 1,
      })
    })

    it('reports no capacity for an unsupported endpoint provider', () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'not-a-provider'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://example.invalid/v1'
      process.env.TRIOS_QUEEN_WORKER_API_KEY = 'real-but-unroutable'

      expect(resolveWorkerProvider()).toBeNull()
      expect(workerCapacityBreakdown().effectiveCapacity).toBe(0)
      expect(missingProviderRefusal()).toContain('TRIOS_QUEEN_WORKER_PROVIDER')
    })
  })

  /**
   * Measured on 2026-09-17: the deployment held ten working Z.ai keys and three
   * working NVIDIA keys, and only the first ten could carry a bee, because one
   * endpoint URL was the whole model and a key is only as good as the URL the
   * bee sends it to. A numbered pool is a second endpoint with its own model
   * and its own keys; the first pool is the unnumbered variables, unchanged.
   */
  describe('additional endpoint pools', () => {
    const ZAI_URL = 'https://api.z.ai/api/paas/v4'
    const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1'
    const NVIDIA_MODEL = 'nvidia/nemotron-3-super-120b-a12b'

    const firstPool = (...keys: string[]) => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = ZAI_URL
      process.env.TRIOS_QUEEN_WORKER_MODEL = 'glm-4.5-flash'
      process.env.TRIOS_QUEEN_WORKER_CONTEXT = '65536'
      keys.forEach((value, index) => {
        process.env[GENERIC_WORKER_KEYS[index]] = value
      })
    }
    const secondPool = (...keys: string[]) => {
      process.env.TRIOS_QUEEN_WORKER_POOL_2_BASE_URL = `${NVIDIA_URL}/`
      process.env.TRIOS_QUEEN_WORKER_POOL_2_MODEL = NVIDIA_MODEL
      process.env.TRIOS_QUEEN_WORKER_POOL_2_CONTEXT = '131072'
      keys.forEach((value, index) => {
        const name =
          index === 0
            ? 'TRIOS_QUEEN_WORKER_POOL_2_API_KEY'
            : `TRIOS_QUEEN_WORKER_POOL_2_API_KEY_${index + 1}`
        process.env[name] = value
      })
    }

    it('sends each key to the endpoint of its own pool', () => {
      firstPool('z1', 'z2', 'z3')
      secondPool('n1', 'n2')
      process.env.TRIOS_QUEEN_MAX_WORKERS = '16'

      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 5,
        lanesPerCredential: 1,
        effectiveCapacity: 5,
      })
      const taken: number[] = []
      const choices = Array.from({ length: 5 }, () => {
        const choice = resolveWorkerProvider([...taken])
        taken.push(choice?.keyIndex ?? -1)
        return choice
      })
      // The first pool keeps the indices it has always had; pool 2 starts at
      // the stride, so rows written before this change still mean the same key.
      expect(choices.map((choice) => choice?.keyIndex)).toEqual([
        0,
        1,
        2,
        POOL_KEY_STRIDE,
        POOL_KEY_STRIDE + 1,
      ])
      expect(choices.map((choice) => choice?.apiKey)).toEqual([
        'z1',
        'z2',
        'z3',
        'n1',
        'n2',
      ])
      expect(choices[0]).toMatchObject({
        provider: 'zai',
        baseUrl: ZAI_URL,
        model: 'glm-4.5-flash',
        contextWindow: 65536,
        keyCount: 3,
        poolNumber: 1,
        poolCount: 2,
      })
      // A Z.ai URL with an NVIDIA key is a 401 blamed on the work. Everything
      // that travels to /chat comes from the SAME pool as the key.
      expect(choices[3]).toMatchObject({
        provider: 'openai-compatible',
        baseUrl: NVIDIA_URL,
        model: NVIDIA_MODEL,
        contextWindow: 131072,
        keyCount: 2,
        poolNumber: 2,
        poolCount: 2,
      })
      expect(resolveWorkerProvider(taken)?.exhausted).toBe(5)
    })

    it('rotates across pools after the last durable assignment', () => {
      firstPool('z1', 'z2')
      secondPool('n1', 'n2')

      expect(resolveWorkerProvider([], 1)?.keyIndex).toBe(POOL_KEY_STRIDE)
      expect(resolveWorkerProvider([], POOL_KEY_STRIDE)?.keyIndex).toBe(
        POOL_KEY_STRIDE + 1,
      )
      expect(resolveWorkerProvider([], POOL_KEY_STRIDE + 1)?.keyIndex).toBe(0)
      // A cursor naming a key that is no longer connected starts from the top
      // instead of being read as a position in a list it was never part of.
      expect(resolveWorkerProvider([], 2 * POOL_KEY_STRIDE + 7)?.keyIndex).toBe(
        0,
      )
    })

    it('gives every credential of every pool one bee before any key carries two', () => {
      firstPool('z1', 'z2')
      secondPool('n1')
      process.env.TRIOS_QUEEN_WORKER_LANES_PER_KEY = '2'
      process.env.TRIOS_QUEEN_MAX_WORKERS = '16'

      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 3,
        lanesPerCredential: 2,
        effectiveCapacity: 6,
      })
      const taken: number[] = []
      for (let bee = 0; bee < 6; bee++) {
        const choice = resolveWorkerProvider(
          [...taken],
          taken[taken.length - 1],
        )
        taken.push(choice?.keyIndex ?? -1)
      }
      expect(taken).toEqual([0, 1, POOL_KEY_STRIDE, 0, 1, POOL_KEY_STRIDE])
      expect(resolveWorkerProvider(taken)?.exhausted).toBe(6)
    })

    it('stays behind the policy ceiling however many pools are connected', () => {
      firstPool('z1', 'z2', 'z3')
      secondPool('n1', 'n2', 'n3')

      // TRIOS_QUEEN_MAX_WORKERS unset: the measured default of four.
      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 6,
        lanesPerCredential: 1,
        effectiveCapacity: 4,
      })
      expect(configuredWorkerCapacity()).toBe(4)
    })

    it('ignores a half-configured pool and says which variable is missing', () => {
      firstPool('z1')
      // A URL and keys but no model: the first pool's model name sent to
      // another provider is a 404, so the pool is not connected at all.
      process.env.TRIOS_QUEEN_WORKER_POOL_2_BASE_URL = NVIDIA_URL
      process.env.TRIOS_QUEEN_WORKER_POOL_2_API_KEY = 'n1'
      // Keys with no endpoint to send them to.
      process.env.TRIOS_QUEEN_WORKER_POOL_3_API_KEY = 'x1'

      expect(workerCapacityBreakdown().connectedCredentials).toBe(1)
      expect(resolveWorkerProvider([0])?.exhausted).toBe(1)
      const problems = endpointPoolProblems()
      expect(problems).toContain('TRIOS_QUEEN_WORKER_POOL_2_MODEL is not set')
      expect(problems.join(' ')).toContain('TRIOS_QUEEN_WORKER_POOL_3_BASE_URL')
      // Names only. A value in a diagnostic is a disclosure.
      expect(problems.join(' ')).not.toContain('n1')
      expect(problems.join(' ')).not.toContain('x1')
    })

    it('names an ignored pool when every connected key is busy', async () => {
      firstPool('z1')
      process.env.TRIOS_QUEEN_WORKER_POOL_2_BASE_URL = NVIDIA_URL
      process.env.TRIOS_QUEEN_WORKER_POOL_2_API_KEY = 'n1'
      const pool = {
        query: async () => ({ rowCount: 1, rows: [] }),
      } as unknown as Pool

      const outcome = await dispatchBee(pool, 1308, 'brief', [], [0])

      expect(outcome.started).toBe(false)
      expect(outcome.detail).toContain('TRIOS_QUEEN_WORKER_API_KEY_2')
      expect(outcome.detail).toContain(
        'TRIOS_QUEEN_WORKER_POOL_2_MODEL is not set',
      )
      expect(outcome.detail).not.toContain('n1')
    })

    it('refuses a pool whose provider is not a remote endpoint', () => {
      firstPool('z1')
      secondPool('n1')
      process.env.TRIOS_QUEEN_WORKER_POOL_2_PROVIDER = 'ollama'

      expect(workerCapacityBreakdown().connectedCredentials).toBe(1)
      expect(endpointPoolProblems().join(' ')).toContain(
        'TRIOS_QUEEN_WORKER_POOL_2_PROVIDER',
      )
    })

    it('counts one secret named by two pools as one credential', () => {
      firstPool('shared', 'z2')
      secondPool('shared', 'n2')

      expect(workerCapacityBreakdown().connectedCredentials).toBe(3)
      const second = resolveWorkerProvider([0, 1])
      // The first pool that names a secret keeps it; pool 2 offers only 'n2'.
      expect(second?.apiKey).toBe('n2')
      expect(second?.keyIndex).toBe(POOL_KEY_STRIDE)
      expect(second?.keyCount).toBe(1)
    })

    it('does not let a valid second pool take over from a first one with no key', () => {
      firstPool()
      secondPool('n1')

      // An explicit endpoint is authoritative, including its refusal.
      expect(resolveWorkerProvider()).toBeNull()
      expect(missingProviderRefusal()).toContain('TRIOS_QUEEN_WORKER_API_KEY')
    })

    it('keeps a local first endpoint as one measured lane and reads no pools', () => {
      process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'ollama'
      process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'http://ollama:11434/v1'
      secondPool('n1', 'n2')

      expect(resolveWorkerProvider()?.provider).toBe('ollama')
      expect(resolveWorkerProvider()?.poolCount).toBeUndefined()
      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 1,
        lanesPerCredential: 1,
        effectiveCapacity: 1,
      })
    })

    it('reads every suffixed key that exists, in numeric order', () => {
      firstPool('z1')
      // The loop used to end at 16, then at 1024. Both were bounds that said
      // nothing when they bound: the next variable was read by nothing. The
      // names are now read from the environment, so there is no next variable.
      process.env.TRIOS_QUEEN_WORKER_API_KEY_4096 = 'z4096'
      process.env.TRIOS_QUEEN_WORKER_API_KEY_17 = 'z17'
      process.env.TRIOS_QUEEN_WORKER_API_KEY_1024 = 'z1024'
      process.env.TRIOS_QUEEN_MAX_WORKERS = '16'

      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 4,
        lanesPerCredential: 1,
        effectiveCapacity: 4,
      })
      // Numeric, not lexical: 17 before 1024 before 4096.
      expect(resolveWorkerProvider([0])?.apiKey).toBe('z17')
      expect(resolveWorkerProvider([0, 1])?.apiKey).toBe('z1024')
      expect(resolveWorkerProvider([0, 1, 2])?.apiKey).toBe('z4096')
      expect(resolveWorkerProvider([0, 1, 2, 3])?.exhausted).toBe(4)
    })

    it('ignores names that only look like key variables', () => {
      firstPool('z1')
      // `_1` would be a second name for the unsuffixed key, `_02` a second name
      // for `_2`, `_x` no number at all. Guessing at any of them is how one
      // secret becomes two slots.
      process.env.TRIOS_QUEEN_WORKER_API_KEY_1 = 'not-a-slot'
      process.env.TRIOS_QUEEN_WORKER_API_KEY_02 = 'not-a-slot-either'
      process.env.TRIOS_QUEEN_WORKER_API_KEY_x = 'nor-this'

      expect(workerCapacityBreakdown().connectedCredentials).toBe(1)
    })

    it("cuts a pool where the next pool's durable index begins", () => {
      firstPool('z1')
      const extra = Array.from(
        { length: MAX_KEYS_PER_POOL + 5 },
        (_, index) => `TRIOS_QUEEN_WORKER_API_KEY_${index + 2}`,
      )
      for (const [index, name] of extra.entries()) {
        process.env[name] = `z${index + 2}`
      }
      try {
        // Not a policy: key_index of pool 2 starts at POOL_KEY_STRIDE, and that
        // stride is already written in production rows.
        expect(workerCapacityBreakdown().connectedCredentials).toBe(
          MAX_KEYS_PER_POOL,
        )
        expect(MAX_KEYS_PER_POOL).toBe(POOL_KEY_STRIDE - 1)
      } finally {
        for (const name of extra) delete process.env[name]
      }
    })

    it('reads a ninth pool, because pools are discovered and not counted to eight', () => {
      firstPool('z1')
      process.env.TRIOS_QUEEN_WORKER_POOL_9_BASE_URL = NVIDIA_URL
      process.env.TRIOS_QUEEN_WORKER_POOL_9_MODEL = NVIDIA_MODEL
      process.env.TRIOS_QUEEN_WORKER_POOL_9_API_KEY = 'n9'

      const choice = resolveWorkerProvider([0])
      expect(choice?.apiKey).toBe('n9')
      expect(choice?.poolNumber).toBe(9)
      expect(choice?.keyIndex).toBe(8 * POOL_KEY_STRIDE)
      expect(endpointPoolProblems()).toEqual([])
    })

    it('says so when a pool number cannot be named by a durable index', () => {
      firstPool('z1')
      process.env.TRIOS_QUEEN_WORKER_POOL_300000_BASE_URL = NVIDIA_URL
      process.env.TRIOS_QUEEN_WORKER_POOL_300000_MODEL = NVIDIA_MODEL
      process.env.TRIOS_QUEEN_WORKER_POOL_300000_API_KEY = 'far'

      expect(MAX_POOL_NUMBER).toBeLessThan(300000)
      expect(workerCapacityBreakdown().connectedCredentials).toBe(1)
      expect(endpointPoolProblems().join(' ')).toContain(
        'TRIOS_QUEEN_WORKER_POOL_300000_BASE_URL',
      )
      expect(endpointPoolProblems().join(' ')).not.toContain('far')
    })

    it('lets the credentials bind rather than a number nobody chose', () => {
      firstPool(...Array.from({ length: 16 }, (_, index) => `z${index + 1}`))
      process.env.TRIOS_QUEEN_WORKER_API_KEY_17 = 'z17'
      process.env.TRIOS_QUEEN_MAX_WORKERS = '64'

      // Seventeen credentials under an operator ceiling of sixty-four. This
      // used to answer sixteen, and sixteen was not a number anyone had
      // chosen for this deployment - it was the policy clamp, sitting below
      // the credentials that had been paid for and saying nothing when it
      // bound. The credentials are the limit here, and they say so.
      expect(workerCapacityBreakdown()).toEqual({
        connectedCredentials: 17,
        lanesPerCredential: 1,
        effectiveCapacity: 17,
      })
    })

    it("lets the operator's number answer when the credentials are there to carry it", () => {
      // This used to clamp at 1024. As a typo guard that protected little: an
      // operator who meant 50 and typed 5000 over thousands of connected lanes
      // got 1024 bees instead, and either number ends a container sized for
      // fifty. What bounds a mistyped value is the credential list.
      firstPool('z1')
      const extra = Array.from(
        { length: MAX_KEYS_PER_POOL - 1 },
        (_, index) => `TRIOS_QUEEN_WORKER_API_KEY_${index + 2}`,
      )
      for (const [index, name] of extra.entries()) {
        process.env[name] = `z${index + 2}`
      }
      process.env.TRIOS_QUEEN_MAX_WORKERS = '5000'
      try {
        expect(workerCapacityBreakdown()).toEqual({
          connectedCredentials: MAX_KEYS_PER_POOL,
          lanesPerCredential: 1,
          effectiveCapacity: 5000,
        })
      } finally {
        for (const name of extra) delete process.env[name]
      }
    })

    it('still refuses a value that is not a number of bees at all', () => {
      process.env.TRIOS_QUEEN_MAX_WORKERS = '99999999999'
      expect(queenWorkerLimit()).toBe(1_000_000)
      process.env.TRIOS_QUEEN_MAX_WORKERS = 'many'
      expect(queenWorkerLimit()).toBe(4)
      process.env.TRIOS_QUEEN_MAX_WORKERS = '0'
      expect(queenWorkerLimit()).toBe(4)
      delete process.env.TRIOS_QUEEN_MAX_WORKERS
      expect(queenWorkerLimit()).toBe(4)
    })

    it('keeps a whole pool below the stride that separates pools', () => {
      // The durable index of pool n starts at (n - 1) * POOL_KEY_STRIDE. If a
      // pool could hold that many keys, its last key would BE pool n + 1's first.
      expect(MAX_KEYS_PER_POOL).toBeLessThan(POOL_KEY_STRIDE)
    })

    it('leaves a single endpoint exactly as it was', () => {
      firstPool('z1', 'z2')

      const choice = resolveWorkerProvider([0])
      expect(choice?.keyIndex).toBe(1)
      expect(choice?.poolNumber).toBeUndefined()
      expect(choice?.poolCount).toBeUndefined()
      expect(endpointPoolProblems()).toEqual([])
    })

    it('keeps the breakdown closed when several pools are connected', () => {
      firstPool('planted-secret-z')
      secondPool('planted-secret-n')
      const breakdown = workerCapacityBreakdown() as unknown as Record<
        string,
        unknown
      >

      expect(Object.keys(breakdown).sort()).toEqual([
        'connectedCredentials',
        'effectiveCapacity',
        'lanesPerCredential',
      ])
      const serialized = JSON.stringify(breakdown)
      expect(serialized).not.toContain('planted-secret')
      expect(serialized).not.toContain('POOL_2')
      expect(serialized).not.toContain('nvidia')
    })
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

    it('spreads Max-plan lanes across keys before reusing either key', () => {
      process.env.ZAI_API_KEY = 'a'
      process.env.ZAI_API_KEY_2 = 'b'
      process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
      expect(configuredWorkerLanesPerCredential()).toBe(2)
      expect(configuredWorkerCapacity()).toBe(4)

      const first = resolveWorkerProvider([])
      const second = resolveWorkerProvider([0])
      const third = resolveWorkerProvider([0, 1])
      const fourth = resolveWorkerProvider([0, 1, 0])
      const exhausted = resolveWorkerProvider([0, 1, 0, 1])

      expect([
        first?.keyIndex,
        second?.keyIndex,
        third?.keyIndex,
        fourth?.keyIndex,
      ]).toEqual([0, 1, 0, 1])
      expect([
        first?.laneIndex,
        second?.laneIndex,
        third?.laneIndex,
        fourth?.laneIndex,
      ]).toEqual([0, 0, 1, 1])
      expect(exhausted?.exhausted).toBe(4)
      expect(exhausted?.apiKey).toBeUndefined()
    })

    it('fails safe at one lane and bounds an operator override to four', () => {
      expect(configuredWorkerLanesPerCredential(undefined)).toBe(1)
      expect(configuredWorkerLanesPerCredential('0')).toBe(1)
      expect(configuredWorkerLanesPerCredential('not-a-number')).toBe(1)
      expect(configuredWorkerLanesPerCredential('99')).toBe(4)
    })

    it('does not apply the Z.ai lane override to another provider', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-a'
      process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
      expect(configuredWorkerCapacity()).toBe(1)
      expect(resolveWorkerProvider([0])?.exhausted).toBe(1)
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

    // #1293. A variable duplicated across names - the platform's copy button,
    // an env block pasted twice - is one account with one rate limit. Counting
    // it twice makes the dashboard promise parallel capacity that shares a
    // single limit, and the second "free" slot hands a bee a secret its
    // sibling is already spending.
    describe('duplicate secrets', () => {
      it('reports one slot when both variables hold the same key', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        expect(configuredWorkerCapacity()).toBe(1)
      })

      it('reports two slots for two distinct keys', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'b'
        expect(configuredWorkerCapacity()).toBe(2)
      })

      // The fixture from the issue: a, a, b - exactly two worker slots.
      it('counts a, a and b as exactly two worker slots', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        process.env.ZAI_API_KEY_3 = 'b'
        expect(configuredWorkerCapacity()).toBe(2)
      })

      // Selection must agree with capacity. If the count says two but the
      // rotation still had three indices, the dashboard's "one free key" and
      // the dispatch's key 3 would be two different stories about the same
      // two secrets - and the third story would hand out a duplicate.
      it('never assigns the same secret as two independent keys', () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        process.env.ZAI_API_KEY_3 = 'b'
        const first = resolveWorkerProvider([])
        expect(first?.keyCount).toBe(2)
        const second = resolveWorkerProvider([first?.keyIndex ?? 0])
        expect(second?.keyIndex).toBe(1)
        expect(second?.apiKey).not.toBe(first?.apiKey)
        // There is no third secret, so a third bee is told the pool is
        // exhausted rather than handed a copy of one already in flight.
        const third = resolveWorkerProvider([0, 1])
        expect(third?.exhausted).toBe(2)
        expect(third?.apiKey).toBeUndefined()
      })

      // Deduplication must not reorder or un-skip: the unsuffixed variable
      // stays index 0 (first occurrence wins), and an empty value stays
      // absent even when duplicates surround it.
      it('keeps the unsuffixed key first and empty values absent', () => {
        process.env.ZAI_API_KEY = 'b'
        process.env.ZAI_API_KEY_2 = ''
        process.env.ZAI_API_KEY_3 = 'a'
        process.env.ZAI_API_KEY_4 = 'b'
        const first = resolveWorkerProvider([])
        expect(first?.keyCount).toBe(2)
        expect(first?.keyIndex).toBe(0)
        expect(resolveWorkerProvider([0])?.apiKey).toBe('a')
        expect(resolveWorkerProvider([0, 1])?.exhausted).toBe(2)
      })
    })
  })
})

/**
 * A key is free and a provider answers - and the container may still have no
 * room. Measured on 2026-09-17: 24 GB, about 0.85 GB a bee, thirty-four lanes
 * connected. Nothing in dispatch asked the container before this.
 */
describe('the container is asked before a worktree is cut', () => {
  // Decimal, like every number the guard prints.
  const GB = 1_000_000_000
  const full = () =>
    ({
      kind: 'measured',
      usedBytes: 21.2 * GB,
      limitBytes: 24 * GB,
      source: 'cgroup v2',
      limitSource: 'cgroup',
    }) as const
  const calm = () => ({ ...full(), usedBytes: 3 * GB })
  const roomy = () => ({ totalBytes: 50 * GB, freeBytes: 19 * GB })
  const oneFreeKey = () => {
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
    process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://api.z.ai/api/paas/v4'
    process.env.TRIOS_QUEEN_WORKER_API_KEY = 'a'
  }
  // An EMPTY directory stands where the workspace would be, for every case. A
  // fixture that stops reading as "full" - a variable in somebody's shell moved
  // the line - walks past the gate into the real `prepareWorktree`, and on the
  // container the default workspace is the LIVE checkout: a unit test would
  // fetch there and cut a worktree in it.
  let previousWorkspace: string | undefined
  beforeEach(() => {
    previousWorkspace = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = realpathSync(
      mkdtempSync(join(tmpdir(), 'queen-guard-')),
    )
  })
  afterEach(() => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = previousWorkspace
    // Module state, shared by every test file in the bun process.
    resetYoungBees()
  })

  const recordingPool = (running: number[] = []) => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values })
        return /finished_at IS NULL/.test(text)
          ? {
              rowCount: running.length,
              rows: running.map((issue) => ({ issue })),
            }
          : { rowCount: 1, rows: [] }
      },
    } as unknown as Pool
    return { pool, queries }
  }

  it('refuses on memory with the numbers, cuts nothing, and books nothing against the issue', async () => {
    oneFreeKey()
    const { pool, queries } = recordingPool()
    let reaped = 0

    const outcome = await dispatchBee(
      pool,
      1500,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        memory: full,
        volume: roomy,
        reap: async () => {
          reaped += 1
          return {
            before: 0,
            after: 0,
            removed: [],
            keptDirty: [],
            keptRunning: [],
            refused: [],
          }
        },
      },
    )

    expect(outcome.started).toBe(false)
    expect(outcome.detail).toMatch(
      /^container memory is 21\.2 GB of 24\.0 GB in use/,
    )
    // Tagged with the guard's own sentence, because the report may quote this
    // refusal and no other.
    expect(outcome.room?.resource).toBe('memory')
    expect(outcome.detail.startsWith(`${outcome.room?.summary}. `)).toBe(true)
    // Memory cannot be freed by reaping, so the reaper is not even asked.
    expect(reaped).toBe(0)
    // It says something about the CONTAINER, and once the swarm is memory-bound
    // it is how nearly every round ends. A row per round would archive history
    // and wipe the issue's last attempt for a reason that is not the issue's.
    expect(queries.filter((q) => /queen_dispatch/.test(q.text))).toEqual([])
  })

  it('gives the disk one reap that protects running bees and its own tree, then names what was kept', async () => {
    oneFreeKey()
    const { pool } = recordingPool([7, 12])
    const calls: Array<{
      protect?: ReadonlySet<string>
      high?: number
      low?: number
    }> = []

    const outcome = await dispatchBee(
      pool,
      1501,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        memory: calm,
        volume: () => ({ totalBytes: 50 * GB, freeBytes: 5.1 * GB }),
        reap: async (opts = {}) => {
          calls.push(opts)
          return {
            before: 90,
            after: 90,
            removed: ['/w/.worktrees/queen-3'],
            keptDirty: [],
            keptRunning: ['/w/.worktrees/queen-7', '/w/.worktrees/queen-12'],
            refused: [],
          }
        },
      },
    )

    expect(calls).toHaveLength(1)
    // queen-1501 is the issue being dispatched. It is not running, so without
    // its own name here a re-dispatch could reap the tree it was about to reuse
    // and then cut it afresh with -B, dropping the last attempt's commits.
    expect([...(calls[0].protect ?? [])].sort()).toEqual([
      'queen-12',
      'queen-1501',
      'queen-7',
    ])
    // It starts whatever the percentage (high 0) and stops where the rule is
    // met - 2048 MiB + 5 GB of 50 GB is 85% used - not at the collector's 55%.
    expect(calls[0].high).toBe(0)
    expect(calls[0].low).toBe(85)
    expect(outcome.started).toBe(false)
    expect(outcome.room?.resource).toBe('disk')
    expect(outcome.detail).toContain(
      'has 5.1 GB free of 50.0 GB after a reap (1 removed; kept 0 with uncommitted work and 2 of running bees)',
    )
  })

  it('reaps nothing when it cannot find out who is running', async () => {
    // An unreadable registry used to mean "protect nobody": with twenty bees
    // running, that reap takes the clean trees out from under most of them.
    oneFreeKey()
    const pool = {
      query: async (text: string) => {
        if (/finished_at IS NULL/.test(text)) {
          throw new Error('Connection terminated unexpectedly')
        }
        return { rowCount: 1, rows: [] }
      },
    } as unknown as Pool
    let reaps = 0
    const outcome = await dispatchBee(
      pool,
      1505,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        memory: calm,
        volume: () => ({ totalBytes: 50 * GB, freeBytes: 5.1 * GB }),
        reap: async () => {
          reaps += 1
          throw new Error('the reaper must not be called')
        },
      },
    )
    expect(reaps).toBe(0)
    expect(outcome.started).toBe(false)
    expect(outcome.room?.resource).toBe('disk')
    expect(outcome.detail).toContain('(nothing reaped yet)')
  })

  it('starts the bee when the one reap made the room', async () => {
    // The half of the disk path that ADMITS. With it broken - the second
    // judgement reusing the first reading, or refusing whatever it reads - a
    // volume past the line can never recover: the gate sits in front of the only
    // reaper there was, so every round would refuse on disk for good.
    oneFreeKey()
    const { pool } = recordingPool()
    let reaps = 0
    const outcome = await dispatchBee(
      pool,
      1504,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        memory: calm,
        volume: () =>
          reaps === 0 ? { totalBytes: 50 * GB, freeBytes: 5.1 * GB } : roomy(),
        reap: async () => {
          reaps += 1
          return {
            before: 90,
            after: 60,
            removed: ['/w/.worktrees/queen-3'],
            keptDirty: [],
            keptRunning: [],
            refused: [],
          }
        },
      },
    )
    expect(reaps).toBe(1)
    // Past the gate: what stops it next is the empty workspace, not the guard.
    expect(outcome.room).toBeUndefined()
    expect(outcome.detail).not.toContain('GB free of')
  })

  /** A repository to cut worktrees from, standing where the workspace is. */
  const hive = (): { root: string; git: (args: string[]) => string } => {
    const root = join(process.env.WORKSPACE_DIR ?? '', 'BrowserOS')
    const git = (args: string[], cwd = root) => {
      const done = Bun.spawnSync(['git', ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      })
      if (done.exitCode !== 0) {
        throw new Error(
          `git ${args.join(' ')} failed: ${done.stderr.toString()}`,
        )
      }
      return done.stdout.toString().trim()
    }
    mkdirSync(root)
    git(['init', '-q', '-b', 'dev'])
    git(['config', 'user.email', 'bee@example.com'])
    git(['config', 'user.name', 'Bee'])
    writeFileSync(join(root, 'README.md'), 'hive\n')
    git(['add', '.'])
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
    git(['remote', 'add', 'origin', root])
    git(['fetch', '-q', 'origin'])
    return { root, git }
  }
  /** Everything a real start reads from the environment, put back afterwards. */
  const realStarts = () => {
    const names = [
      'TRIOS_API_TOKEN',
      'TRIOS_REPO_URL',
      'TRIOS_REPO_REF',
      'QUEEN_VOLUME_KEEP',
    ]
    const previous = names.map((name) => process.env[name])
    process.env.TRIOS_API_TOKEN = 'a-token-for-the-test'
    delete process.env.TRIOS_REPO_URL
    delete process.env.TRIOS_REPO_REF
    const realFetch = globalThis.fetch
    // /chat answers 200 and the stream STAYS OPEN, as a working bee's does: a
    // stream that is already over ends the bee, and an ended bee reserves
    // nothing.
    const streams: Array<ReadableStreamDefaultController<Uint8Array>> = []
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller)
          },
        }),
      )) as unknown as typeof fetch
    const finish = async (index: number) => {
      streams[index].enqueue(
        new TextEncoder().encode('data: {"type":"finish"}\n\n'),
      )
      streams[index].close()
      delete streams[index]
      // The drain closes the dispatch on its own turn of the loop.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return {
      finish,
      restore: async () => {
        globalThis.fetch = realFetch
        for (const index of Object.keys(streams)) await finish(Number(index))
        names.forEach((name, i) => {
          if (previous[i] === undefined) delete process.env[name]
          else process.env[name] = previous[i]
        })
      },
    }
  }

  it('reserves for the bee it just started, and gives it back the moment that bee ends', async () => {
    // The wiring, not the arithmetic: a start that is not noted, or a judgement
    // that does not count the young, admits thirty-four bees back to back on
    // one true reading of a nearly empty container - the incident this exists
    // to prevent. So this drives REAL starts: a repository to cut the worktree
    // from, and `/chat` answering 200.
    oneFreeKey()
    hive()
    const turns = realStarts()
    const { pool } = recordingPool()
    // 19.7 of 24 GB: one more bee fits under the line (21.6), two do not.
    const nearlyFull = () => ({ ...full(), usedBytes: 19.7 * GB })
    const start = 1_789_000_000_000
    const go = (issue: number, ms: number) =>
      dispatchBee(pool, issue, 'brief', [], [], undefined, [], 'none', {
        memory: nearlyFull,
        volume: roomy,
        now: () => ms,
        // Not this machine's disk: at 95% full the cut itself is refused.
        volumeUsed: () => 40,
      })
    try {
      const first = await go(1510, start)
      expect(first.detail).toContain('zai/')
      expect(first.started).toBe(true)

      const second = await go(1511, start + 60_000)
      expect(second.started).toBe(false)
      expect(second.room?.resource).toBe('memory')
      expect(second.room?.summary).toContain(
        '1 bee(s) started in the last 10 min are still growing',
      )

      // The first bee ends - a provider refusal ends one in seconds - and its
      // reservation ends with it, two minutes in and not ten.
      await turns.finish(0)
      const third = await go(1512, start + 120_000)
      expect(third.started).toBe(true)

      // The third is still running and still young: no room for another...
      expect((await go(1513, start + 180_000)).started).toBe(false)
      // ...until it has had its ten minutes, and its memory is in the reading.
      expect((await go(1513, start + 13 * 60_000)).started).toBe(true)
    } finally {
      await turns.restore()
    }
  })

  it('lets a runner start an order it claimed, and books it as an update, not a new row', async () => {
    // The order already holds the issue, the boundary, the criteria and the
    // key. A success must say what happened on it - and reset the clock the
    // two-hour rule reads, or a bee that waited an hour for a runner would be
    // reaped an hour into its work - without inserting it again, which would
    // archive a history row and clear what it is to be judged against.
    oneFreeKey()
    hive()
    const turns = realStarts()
    const { pool, queries } = recordingPool()
    try {
      const outcome = await runClaimedBee(
        pool,
        {
          issue: 1530,
          branch: 'queen-1530',
          brief: 'the order the Queen wrote',
          ownedPaths: ['docs/a.md'],
          conversationId: 'conv-ordered-by-the-queen',
          keyIndex: 0,
        },
        { memory: calm, volume: roomy, volumeUsed: () => 40 },
      )
      expect(outcome.started).toBe(true)
      expect(outcome.conversationId).toBe('conv-ordered-by-the-queen')
      expect(outcome.detail).toContain('zai/')
      const touched = queries.filter((q) => /queen_dispatch\b/.test(q.text))
      expect(
        touched.some((q) => /INSERT INTO queen_dispatch\b/.test(q.text)),
      ).toBe(false)
      const update = touched.find((q) => q.text.includes('SET detail = $2'))
      expect(update?.text).toContain('dispatched_at = now()')
      expect(update?.values).toEqual([1530, outcome.detail])
    } finally {
      await turns.restore()
    }
  })

  it('never reaps the tree of the issue it is about to dispatch again', async () => {
    // A redeploy killed the swarm; #1520 was reaped at boot and its tree holds
    // one committed, unpushed attempt. The container carries no push
    // credential, so that commit is the only copy. With the volume short the
    // gate reaps - and #1520 is by definition not running. Reaped, its tree
    // would be cut afresh with -B and the commit would drop off the branch.
    oneFreeKey()
    const { root, git } = hive()
    const turns = realStarts()
    process.env.QUEEN_VOLUME_KEEP = '0'
    for (const branch of ['queen-1520', 'queen-3']) {
      git([
        'worktree',
        'add',
        '-q',
        '-b',
        branch,
        join(root, '.worktrees', branch),
        'dev',
      ])
    }
    const tree = join(root, '.worktrees', 'queen-1520')
    writeFileSync(join(tree, 'attempt.md'), 'the only copy\n')
    Bun.spawnSync(['git', 'add', '.'], { cwd: tree })
    Bun.spawnSync(
      [
        'git',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'the first attempt',
      ],
      { cwd: tree, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
    )
    const attempt = git(['rev-parse', 'queen-1520'])
    const { pool } = recordingPool()
    let reaps = 0
    try {
      const outcome = await dispatchBee(
        pool,
        1520,
        'brief',
        [],
        [],
        undefined,
        [],
        'none',
        {
          memory: calm,
          volume: () =>
            reaps === 0
              ? { totalBytes: 50 * GB, freeBytes: 5.1 * GB }
              : roomy(),
          // The real reaper against the real repository, on a fixed reading.
          reap: async (opts = {}) => {
            reaps += 1
            return reapWorktrees({ ...opts, volumeUsed: () => 90 })
          },
          volumeUsed: () => 40,
        },
      )
      expect(reaps).toBe(1)
      // The reap did run, and did remove what nobody needs...
      expect(existsSync(join(root, '.worktrees', 'queen-3'))).toBe(false)
      // ...and the issue's own tree was reused with its commit where it was.
      expect(outcome.detail).toMatch(/^reused an existing worktree/)
      expect(git(['rev-parse', 'queen-1520'])).toBe(attempt)
      expect(outcome.started).toBe(true)
    } finally {
      await turns.restore()
    }
  })

  it('can be switched off, and then a full container refuses nothing here', async () => {
    oneFreeKey()
    process.env.TRIOS_QUEEN_RESOURCE_GUARD = 'off'
    const { pool } = recordingPool()
    const outcome = await dispatchBee(
      pool,
      1503,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        memory: full,
        volume: () => null,
      },
    )
    // Whatever stops it next (there is no repository in this directory), it is
    // not the guard.
    expect(outcome.room).toBeUndefined()
    expect(outcome.detail).not.toContain('container memory is')
    expect(outcome.detail).not.toContain('unknown is not room')
  })
})

/**
 * A bee that runs somewhere else.
 *
 * The Queen decides exactly what she decided before and writes it down; the
 * turn happens in another container. Measured 2026-09-18, which is why: her own
 * container held about a gigabyte a bee against a 24 GB limit, so the swarm
 * could never be wider than one machine however many credentials it had.
 */
describe('handing a bee to a runner', () => {
  const pool = () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const fake = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values })
        return { rowCount: 0, rows: [] }
      },
    } as unknown as Pool
    return { fake, queries }
  }
  const oneKey = () => {
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'zai'
    process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'https://api.z.ai/api/paas/v4'
    process.env.TRIOS_QUEEN_WORKER_API_KEY = 'first'
    process.env.TRIOS_QUEEN_WORKER_API_KEY_2 = 'second'
  }

  it('writes the order and starts nothing here', async () => {
    oneKey()
    process.env.TRIOS_QUEEN_BEES_RUN_ELSEWHERE = 'on'
    const { fake, queries } = pool()
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{}')
    }) as unknown as typeof fetch
    let measured = 0
    try {
      const outcome = await dispatchBee(
        fake,
        1600,
        'the brief for this bee',
        ['docs/a.md'],
        [],
        undefined,
        ['the tab opens'],
        'stated',
        {
          memory: () => {
            measured += 1
            return { kind: 'unsupported', platform: 'darwin' }
          },
        },
      )
      // In flight from this moment: the boundary is held and the key is taken
      // exactly as they were when she ran the bee herself.
      expect(outcome.started).toBe(true)
      expect(outcome.keyIndex).toBe(0)
      expect(outcome.conversationId).toMatch(/[0-9a-f-]{36}/)
      expect(outcome.detail).toContain('queued for a runner; zai/')
      // Nothing was run here: no turn asked for, and the container not even
      // measured, because the bee will not live in it.
      expect(calls).toBe(0)
      expect(measured).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
    const insert = queries.find((q) =>
      /INSERT INTO queen_dispatch\b/.test(q.text),
    )
    expect(insert?.text).toContain('queued_at')
    // The brief travels with the order: a runner has no issue body to build one
    // from. The credential does not - only its index.
    expect(insert?.values?.[13]).toBe('the brief for this bee')
    expect(insert?.values?.[12]).toBeInstanceOf(Date)
    expect(JSON.stringify(insert?.values)).not.toContain('first')
  })

  it('runs the bee here when nobody was told otherwise', async () => {
    oneKey()
    const { fake } = pool()
    let measured = 0
    const outcome = await dispatchBee(
      fake,
      1601,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        memory: () => {
          measured += 1
          return {
            kind: 'measured',
            usedBytes: 23 * 1_000_000_000,
            limitBytes: 24 * 1_000_000_000,
            source: 'cgroup v2',
            limitSource: 'cgroup',
          }
        },
        volume: () => ({ totalBytes: 50e9, freeBytes: 19e9 }),
      },
    )
    expect(measured).toBeGreaterThan(0)
    expect(outcome.detail).not.toContain('queued for a runner')
    expect(beesRunElsewhere()).toBe(false)
  })

  it('remembers which credential an index names, without storing one', () => {
    oneKey()
    process.env.TRIOS_QUEEN_WORKER_POOL_2_BASE_URL =
      'https://integrate.api.nvidia.com/v1'
    process.env.TRIOS_QUEEN_WORKER_POOL_2_MODEL = 'nvidia/nemotron'
    process.env.TRIOS_QUEEN_WORKER_POOL_2_API_KEY = 'nv-one'
    process.env.TRIOS_QUEEN_WORKER_POOL_2_API_KEY_2 = 'nv-two'
    // Whatever the allocator hands out, the index it stamps on the row must
    // name the same credential when a different process reads it back.
    for (const taken of [[], [0], [0, 1], [0, 1, 10_000]]) {
      const chosen = resolveWorkerProvider(taken)
      const again = workerProviderForKeyIndex(chosen?.keyIndex ?? -1)
      expect(again?.apiKey).toBe(chosen?.apiKey)
      expect(again?.model).toBe(chosen?.model)
      expect(again?.baseUrl).toBe(chosen?.baseUrl)
    }
    expect(workerProviderForKeyIndex(0)?.apiKey).toBe('first')
    expect(workerProviderForKeyIndex(10_001)?.apiKey).toBe('nv-two')
    // An index this environment cannot explain. The next key along is a
    // different account, so there is no answer but none.
    expect(workerProviderForKeyIndex(7)).toBeNull()
    expect(workerProviderForKeyIndex(20_000)).toBeNull()
  })

  it('hands the issue back when the runner cannot resolve the credential', async () => {
    // The runner's variables are not the Queen's. Reaching for the next key
    // would put two bees on one account while the ledger says otherwise.
    oneKey()
    const { fake, queries } = pool()
    const outcome = await runClaimedBee(fake, {
      issue: 1602,
      branch: 'queen-1602',
      brief: 'brief',
      ownedPaths: [],
      conversationId: 'conv-1602',
      keyIndex: 4242,
    })
    expect(outcome.started).toBe(false)
    expect(outcome.detail).toContain('cannot resolve key_index 4242')
    // Recorded as a refusal, which ends the row and gives the issue and its
    // boundary back to the next round.
    const insert = queries.find((q) =>
      /INSERT INTO queen_dispatch\b/.test(q.text),
    )
    expect(insert?.values?.[2]).toBe(false)
  })
})

/**
 * #1308. `workers.capacity` answers a number; this breakdown answers what the
 * number is MADE of. An operator seeing capacity 4 cannot act on it without
 * knowing whether it is two subscriptions at a lane each - one of which may be
 * quietly disconnected - or one subscription at two lanes each, and a total
 * alone keeps that a guess.
 */
describe('worker capacity breakdown', () => {
  // Scenario 1 of the issue: two distinct configured Z.ai credentials and two
  // lanes per credential. The response is closed - three integers, no trace of
  // WHICH credentials produced them.
  it('factors capacity into connected credentials and lanes per credential', () => {
    process.env.ZAI_API_KEY = 'planted-secret-a'
    process.env.ZAI_API_KEY_2 = 'planted-secret-b'
    process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
    expect(workerCapacityBreakdown()).toEqual({
      connectedCredentials: 2,
      lanesPerCredential: 2,
      effectiveCapacity: 4,
    })
    // The same authority dispatch allocates against, not a second story.
    expect(configuredWorkerCapacity()).toBe(4)
    expect(resolveWorkerProvider([0, 1, 0, 1])?.exhausted).toBe(4)
  })

  // FR-002/FR-003: closed and anonymous. Anything beyond these three fields -
  // a hash, a suffix, an index, a variable name, a value - is a disclosure.
  it('is three numeric fields and nothing else', () => {
    process.env.ZAI_API_KEY = 'planted-secret-a'
    process.env.ZAI_API_KEY_2 = 'planted-secret-b'
    const breakdown = workerCapacityBreakdown() as unknown as Record<
      string,
      unknown
    >
    expect(Object.keys(breakdown).sort()).toEqual([
      'connectedCredentials',
      'effectiveCapacity',
      'lanesPerCredential',
    ])
    for (const value of Object.values(breakdown)) {
      expect(typeof value).toBe('number')
      expect(Number.isInteger(value)).toBe(true)
    }
    const serialized = JSON.stringify(breakdown)
    expect(serialized).not.toContain('planted-secret')
    expect(serialized).not.toContain('ZAI_API_KEY')
    expect(serialized).not.toContain('ANTHROPIC_API_KEY')
  })

  // Scenario 2: a credential duplicated across slots is one account with one
  // rate limit (#1293). Neither factor may be inflated by it.
  it('counts a duplicated credential once so nothing is inflated', () => {
    process.env.ZAI_API_KEY = 'planted-secret-a'
    process.env.ZAI_API_KEY_2 = 'planted-secret-a'
    process.env.ZAI_API_KEY_3 = 'planted-secret-b'
    process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
    expect(workerCapacityBreakdown()).toEqual({
      connectedCredentials: 2,
      lanesPerCredential: 2,
      effectiveCapacity: 4,
    })
    expect(configuredWorkerCapacity()).toBe(4)
  })

  // FR-003: counted after TRIMMING. ' key' and 'key' in two boxes are one
  // credential wearing its whitespace differently, and the count must say so
  // before a second slot is handed a secret the first is already spending.
  it('trims values before counting, so padded duplicates are one credential', () => {
    process.env.ZAI_API_KEY = '  planted-secret-a  '
    process.env.ZAI_API_KEY_2 = 'planted-secret-a'
    process.env.ZAI_API_KEY_3 = ' planted-secret-b '
    expect(workerCapacityBreakdown().connectedCredentials).toBe(2)
    // Selection reads the same trimmed list, so the two can never disagree.
    expect(resolveWorkerProvider([])?.keyCount).toBe(2)
  })

  it('treats a whitespace-only value as the empty box it supplies nothing from', () => {
    process.env.ZAI_API_KEY = '   '
    expect(workerCapacityBreakdown().connectedCredentials).toBe(0)
    expect(configuredWorkerCapacity()).toBe(0)
  })

  // Scenario 3: no supported provider credentials. Every factor is zero or
  // its safe default, and nothing about a secret leaves with it.
  it('reports zeros and the safe lane default when nothing is connected', () => {
    expect(workerCapacityBreakdown()).toEqual({
      connectedCredentials: 0,
      lanesPerCredential: 1,
      effectiveCapacity: 0,
    })
    expect(configuredWorkerCapacity()).toBe(0)
  })

  // FR-005: the lane factor keeps its existing safe default and bound.
  it('keeps the safe default of one lane and the bound of four', () => {
    process.env.ZAI_API_KEY = 'planted-secret-a'
    process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '0'
    expect(workerCapacityBreakdown()).toEqual({
      connectedCredentials: 1,
      lanesPerCredential: 1,
      effectiveCapacity: 1,
    })
    process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '99'
    expect(workerCapacityBreakdown()).toEqual({
      connectedCredentials: 1,
      lanesPerCredential: 4,
      effectiveCapacity: 4,
    })
  })

  // The lane override belongs to Z.ai's tiered plans; another provider's
  // capacity stays one credential times one lane, exactly as before.
  it('does not apply the Z.ai lane factor to another provider', () => {
    process.env.ANTHROPIC_API_KEY = 'planted-anthropic-secret'
    process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '3'
    expect(workerCapacityBreakdown()).toEqual({
      connectedCredentials: 1,
      lanesPerCredential: 1,
      effectiveCapacity: 1,
    })
    expect(configuredWorkerCapacity()).toBe(1)
  })

  it('factors only the first configured provider, in preference order', () => {
    process.env.ZAI_API_KEY = 'planted-secret-a'
    process.env.ANTHROPIC_API_KEY = 'planted-anthropic-secret'
    process.env.OPENAI_API_KEY = 'planted-openai-secret'
    expect(workerCapacityBreakdown().connectedCredentials).toBe(1)
  })

  // FR-004: effective capacity is the number dispatch allocates against, so
  // the two must be one number in every configuration, not two that happen to
  // agree today. Each fixture starts from a cleared environment.
  it('equals configuredWorkerCapacity in every tested configuration', () => {
    const configurations: Array<() => void> = [
      () => undefined,
      () => {
        process.env.ZAI_API_KEY = 'a'
      },
      () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'b'
        process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
      },
      () => {
        process.env.ZAI_API_KEY = 'a'
        process.env.ZAI_API_KEY_2 = 'a'
        process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '4'
      },
      () => {
        process.env.ANTHROPIC_API_KEY = 'anthropic-a'
        process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
      },
      () => {
        process.env.OPENAI_API_KEY = 'openai-a'
        process.env.OPENAI_API_KEY_2 = 'openai-b'
      },
      () => {
        process.env.ZAI_API_KEY = '  a  '
        process.env.ZAI_API_KEY_2 = 'a'
        process.env.ZAI_API_KEY_3 = ' b '
      },
    ]
    for (const configure of configurations) {
      for (const key of KEYS) delete process.env[key]
      configure()
      const breakdown = workerCapacityBreakdown()
      expect(breakdown.effectiveCapacity).toBe(configuredWorkerCapacity())
      expect(breakdown.effectiveCapacity).toBe(
        breakdown.connectedCredentials * breakdown.lanesPerCredential,
      )
    }
  })
})

/** Every statement a call made, with the values it bound. */
function recordingPool(
  answer: (sql: string, attempt: number) => unknown = () => ({
    rowCount: 1,
    rows: [],
  }),
) {
  const asked: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      asked.push({ sql: String(sql), params })
      const answered = answer(String(sql), asked.length)
      if (answered instanceof Error) throw answered
      return answered as { rowCount: number; rows: unknown[] }
    },
  } as unknown as Pool
  return { pool, asked }
}

/** The statements that touched one table, in the order they were sent. */
const touching = (
  asked: Array<{ sql: string; params: unknown[] }>,
  table: string,
) => asked.filter((q) => q.sql.includes(table))

/**
 * The only statement that ends a turn used to fail in complete silence.
 *
 * `finishDispatch(...).catch(() => {})` inside a function that is itself
 * `void`ed: no log, no retry, no counter, and no caller able to see it either.
 * What it leaves behind is a phantom - the row keeps finished_at NULL and
 * started true, which the board reads as `running`, so a bee that has stopped
 * holds its boundary until the 120-minute stall sweep reaps it. Reaping
 * RELEASES the issue for retry, which is how #1244 was dispatched six times.
 */
describe('closing a dispatch', () => {
  const captureErrors = () => {
    const errors: Array<{ message: string; meta?: Record<string, unknown> }> =
      []
    const original = logger.error.bind(logger)
    logger.error = (message: string, meta?: Record<string, unknown>) => {
      errors.push({ message, meta })
    }
    return { errors, restore: () => (logger.error = original) }
  }

  it('logs and retries when the ending cannot be written', async () => {
    const { pool, asked } = recordingPool((_sql, attempt) =>
      attempt === 1 ? new Error('connection terminated unexpectedly') : {},
    )
    const { errors, restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    expect(asked.length).toBe(2)
    expect(errors.length).toBe(1)
    // The issue and the conversation, or the line cannot be traced to a bee.
    expect(errors[0].meta?.issue).toBe(1244)
    expect(errors[0].meta?.conversationId).toBe('conv-1')
    expect(String(errors[0].meta?.error)).toContain('connection terminated')
  })

  // AN UPDATE THAT CHANGED NOTHING DOES NOT THROW, so the `try` above cannot
  // see it and the old code called it a written ending. A skeptic proved that
  // matters: with the history archive added, a turn whose frames are all NOISE
  // reached this function BEFORE its dispatch row existed, the UPDATE matched
  // zero rows in silence, and the upsert that followed wrote started=true with
  // finished_at NULL - the exact phantom this function exists to prevent,
  // arriving with no database failure anywhere in it.
  it('says so when the ending matched no row at all', async () => {
    const { pool, asked } = recordingPool(() => ({ rowCount: 0, rows: [] }))
    const { errors, restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    // One statement: it did not throw, so there is nothing to retry.
    expect(asked.length).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain('matched no row')
    expect(errors[0].meta?.issue).toBe(1244)
    expect(errors[0].meta?.conversationId).toBe('conv-1')
  })

  it('stays quiet when the ending did land', async () => {
    const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    const { errors, restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    expect(errors).toEqual([])
  })

  it('does not throw when the retry fails too', async () => {
    const { pool, asked } = recordingPool(() => new Error('still down'))
    const { restore } = captureErrors()
    try {
      await closeDispatch(pool, 1244, 'conv-1', 'finished')
    } finally {
      restore()
    }
    // Two attempts and no more: the stall reaper is the backstop, and a loop
    // here would hold a dead stream open.
    expect(asked.length).toBe(2)
  })

  // Unknown is not zero. A turn killed mid-stream never reaches its usage
  // frame, and writing 0 for it would price a real turn at nothing.
  it('leaves an existing price alone when the turn reported none', async () => {
    const { pool, asked } = recordingPool()
    await finishDispatch(pool, 1244, 'reaped')
    expect(asked[0].sql).toContain('COALESCE')
    expect(asked[0].params[2]).toBeNull()
    expect(asked[0].params[3]).toBeNull()
  })
})

/**
 * What the turn cost, on the row rather than inside a string.
 *
 * The stream has carried a usage frame since 2026-08-21 and this module let it
 * fall through to the default branch, where it was stored as 800 characters of
 * JSON in the transcript. queen_dispatch had no numeric column at all, so
 * pricing one round meant string-parsing one transcript row.
 */
describe('draining a turn', () => {
  const sse = (frames: unknown[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const frame of frames) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
            )
          }
          controller.close()
        },
      }),
    )

  it('writes the token counts the stream reported', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'text-delta', delta: 'working' },
        // The shape chat-service.ts emits, nested under `usage`.
        { type: 'usage', usage: { inputTokens: 18308, outputTokens: 45 } },
        { type: 'finish' },
      ]),
      'conv-1',
      1244,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing.length).toBe(1)
    expect(closing[0].params).toEqual([1244, 'finished', 18308, 45, 'conv-1'])
  })

  // The ending must name the turn it belongs to, not just the issue.
  //
  // Keyed by issue alone, a stream from a previous attempt that finishes late
  // closes the CURRENT attempt's row - and drives its token counts through the
  // COALESCE that exists to protect a price. The reaper releases an issue for
  // retry while the old container's stream may still be alive, so two turns for
  // one issue overlap as a matter of routine.
  it('closes the turn it belongs to and not merely the issue', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
        { type: 'finish' },
      ]),
      'the-second-attempt',
      1244,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')[0]
    expect(closing.params).toContain('the-second-attempt')
    expect(closing.sql).toContain('conversation_id')
  })

  it('still shows the cost in the feed a person watches', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([{ type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }]),
      'conv-1',
      1244,
    )
    const rows = touching(asked, 'queen_transcript')
    expect(rows.some((r) => r.params[3] === 'usage')).toBe(true)
    expect(
      rows.some((r) => String(r.params[4]).includes('12 in / 3 out')),
    ).toBe(true)
  })

  it('gives the agent back when the turn is over, so the memory comes with it', async () => {
    // Measured on the deployed container 2026-09-18: seven bees cost 2.5 GB
    // between them, and an hour later, with none running, it held 11 GB and
    // never gave it back. Every dispatch builds a session; nothing asked for
    // one back, so the baseline grew with every bee that FINISHED.
    const { pool } = recordingPool()
    const asked: Array<{ url: string; method?: string; auth?: string }> = []
    const realFetch = globalThis.fetch
    const previous = process.env.TRIOS_API_TOKEN
    process.env.TRIOS_API_TOKEN = 'a-token-for-the-test'
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      asked.push({
        url: String(url),
        method: init?.method,
        auth: new Headers(init?.headers).get('Authorization') ?? undefined,
      })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      await drain(pool, sse([{ type: 'finish' }]), 'the-turn-that-ended', 1244)
    } finally {
      globalThis.fetch = realFetch
      if (previous === undefined) delete process.env.TRIOS_API_TOKEN
      else process.env.TRIOS_API_TOKEN = previous
    }
    expect(asked).toHaveLength(1)
    expect(asked[0].method).toBe('DELETE')
    expect(asked[0].url).toEndWith('/chat/the-turn-that-ended')
    expect(asked[0].auth).toBe('Bearer a-token-for-the-test')
  })

  it('still closes the dispatch when the session will not be released', async () => {
    const { pool, asked } = recordingPool()
    const realFetch = globalThis.fetch
    const previous = process.env.TRIOS_API_TOKEN
    process.env.TRIOS_API_TOKEN = 'a-token-for-the-test'
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    try {
      await drain(pool, sse([{ type: 'finish' }]), 'conv-9', 1244)
    } finally {
      globalThis.fetch = realFetch
      if (previous === undefined) delete process.env.TRIOS_API_TOKEN
      else process.env.TRIOS_API_TOKEN = previous
    }
    expect(touching(asked, 'UPDATE queen_dispatch')).toHaveLength(1)
  })

  it('reports no price rather than a free turn when the frame never came', async () => {
    const { pool, asked } = recordingPool()
    await drain(pool, sse([{ type: 'text-delta', delta: 'killed' }]), 'c', 1244)
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing[0].params[2]).toBeNull()
    expect(closing[0].params[3]).toBeNull()
  })
})

/**
 * #1301. Coding Plan removed the synthetic USD start gate (#1300), so the
 * provider's quota response became the authoritative stop signal: a bee that
 * hits one cannot be helped by another retry until Z.ai resets the window or
 * the operator pays. A generic worker failure hides that, and a board that
 * cannot tell a quota stop from a flaky turn reaps and retries work that was
 * never going to run.
 *
 * The classification is CLOSED, deliberately: only Z.ai's documented business
 * codes (docs.z.ai, "Errors" - all delivered as HTTP 429), only for the
 * provider zai, matched as code tokens and never as prose. Another provider
 * answering with the same words - even the same code - is answering for
 * itself and acquires no Z.ai Coding Plan state; a transient Z.ai 429
 * (request rate, temporary overload) stays an ordinary ending, because
 * another retry can help it.
 */
describe('classifying a quota stop at the dispatch boundary', () => {
  it('classifies a Coding Plan usage-limit response with its reset window', () => {
    const outcome = classifyQuotaExhaustion(
      'zai',
      '[1308] Usage limit reached for 5 prompts. Your limit will reset at 2025-06-01 12:00:00 GMT+08:00.',
    )
    expect(outcome).toBe('provider quota exhausted (zai code 1308)')
  })

  it('classifies every documented quota code, and only those', () => {
    const quotaCodes = [
      '1113', // Insufficient balance or no resource package.
      '1308', // Usage limit reached for a window.
      '1309', // GLM Coding Plan package expired.
      '1310', // Weekly/Monthly limit exhausted.
      '1311', // Plan does not include the model.
      '1313', // Fair Usage Policy.
      '1314', // Enterprise package expired.
      '1315', // Key limited to enterprise coding package.
      '1316', // 5-hour limit, no balance for extra usage.
      '1317', // 7-day limit, no balance for extra usage.
      '1318', // 5-hour limit, monthly spend limit.
      '1319', // 7-day limit, monthly spend limit.
      '1320', // 5-hour limit, monthly spend limit.
      '1321', // 7-day limit, monthly spend limit.
    ]
    for (const code of quotaCodes) {
      expect(classifyQuotaExhaustion('zai', `[${code}] stopped`)).toBe(
        `provider quota exhausted (zai code ${code})`,
      )
    }
    // The transient 429s clear on their own. Closing a bee as quota-stopped
    // over either would retire work another retry could have finished.
    expect(
      classifyQuotaExhaustion('zai', '[1302] Rate limit reached'),
    ).toBeNull()
    expect(
      classifyQuotaExhaustion(
        'zai',
        '[1305] The service may be temporarily overloaded',
      ),
    ).toBeNull()
    // Documented codes outside the quota family are not quota stops either.
    for (const code of ['1000', '1211', '1220', '1301']) {
      expect(classifyQuotaExhaustion('zai', `[${code}] other`)).toBeNull()
    }
  })

  // The message this server's own transport builds is `[code] message`
  // (lib/openrouter-fetch.ts), but a raw body can surface whole inside an
  // error message; the documented envelope field is read for that shape.
  it('reads the code from the documented envelope when a raw body surfaces', () => {
    const outcome = classifyQuotaExhaustion(
      'zai',
      'AI_APICallError: {"error":{"code":"1316","message":"Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2025-06-01."}}',
    )
    expect(outcome).toBe('provider quota exhausted (zai code 1316)')
  })

  it('does not classify an ordinary provider failure', () => {
    expect(classifyQuotaExhaustion('zai', 'fetch failed')).toBeNull()
    expect(
      classifyQuotaExhaustion('zai', 'HTTP 500: Internal Error'),
    ).toBeNull()
    expect(classifyQuotaExhaustion('zai', '')).toBeNull()
    // Prose alone proves nothing: the classification matches codes, not
    // words, so an undocumented body that merely sounds exhausted stays an
    // ordinary ending and keeps whatever retry path it always had.
    expect(
      classifyQuotaExhaustion(
        'zai',
        'Insufficient balance or no resource package. Please recharge.',
      ),
    ).toBeNull()
    expect(
      classifyQuotaExhaustion(
        'zai',
        'Usage limit reached for the past 5 hours',
      ),
    ).toBeNull()
  })

  // Scenario 3 of the issue: another provider returning similar prose must
  // not acquire Z.ai Coding Plan state. The check is the provider, first and
  // last, so even the exact documented code means nothing in another name.
  it('infers no Z.ai state about another provider, prose or code', () => {
    for (const provider of [
      'openrouter',
      'anthropic',
      'openai',
      'moonshot',
      '',
    ]) {
      expect(
        classifyQuotaExhaustion(
          provider,
          '[1113] Insufficient balance or no resource package. Please recharge.',
        ),
      ).toBeNull()
      expect(
        classifyQuotaExhaustion(
          provider,
          '[1308] Usage limit reached for 5 prompts',
        ),
      ).toBeNull()
    }
  })

  // Scenario 1 of the issue: the stored outcome identifies quota exhaustion
  // without exposing the response body or the credential. The provider's own
  // prose - and anything a message might have echoed - stays off the row.
  it('never carries the body or a credential into the classification', () => {
    const failure =
      '[1310] Weekly/Monthly Limit Exhausted. Your limit will reset at 2025-06-02 00:00 (account key sk-zai-1234-example).'
    const outcome = classifyQuotaExhaustion('zai', failure)
    expect(outcome).toBe('provider quota exhausted (zai code 1310)')
    expect(outcome).not.toContain('reset at')
    expect(outcome).not.toContain('sk-zai-1234-example')
    // Deterministic: the same failure closes with the same words every time.
    expect(classifyQuotaExhaustion('zai', failure)).toBe(outcome)
  })
})

/**
 * The dispatch result path: /chat answers 200 and streams a provider refusal
 * as a terminal error frame, so the quota classification has to survive the
 * path a real bee's stream takes - Scribe frames, drain, closeDispatch - and
 * land on the queen_dispatch row, not merely exist as a pure function.
 *
 * Every non-quota path must close exactly as it did before #1301, because
 * retry, refill and the board read these endings.
 */
describe('closing a quota-limited bee', () => {
  const sse = (frames: unknown[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const frame of frames) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
            )
          }
          controller.close()
        },
      }),
    )

  it('stores the quota classification instead of an ordinary finish', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'text-delta', delta: 'starting' },
        // The terminal error frame, carrying the business code this server's
        // own transport prefixes (lib/openrouter-fetch.ts) and the provider's
        // prose - which must reach the row as neither.
        {
          type: 'error',
          errorText:
            '[1308] Usage limit reached for 5 prompts. Your limit will reset at 2025-06-01 12:00:00 GMT+08:00.',
        },
        { type: 'finish', finishReason: 'error' },
      ]),
      'conv-1301',
      1301,
      'zai',
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing.length).toBe(1)
    expect(closing[0].params[1]).toBe(
      'provider quota exhausted (zai code 1308)',
    )
    // The reset timestamp and the provider prose stay off the ending.
    expect(JSON.stringify(closing[0].params)).not.toContain('reset at')
    expect(JSON.stringify(closing[0].params)).not.toContain(
      'Usage limit reached',
    )
  })

  // Scenario 2 of the issue: a transient non-quota failure keeps the existing
  // classification and with it every retry behavior that reads the outcome.
  it('keeps the ordinary ending for a transient Z.ai failure', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        { type: 'error', errorText: '[1302] Rate limit reached for requests' },
        { type: 'finish', finishReason: 'error' },
      ]),
      'conv-1301',
      1301,
      'zai',
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing[0].params[1]).toBe('finished')
  })

  // Scenario 3 of the issue, on the result path: identical prose under
  // another provider's name closes as an ordinary ending.
  it('keeps the ordinary ending when the provider is not Z.ai', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        {
          type: 'error',
          errorText: '[1113] Insufficient balance or no resource package.',
        },
        { type: 'finish', finishReason: 'error' },
      ]),
      'conv-1301',
      1301,
      'openrouter',
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing[0].params[1]).toBe('finished')
  })

  // drain predates the provider argument; every caller that passes nothing
  // must close exactly as before, so the argument stays optional and inert.
  it('keeps the ordinary ending for callers that pass no provider', async () => {
    const { pool, asked } = recordingPool()
    await drain(
      pool,
      sse([
        {
          type: 'error',
          errorText: '[1308] Usage limit reached for 5 prompts',
        },
        { type: 'finish', finishReason: 'error' },
      ]),
      'conv-1301',
      1301,
    )
    const closing = touching(asked, 'UPDATE queen_dispatch')
    expect(closing[0].params[1]).toBe('finished')
  })

  // A quota stop is an ending the turn really reached, not a failure to end:
  // the row closes, the key frees, and the refill signal (#1295) fires just
  // as it does for any durable close. Suppressing it here would hold a paid
  // key idle against the very issue this classification exists to keep honest.
  it('still frees the slot: a quota close signals like any durable close', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    try {
      const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
      await drain(
        pool,
        sse([
          { type: 'error', errorText: '[1113] Insufficient balance' },
          { type: 'finish', finishReason: 'error' },
        ]),
        'conv-1301',
        1301,
        'zai',
      )
      expect(heard).toEqual([1301])
    } finally {
      setDurableCloseListener(undefined)
    }
  })
})

/**
 * queen_dispatch is keyed by issue alone, so a second attempt overwrites the
 * first in place: which key it took, how long it ran and why it ended all stop
 * existing. #1244 was dispatched six times and one row survived it.
 */
describe('recording a dispatch', () => {
  it('archives the attempt it is about to overwrite, first', async () => {
    const { pool, asked } = recordingPool()
    await recordDispatch(pool, 1244, 'queen-1244', true, 'cut from dev', [])
    const archive = asked.findIndex((q) =>
      q.sql.includes('queen_dispatch_history'),
    )
    const upsert = asked.findIndex((q) => q.sql.includes('ON CONFLICT (issue)'))
    expect(archive).toBeGreaterThanOrEqual(0)
    expect(archive).toBeLessThan(upsert)
    expect(asked[archive].params).toEqual([1244])
    // The whole row as one value. A copied column list would be a second rule,
    // stale on the first ALTER that touched the table it copies.
    expect(asked[archive].sql).toContain('to_jsonb(queen_dispatch)')
  })

  it('does not fail the dispatch when the archive cannot be written', async () => {
    const { pool, asked } = recordingPool((sql) =>
      sql.includes('queen_dispatch_history')
        ? new Error('relation "queen_dispatch_history" does not exist')
        : {},
    )
    await recordDispatch(pool, 1244, 'queen-1244', true, 'cut from dev', [])
    expect(touching(asked, 'ON CONFLICT (issue)').length).toBe(1)
  })

  // Measured on a scratch database while this was written: without the reset a
  // second dispatch of #1244 inherited the first attempt's 18308 input tokens
  // and reported them as its own.
  it('starts the new attempt with no price of its own', async () => {
    const { pool, asked } = recordingPool()
    await recordDispatch(pool, 1244, 'queen-1244', true, 'cut from dev', [])
    const upsert = touching(asked, 'ON CONFLICT (issue)')[0]
    expect(upsert.sql).toContain('input_tokens = NULL')
    expect(upsert.sql).toContain('output_tokens = NULL')
  })
})

/**
 * Git-backed. These drive real `git` in a throwaway repository, because the
 * defect being fixed is that the code did not RUN a git command it should
 * have - a mocked git would agree with whatever the source says.
 */
describe('an existing worktree', () => {
  const git = (cwd: string, args: string[]) => {
    const done = Bun.spawnSync(['git', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    if (done.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${done.stderr.toString()}`)
    }
    return done.stdout.toString().trim()
  }

  /** A repository with one commit and a worktree cut for issue 99. */
  function hive(): { root: string; worktree: string; restore: () => void } {
    const previous = process.env.WORKSPACE_DIR
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'queen-hive-')))
    const root = join(workspace, 'BrowserOS')
    mkdirSync(root)
    git(root, ['init', '-q', '-b', 'dev'])
    git(root, ['config', 'user.email', 'bee@example.com'])
    git(root, ['config', 'user.name', 'Bee'])
    writeFileSync(join(root, 'README.md'), 'hive\n')
    git(root, ['add', '.'])
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
    // `baseRef()` qualifies a bare branch name with `origin/`, exactly as
    // production does, so a hive with no remote makes every `git diff
    // origin/dev...` exit non-zero - and `committedFiles` answers a failed diff
    // with an empty list. The file-naming case was measuring that failure and
    // reading it as "the branch committed nothing". The container's checkout is
    // a clone and has the remote; so does this.
    git(root, ['remote', 'add', 'origin', root])
    const worktree = join(root, '.worktrees', 'queen-99')
    git(root, ['worktree', 'add', '-q', '-B', 'queen-99', worktree, 'dev'])
    git(root, ['fetch', '-q', 'origin'])
    process.env.WORKSPACE_DIR = workspace
    return {
      root,
      worktree,
      restore: () => {
        if (previous === undefined) delete process.env.WORKSPACE_DIR
        else process.env.WORKSPACE_DIR = previous
      },
    }
  }

  // The container holds no push credential by design, so what a previous bee
  // left uncommitted in that tree is the only copy of it. The next bee inherits
  // it either way; the row and the brief used to say "reused an existing
  // worktree" and let that pass unnoticed.
  it('says how much a previous attempt left behind', async () => {
    const { worktree, restore } = hive()
    try {
      writeFileSync(join(worktree, 'half-done.ts'), 'export const x = 1\n')
      writeFileSync(join(worktree, 'README.md'), 'edited\n')
      const prepared = await prepareWorktree(99)
      expect(prepared.ok).toBe(true)
      expect(prepared.detail).toContain('2 uncommitted file(s)')
    } finally {
      restore()
    }
  })

  it('says it is clean when it is', async () => {
    const { restore } = hive()
    try {
      const prepared = await prepareWorktree(99)
      // THE DETAIL IS A LIST OF CLAUSES NOW, AND THIS PIN PREDATES THE SECOND.
      //
      // `prepareWorktree` appends `; installed its own modules (…)` or
      // `; linked N node_modules into the store for …` on both the fresh and
      // the reuse path, because a worktree whose dependencies were not shared
      // is the difference between a 159 MB tree and a 2.5 GB one and belongs in
      // the record. This assertion was written when `detail` was one phrase, so
      // it has failed on every run since - 12 of 12 measured, which is not
      // flake, which is what it was being called.
      //
      // The first clause is still pinned exactly, so a reworded phrase is still
      // caught; the rest of the list is allowed to grow.
      expect(prepared.detail.split('; ')[0]).toBe(
        'reused an existing worktree (clean)',
      )
    } finally {
      restore()
    }
  })

  // The measurement `queend`'s unused `boundary` question needs. The count was
  // all that ever left this module, and the diff that produces it is the only
  // record of WHERE a bee wrote.
  it('names the files a branch committed, not just how many', async () => {
    const { root, worktree, restore } = hive()
    const previousRef = process.env.TRIOS_REPO_REF
    process.env.TRIOS_REPO_REF = 'dev'
    try {
      writeFileSync(join(worktree, 'owned.ts'), 'export const a = 1\n')
      writeFileSync(join(worktree, 'stray.ts'), 'export const b = 2\n')
      git(worktree, ['add', '.'])
      git(worktree, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'bee work'])
      expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dev')
      const files = await committedFiles(99)
      expect(files.sort()).toEqual(['owned.ts', 'stray.ts'])
      expect(await committedFileCount(99)).toBe(2)
    } finally {
      if (previousRef === undefined) delete process.env.TRIOS_REPO_REF
      else process.env.TRIOS_REPO_REF = previousRef
      restore()
    }
  })
})

/**
 * #1295. A finished bee frees a healthy paid key, and until this the next
 * eligible mission waited for the periodic tick - up to 1,800 seconds of idle
 * capacity per finished bee, on a swarm whose whole point is that no laptop
 * has to be awake to keep it busy.
 *
 * The signal must be EARNED by a durable close. An UPDATE that changed
 * nothing does not throw, so "the write succeeded" and "the write matched no
 * row" were the same answer one layer out - and announcing a freed slot about
 * a row that still reads `running` would wake a round that sees the bee as in
 * flight and skips the very work the signal promised. The retry and, behind
 * it, the stall reaper stay authoritative for every close that did not land.
 *
 * These cases use a recording pool rather than a database because the
 * question is which CLOSES signal, not whether Postgres can UPDATE - and the
 * issue's own independent test asks for exactly that shape: fake pools, no
 * sleeping, no real provider.
 */
describe('a durable close frees the slot at once', () => {
  afterEach(() => {
    // The listener is module state. A case that forgets to clear it would
    // hand its hook to every later close in this file - a signal from a test
    // nobody is looking at.
    setDurableCloseListener(undefined)
  })

  /** A stream that has already ended, the way a real bee's does. */
  const endedStream = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"finish"}\n\n'),
          )
          controller.close()
        },
      }),
    )

  // Scenario 1: one updated row is the durable running-to-finished
  // transition, and it must ask for a refill without waiting for the timer.
  it('signals one refill when the ending landed on one row', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(heard).toEqual([1295])
  })

  // The stream ending is WHEN the slot frees, so the signal must travel the
  // drain path a real bee takes - not only a hand-made closeDispatch call.
  it('signals when the stream ends and the close is durable', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    await drain(pool, endedStream(), 'conv-1295', 1295)
    expect(heard).toEqual([1295])
  })

  // Scenario 3, first half: zero rows means the transition never happened.
  it('signals nothing when the ending matched no row', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool, asked } = recordingPool(() => ({ rowCount: 0, rows: [] }))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(heard).toEqual([])
    // Unchanged: nothing threw, so there is no retry to make.
    expect(asked.length).toBe(1)
  })

  // Scenario 3, second half: a close whose every write failed leaves the row
  // running. The stall reaper, not a hopeful signal, decides when that slot
  // is free.
  it('signals nothing when both write attempts fail', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool, asked } = recordingPool(() => new Error('still down'))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(heard).toEqual([])
    // Unchanged: one retry, then silence.
    expect(asked.length).toBe(2)
  })

  // A close that needed its retry but LANDED is closed as far as the board
  // can see - the row says finished - and suppressing the signal here would
  // restore the half-hour wait for exactly the deployments with the flakiest
  // databases, which are the ones that most need the slot back.
  it('signals when only the retry landed, because the row is closed either way', async () => {
    const heard: number[] = []
    setDurableCloseListener((issue) => heard.push(issue))
    const { pool, asked } = recordingPool((_sql, attempt) =>
      attempt === 1
        ? new Error('connection terminated unexpectedly')
        : { rowCount: 1, rows: [] },
    )
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(asked.length).toBe(2)
    expect(heard).toEqual([1295])
  })

  // The tick loop is the only listener. A server running without it (local
  // development, the app alongside) must close exactly as before, because a
  // completion with nobody local to refill is a normal minute, not an error.
  it('closes quietly when no listener is installed', async () => {
    const { pool, asked } = recordingPool(() => ({ rowCount: 1, rows: [] }))
    await closeDispatch(pool, 1295, 'conv-1295', 'finished')
    expect(asked.length).toBe(1)
  })
})
