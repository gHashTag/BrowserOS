import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenContributorKeysRoute } from '../../src/api/routes/queen-contributor-keys'
import {
  addContributorKey,
  checkModel,
  contributorGithub,
  fingerprint,
  openCredential,
  ownerModel,
  probeCredential,
  providerModels,
  resetProviderModels,
  sealCredential,
  trustedContributor,
  validModel,
} from '../../src/api/services/queen-contributor-keys'
import { CONTRIBUTOR_POLICY } from '../../src/api/services/queen-contributor-policy'
import {
  environmentContributorKeys,
  resolveWorkerProvider,
  reviewLaneCandidates,
  workerCapacityBreakdown,
  workerProbeEndpoint,
} from '../../src/api/services/queen-dispatch'
import { latestProviderKeyIndex } from '../../src/api/services/queen-tick'
import { loadCompiler } from '../../src/inngest/t27-consts'
import { ModelRanking, startModelProbes } from '../../src/lib/model-ranking'

const subject = 'telegram:111222333'
const token = 'test-proxy-capability-at-least-32-bytes'
const names = [
  'QUEEN_CONTRIBUTOR_PROXY_TOKEN',
  'QUEEN_CONTRIBUTOR_ENCRYPTION_KEY',
  'QUEEN_CONTRIBUTOR_IDENTITIES',
  'TRIOS_QUEEN_WORKER_BASE_URL',
  'TRIOS_QUEEN_WORKER_PROVIDER',
  'TRIOS_QUEEN_WORKER_MODEL',
  'TRIOS_QUEEN_WORKER_API_KEY',
  'TRIOS_QUEEN_WORKER_API_KEY_2',
  'TRIOS_QUEEN_WORKER_API_KEY_3',
  'TRIOS_QUEEN_REMOTE_CONCURRENCY_PER_KEY',
  'ZAI_API_KEY',
  'ANTHROPIC_API_KEY',
]
const before = new Map<string, string | undefined>()
beforeEach(() => {
  for (const name of names) before.set(name, process.env[name])
  process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN = token
  process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString(
    'base64',
  )
  process.env.QUEEN_CONTRIBUTOR_IDENTITIES = JSON.stringify({
    [subject]: 'dmitrii-f-t27',
  })
})
afterEach(() => {
  for (const name of names) {
    const value = before.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('contributor capability and vault', () => {
  it('refuses raw secret whitespace, client ownership claims and malformed labels before any database access', async () => {
    const pool = {} as Pool
    for (const input of [
      { provider: 'zai', apiKey: 'secret\n' },
      { provider: 'zai', apiKey: 'secret', github: 'dmitrii-f-t27' },
      { provider: 'zai', apiKey: 'secret', label: 42 },
      { provider: 'zai', apiKey: 'secret', label: 'a'.repeat(81) },
    ])
      await expect(
        addContributorKey(pool, subject, input, []),
      ).rejects.toThrow()
  })
  it('requires its separate capability, a verified subject and configured service', () => {
    expect(trustedContributor(`Bearer ${token}`, subject)).toBe(subject)
    expect(() =>
      trustedContributor('Bearer operator-or-app-token', subject),
    ).toThrow('forbidden')
    expect(() => trustedContributor(undefined, subject)).toThrow('forbidden')
    expect(() =>
      trustedContributor(`Bearer ${token}`, '@dmitrii-f-t27'),
    ).toThrow('invalid_contributor')
    expect(() => trustedContributor(`Bearer ${token}`, `${subject}\n`)).toThrow(
      'invalid_contributor',
    )
    delete process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN
    expect(() => trustedContributor(`Bearer ${token}`, subject)).toThrow(
      'unavailable',
    )
  })
  it('only the operator map can assert a GitHub login', () => {
    expect(contributorGithub(subject)).toBe('dmitrii-f-t27')
    expect(contributorGithub('telegram:999')).toBeUndefined()
    process.env.QUEEN_CONTRIBUTOR_IDENTITIES = '{bad'
    expect(contributorGithub(subject)).toBeUndefined()
  })
  it('uses randomized authenticated encryption bound to owner and fingerprint', () => {
    const secret = 'provider-test-secret'
    const digest = fingerprint(secret)
    const first = sealCredential(secret, subject, digest)
    expect(first).not.toContain(secret)
    expect(sealCredential(secret, subject, digest)).not.toBe(first)
    expect(openCredential(first, subject, digest)).toBe(secret)
    expect(() => openCredential(first, 'telegram:999', digest)).toThrow(
      'unavailable',
    )
    expect(() =>
      openCredential(first, subject, fingerprint('different')),
    ).toThrow('unavailable')
    const tampered = first.split('.')
    tampered[2] = Buffer.from('tampered').toString('base64')
    expect(() => openCredential(tampered.join('.'), subject, digest)).toThrow(
      'unavailable',
    )
    process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY = 'short'
    expect(() => sealCredential(secret, subject, digest)).toThrow('unavailable')
  })
  it('rejects unauthenticated and malformed requests before touching storage', async () => {
    let queries = 0
    const app = new Hono().route(
      '/queen/contributor-keys',
      createQueenContributorKeysRoute({
        pool: () => {
          queries++
          throw new Error('must not read')
        },
      }),
    )
    expect((await app.request('/queen/contributor-keys')).status).toBe(403)
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Queen-Contributor-Id': subject,
    }
    expect(
      (
        await app.request('/queen/contributor-keys/-1/reassign', {
          method: 'POST',
          headers,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await app.request('/queen/contributor-keys/1e3/probe', {
          method: 'POST',
          headers,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await app.request('/queen/contributor-keys', {
          method: 'POST',
          headers,
          body: 'a'.repeat(9000),
        })
      ).status,
    ).toBe(413)
    expect(queries).toBe(0)
  })
})

describe('bounded provider evidence', () => {
  it('the ranking timer rereads consent and never reuses a disabled startup credential', async () => {
    const calls: string[] = []
    let reads = 0
    let completed!: () => void
    const done = new Promise<void>((resolve) => {
      completed = resolve
    })
    const stop = startModelProbes(
      new ModelRanking(['first', 'second']),
      { baseUrl: 'https://example.invalid', keys: ['disabled-startup-key'] },
      {
        resolveEndpoint: async () =>
          ++reads === 1
            ? { baseUrl: 'https://example.invalid', keys: ['enabled-key'] }
            : undefined,
        fetchImpl: (async (_url, init) => {
          calls.push(new Headers(init?.headers).get('authorization') ?? '')
          return Response.json({
            usage: { completion_tokens: 10 },
            choices: [{ message: { content: 'OK', tool_calls: [{}] } }],
          })
        }) as typeof fetch,
        onRound: () => completed(),
      },
    )
    try {
      await done
    } finally {
      stop()
    }
    expect(reads).toBe(2)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((value) => value === 'Bearer enabled-key')).toBe(true)
  })
  const key = {
    provider: 'nvidia' as const,
    model: 'test-model',
    apiKey: 'never-reflect-this-secret',
  }
  it('uses a fixed endpoint, timeout, bounded generation and refuses redirects', async () => {
    const result = await probeCredential(key, (async (url, init) => {
      expect(url).toBe(`${CONTRIBUTOR_POLICY.NVIDIA_URL}/chat/completions`)
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(
        CONTRIBUTOR_POLICY.PROBE_MAX_TOKENS,
      )
      return Response.json({ choices: [{ message: { content: 'OK' } }] })
    }) as typeof fetch)
    expect(result.status).toBe('ok')
    expect(result.checkedAt).not.toBeNull()
  })
  it('distinguishes invalid, throttled, unavailable and unusable 200 without leaking errors', async () => {
    for (const [status, expected] of [
      [401, 'invalid'],
      [403, 'invalid'],
      [429, 'rate_limited'],
      [502, 'unavailable'],
    ] as const) {
      const result = await probeCredential(
        key,
        (async () => new Response(key.apiKey, { status })) as typeof fetch,
      )
      expect(result.status).toBe(expected)
      expect(JSON.stringify(result)).not.toContain(key.apiKey)
    }
    expect(
      (
        await probeCredential(key, (async () =>
          Response.json({})) as typeof fetch)
      ).status,
    ).toBe('unavailable')
    const failed = await probeCredential(key, (async () => {
      throw new Error(key.apiKey)
    }) as typeof fetch)
    expect(JSON.stringify(failed)).not.toContain(key.apiKey)
  })
})

describe('stable allocation and attribution', () => {
  it('keeps keyless Ollama and legacy review fallback when managed keys are connected', () => {
    const runtime = {
      disabled: [],
      managed: [
        {
          id: -1,
          provider: 'nvidia' as const,
          model: 'managed-model',
          apiKey: 'managed',
          baseUrl: CONTRIBUTOR_POLICY.NVIDIA_URL,
        },
      ],
    }
    process.env.TRIOS_QUEEN_WORKER_BASE_URL = 'http://127.0.0.1:11434'
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'ollama'
    delete process.env.TRIOS_QUEEN_WORKER_API_KEY
    delete process.env.TRIOS_QUEEN_WORKER_API_KEY_2
    delete process.env.TRIOS_QUEEN_WORKER_API_KEY_3
    expect(resolveWorkerProvider([], undefined, runtime)).toMatchObject({
      provider: 'ollama',
      keyIndex: 0,
      apiKey: 'local',
    })
    expect(workerCapacityBreakdown(runtime).connectedCredentials).toBe(2)
    expect(
      reviewLaneCandidates([], runtime).map((key) => key.provider),
    ).toEqual(['ollama', 'openai-compatible'])
    delete process.env.TRIOS_QUEEN_WORKER_BASE_URL
    delete process.env.TRIOS_QUEEN_WORKER_PROVIDER
    process.env.ZAI_API_KEY = 'zai-test'
    process.env.ANTHROPIC_API_KEY = 'anthropic-test'
    expect(
      reviewLaneCandidates([], { ...runtime, disabled: [0] }).map((key) => [
        key.provider,
        key.keyIndex,
      ]),
    ).toEqual([
      ['anthropic', undefined],
      ['openai-compatible', -1],
    ])
    process.env.ANTHROPIC_API_KEY = 'managed'
    expect(
      reviewLaneCandidates([-1, -1], { ...runtime, disabled: [0] }),
    ).toEqual([])
  })
  it('disabling an environment key preserves the remaining historical indices', () => {
    process.env.TRIOS_QUEEN_WORKER_BASE_URL = CONTRIBUTOR_POLICY.NVIDIA_URL
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'openai-compatible'
    process.env.TRIOS_QUEEN_WORKER_MODEL = 'measured-model'
    process.env.TRIOS_QUEEN_WORKER_API_KEY = 'key-a'
    process.env.TRIOS_QUEEN_WORKER_API_KEY_2 = 'key-b'
    process.env.TRIOS_QUEEN_WORKER_API_KEY_3 = 'key-c'
    const roster = environmentContributorKeys()
    expect(roster.map((key) => key.id)).toEqual([0, 1, 2])
    const runtime = { managed: [], disabled: [0, 1] }
    expect(resolveWorkerProvider([], undefined, runtime)).toMatchObject({
      keyIndex: 2,
      apiKey: 'key-c',
    })
    expect(workerCapacityBreakdown(runtime).connectedCredentials).toBe(1)
    expect(environmentContributorKeys().map((key) => key.id)).toEqual([0, 1, 2])
    expect(
      workerProbeEndpoint({ managed: [], disabled: [0, 1, 2] }),
    ).toBeUndefined()
  })
  it('managed IDs remain negative in round-robin and the next persisted cursor', () => {
    process.env.TRIOS_QUEEN_WORKER_BASE_URL = CONTRIBUTOR_POLICY.NVIDIA_URL
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'openai-compatible'
    process.env.TRIOS_QUEEN_WORKER_API_KEY = 'key-a'
    delete process.env.TRIOS_QUEEN_WORKER_API_KEY_2
    delete process.env.TRIOS_QUEEN_WORKER_API_KEY_3
    const runtime = {
      disabled: [],
      managed: [
        {
          id: -9,
          provider: 'nvidia' as const,
          model: 'model',
          apiKey: 'managed',
          baseUrl: CONTRIBUTOR_POLICY.NVIDIA_URL,
        },
      ],
    }
    expect(resolveWorkerProvider([], 0, runtime)?.keyIndex).toBe(-9)
    expect(resolveWorkerProvider([], -9, runtime)?.keyIndex).toBe(0)
    expect(
      latestProviderKeyIndex([
        { key_index: 0, dispatched_at: '2026-10-01T00:00:00Z' },
        { key_index: -9, dispatched_at: '2026-10-01T00:01:00Z' },
      ]),
    ).toBe(-9)
  })
  it('the real t27 compiler verifies the host policy bindings', async () => {
    const analyze = await loadCompiler(
      await readFile(
        new URL('../../../../specs/t27_compiler.wasm', import.meta.url),
      ),
    )
    const source = await readFile(
      new URL(
        '../../../../specs/automation/queen-contributor-keys.t27',
        import.meta.url,
      ),
      'utf8',
    )
    const result = analyze(source)
    expect(result.typecheckOk).toBe(true)
    expect(result.discarded).toBe(0)
    expect(CONTRIBUTOR_POLICY.__NOT_EMITTED__).toEqual([])
    for (const name of CONTRIBUTOR_POLICY.__DECL_ORDER__)
      expect(result.consts[name]?.value).toEqual(CONTRIBUTOR_POLICY[name])
  })
})

describe('one model for all keys of a provider', () => {
  const key = {
    provider: 'nvidia' as const,
    model: 'z-ai/glm-5.3',
    apiKey: 'never-reflect-this-secret',
  }
  it('accepts catalog model ids and refuses anything else', () => {
    for (const model of [
      'z-ai/glm-5.3',
      'glm-4.5-flash',
      'nvidia/nemotron-3-super-120b-a12b',
      'a'.repeat(CONTRIBUTOR_POLICY.MODEL_LIMIT),
    ])
      expect(validModel(model)).toBe(true)
    for (const model of [
      '',
      ' z-ai/glm-5.3',
      'glm 5',
      '../glm',
      'glm\n',
      'a'.repeat(CONTRIBUTOR_POLICY.MODEL_LIMIT + 1),
      42,
      null,
    ])
      expect(validModel(model)).toBe(false)
  })
  it('a model passes only by calling the offered tool', async () => {
    const seen: Record<string, unknown>[] = []
    const answer = (status: number, body: unknown) =>
      (async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)))
        return Response.json(body, { status })
      }) as typeof fetch
    expect(
      await checkModel(
        key,
        answer(200, {
          choices: [{ message: { tool_calls: [{ id: 'ping' }] } }],
        }),
      ),
    ).toBe('ok')
    expect(seen[0]).toMatchObject({
      model: 'z-ai/glm-5.3',
      max_tokens: CONTRIBUTOR_POLICY.MODEL_PROBE_MAX_TOKENS,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'ping' } }],
    })
    expect(
      await checkModel(
        key,
        answer(200, { choices: [{ message: { content: 'pong' } }] }),
      ),
    ).toBe('no_tool_call')
    for (const status of [400, 404, 410, 422])
      expect(await checkModel(key, answer(status, {}))).toBe('unknown_model')
    for (const status of [401, 429, 500, 503])
      expect(await checkModel(key, answer(status, {}))).toBe('inconclusive')
    expect(
      await checkModel(key, (async () => {
        throw new Error(key.apiKey)
      }) as typeof fetch),
    ).toBe('inconclusive')
  })
  it('lists catalog ids, drops malformed ones and never caches a failed read', async () => {
    resetProviderModels()
    let reads = 0
    const broken = (async () => {
      reads++
      return new Response('down', { status: 503 })
    }) as typeof fetch
    expect(await providerModels(key, broken)).toEqual([])
    expect(await providerModels(key, broken)).toEqual([])
    expect(reads).toBe(2)
    const catalog = (async (url, init) => {
      reads++
      expect(url).toBe(`${CONTRIBUTOR_POLICY.NVIDIA_URL}/models`)
      expect(init?.redirect).toBe('error')
      return Response.json({
        data: [
          { id: 'z-ai/glm-5.3' },
          { id: 'z-ai/glm-5.3' },
          { id: 'has space' },
          { id: 7 },
          { id: 'a-model' },
        ],
      })
    }) as typeof fetch
    expect(await providerModels(key, catalog)).toEqual([
      'a-model',
      'z-ai/glm-5.3',
    ])
    expect(await providerModels(key, broken)).toEqual([
      'a-model',
      'z-ai/glm-5.3',
    ])
    expect(reads).toBe(3)
    resetProviderModels()
  })
  it('the owner model is the one most of their keys of the provider run', () => {
    expect(
      ownerModel(
        [
          { provider: 'nvidia', model: 'b' },
          { provider: 'nvidia', model: 'a' },
          { provider: 'nvidia', model: 'b' },
          { provider: 'zai', model: 'z' },
        ],
        'nvidia',
      ),
    ).toBe('b')
    expect(ownerModel([], 'zai')).toBe(CONTRIBUTOR_POLICY.ZAI_MODEL)
  })
  it('bees and reviews run on the owner model while the pool keeps its own', () => {
    process.env.TRIOS_QUEEN_WORKER_BASE_URL = CONTRIBUTOR_POLICY.NVIDIA_URL
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'openai-compatible'
    process.env.TRIOS_QUEEN_WORKER_MODEL = 'pool-model'
    process.env.TRIOS_QUEEN_WORKER_API_KEY = 'key-a'
    process.env.TRIOS_QUEEN_WORKER_API_KEY_2 = 'key-b'
    delete process.env.TRIOS_QUEEN_WORKER_API_KEY_3
    const runtime = { managed: [], disabled: [], models: { 1: 'z-ai/glm-5.3' } }
    expect(resolveWorkerProvider([0, 0], undefined, runtime)).toMatchObject({
      keyIndex: 1,
      model: 'z-ai/glm-5.3',
    })
    expect(resolveWorkerProvider([1, 1], undefined, runtime)).toMatchObject({
      keyIndex: 0,
      model: 'pool-model',
    })
    expect(
      reviewLaneCandidates([], runtime).map((lane) => [
        lane.keyIndex,
        lane.model,
      ]),
    ).toEqual([
      [0, 'pool-model'],
      [1, 'z-ai/glm-5.3'],
    ])
    expect(workerCapacityBreakdown(runtime).connectedCredentials).toBe(2)
    // Without a choice, allocation stays the environment path.
    expect(
      resolveWorkerProvider([], undefined, {
        managed: [],
        disabled: [],
        models: {},
      }),
    ).toMatchObject({ keyIndex: 0, model: 'pool-model' })
  })
})
