import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { createQueenContributorKeysRoute } from '../../src/api/routes/queen-contributor-keys'
import {
  addContributorKey,
  changeContributorKey,
  contributorOwnerNames,
  contributorRuntime,
  ensureContributorKeys,
  listContributorKeys,
  setContributorModel,
} from '../../src/api/services/queen-contributor-keys'
import { CONTRIBUTOR_POLICY } from '../../src/api/services/queen-contributor-policy'
import { keyWork, leaderboard } from '../../src/api/services/queen-leaderboard'

// Deliberate, isolated PostgreSQL. A skip is not a live database pass.
const url =
  process.env.QUEEN_CONTRIBUTOR_TEST_DATABASE_URL ??
  process.env.TRIOS_PG_TEST_URL
const live = url ? describe : describe.skip
live('contributor ownership and allocation against real PostgreSQL', () => {
  const subject = 'telegram:111222333'
  const other = 'telegram:999888777'
  const token = 'test-only-proxy-capability-32-bytes-minimum'
  const schema = `contributor_${randomUUID().replaceAll('-', '')}`
  let pool: Pool
  let admin: Pool
  const saved = new Map<string, string | undefined>()
  const names = [
    'QUEEN_CONTRIBUTOR_PROXY_TOKEN',
    'QUEEN_CONTRIBUTOR_ENCRYPTION_KEY',
    'QUEEN_CONTRIBUTOR_IDENTITIES',
    'TRIOS_KEY_OWNERS',
  ]
  const fetchOk = (async () =>
    Response.json({
      choices: [{ message: { content: 'OK' } }],
    })) as typeof fetch
  const environment = [
    {
      id: 10000,
      provider: 'nvidia' as const,
      model: 'production-model',
      apiKey: 'existing-private-credential',
      baseUrl: CONTRIBUTOR_POLICY.NVIDIA_URL,
    },
  ]
  const owners = { 10000: '@dmitrii-f-t27' }
  beforeAll(async () => {
    for (const name of names) saved.set(name, process.env[name])
    process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN = token
    process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY = Buffer.alloc(
      32,
      91,
    ).toString('base64')
    process.env.QUEEN_CONTRIBUTOR_IDENTITIES = JSON.stringify({
      [subject]: 'dmitrii-f-t27',
      [other]: 'other-person',
    })
    process.env.TRIOS_KEY_OWNERS = '10000=@dmitrii-f-t27'
    admin = new Pool({ connectionString: url })
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 8,
    })
    await ensureContributorKeys(pool)
    await pool.query(`CREATE TABLE queen_dispatch (key_index integer,review_state text,dispatched_at timestamptz,finished_at timestamptz,owned_paths jsonb);
      CREATE TABLE queen_dispatch_history (snapshot jsonb,archived_at timestamptz);`)
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE queen_contributor_keys,queen_dispatch,queen_dispatch_history',
    )
    await pool.query(
      'ALTER SEQUENCE queen_contributor_key_index RESTART WITH -1',
    )
  })
  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin?.end()
    for (const name of names) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  it('keeps plaintext out of SQL rows and out of every own-account JSON response', async () => {
    const secret = 'a-private-managed-test-credential'
    const added = await addContributorKey(
      pool,
      subject,
      { provider: 'nvidia', apiKey: secret },
      environment,
      fetchOk,
    )
    expect(added.id).toBeLessThan(0)
    expect(added.enabled).toBe(true)
    const stored = await pool.query('SELECT * FROM queen_contributor_keys')
    expect(JSON.stringify(stored.rows)).not.toContain(secret)
    expect(stored.rows[0].owner_name).toBe('@dmitrii-f-t27')
    const listed = await listContributorKeys(pool, subject, environment, owners)
    expect(listed.map((key) => key.id)).toEqual([added.id, 10000])
    expect(JSON.stringify(listed)).not.toContain(secret)
    const runtime = await contributorRuntime(pool, environment)
    expect(runtime.managed).toHaveLength(1)
    expect(runtime.managed[0].apiKey).toBe(secret)
  })
  it('rejects IDOR at the actual route for every mutation and excludes others from GET', async () => {
    const added = await addContributorKey(
      pool,
      subject,
      { provider: 'zai', apiKey: 'key-owned-by-first' },
      environment,
      fetchOk,
    )
    const app = new Hono().route(
      '/queen/contributor-keys',
      createQueenContributorKeysRoute({
        pool: () => pool,
        environment: () => environment,
        owners: () => owners,
        fetcher: fetchOk,
      }),
    )
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Queen-Contributor-Id': other,
    }
    const list = await app.request('/queen/contributor-keys', { headers })
    expect(list.status).toBe(200)
    expect((await list.json()).keys).toEqual([])
    for (const id of [added.id, 10000])
      for (const action of ['disable', 'enable', 'probe']) {
        const denied = await app.request(
          `/queen/contributor-keys/${id}/${action}`,
          { method: 'POST', headers },
        )
        expect(denied.status).toBe(404)
        expect(await denied.json()).toEqual({ error: 'key_not_found' })
      }
    expect((await contributorRuntime(pool, environment)).managed).toHaveLength(
      1,
    )
  })
  it('excludes unreadable managed keys and allows their owner to disable without the master key', async () => {
    const added = await addContributorKey(
      pool,
      subject,
      { provider: 'nvidia', apiKey: 'corrupt-test' },
      environment,
      fetchOk,
    )
    const healthy = await addContributorKey(
      pool,
      subject,
      { provider: 'nvidia', apiKey: 'healthy-test' },
      environment,
      fetchOk,
    )
    await changeContributorKey(
      pool,
      subject,
      10000,
      'disable',
      environment,
      owners,
      fetchOk,
    )
    await pool.query(
      'UPDATE queen_contributor_keys SET sealed=$2 WHERE key_index=$1',
      [added.id, 'corrupt.ciphertext.value'],
    )
    expect(await contributorRuntime(pool, environment)).toMatchObject({
      disabled: [10000],
      managed: [{ id: healthy.id }],
    })
    const master = process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY
    delete process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY
    try {
      await expect(
        changeContributorKey(
          pool,
          other,
          added.id,
          'disable',
          environment,
          owners,
          fetchOk,
        ),
      ).rejects.toMatchObject({ code: 'key_not_found' })
      const disabled = await changeContributorKey(
        pool,
        subject,
        added.id,
        'disable',
        environment,
        owners,
        fetchOk,
      )
      expect(disabled.enabled).toBe(false)
      expect(await contributorRuntime(pool, environment)).toEqual({
        disabled: [10000],
        managed: [],
        models: {},
      })
    } finally {
      process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY = master
    }
  })
  it('retains persisted consent and ownership when the management capability is removed', async () => {
    const added = await addContributorKey(
      pool,
      subject,
      { provider: 'zai', apiKey: 'persisted-consent' },
      environment,
      fetchOk,
    )
    await changeContributorKey(
      pool,
      subject,
      10000,
      'disable',
      environment,
      owners,
      fetchOk,
    )
    const capability = process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN
    delete process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN
    try {
      expect(await contributorRuntime(pool, environment)).toMatchObject({
        disabled: [10000],
        managed: [{ id: added.id }],
      })
      expect(await contributorOwnerNames(pool)).toEqual({
        [added.id]: '@dmitrii-f-t27',
        10000: '@dmitrii-f-t27',
      })
      await changeContributorKey(
        pool,
        subject,
        added.id,
        'disable',
        environment,
        owners,
        fetchOk,
      )
      expect(await contributorRuntime(pool, environment)).toEqual({
        disabled: [10000],
        managed: [],
        models: {},
      })
    } finally {
      process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN = capability
    }
  })
  it('rejects duplicates across both owners and environment, including concurrent additions', async () => {
    await expect(
      addContributorKey(
        pool,
        subject,
        { provider: 'nvidia', apiKey: environment[0].apiKey },
        environment,
        fetchOk,
      ),
    ).rejects.toThrow('key_already_connected')
    const results = await Promise.allSettled(
      [subject, other].map((owner) =>
        addContributorKey(
          pool,
          owner,
          { provider: 'zai', apiKey: 'one-shared-test-credential' },
          environment,
          fetchOk,
        ),
      ),
    )
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)
    expect(
      (await pool.query('SELECT * FROM queen_contributor_keys')).rows,
    ).toHaveLength(1)
  })
  it('disables the matching environment fingerprint without storing or reassigning it', async () => {
    await changeContributorKey(
      pool,
      subject,
      10000,
      'disable',
      environment,
      owners,
      fetchOk,
    )
    expect((await contributorRuntime(pool, environment)).disabled).toEqual([
      10000,
    ])
    const row = (await pool.query('SELECT * FROM queen_contributor_keys'))
      .rows[0]
    expect(row.sealed).toBeNull()
    expect(JSON.stringify(row)).not.toContain(environment[0].apiKey)
    await expect(
      changeContributorKey(
        pool,
        other,
        10000,
        'enable',
        environment,
        { 10000: '@other-person' },
        fetchOk,
      ),
    ).rejects.toThrow('key_not_found')
    expect(
      await listContributorKeys(pool, other, environment, {
        10000: '@other-person',
      }),
    ).toEqual([])
    expect(
      (
        await contributorRuntime(pool, [
          { ...environment[0], apiKey: 'replaced-secret' },
        ])
      ).disabled,
    ).toEqual([])
    await expect(
      changeContributorKey(
        pool,
        subject,
        10000,
        'probe',
        [{ ...environment[0], apiKey: 'replaced-secret' }],
        owners,
        fetchOk,
      ),
    ).rejects.toThrow('key_binding_conflict')
  })
  it('does not let a late enable probe undo a later disable', async () => {
    const added = await addContributorKey(
      pool,
      subject,
      { provider: 'nvidia', apiKey: 'test-race-key' },
      environment,
      fetchOk,
    )
    await pool.query(
      "UPDATE queen_contributor_keys SET probe_at=now()-interval '2 minutes'",
    )
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const enable = changeContributorKey(
      pool,
      subject,
      added.id,
      'enable',
      environment,
      owners,
      (async () => {
        started()
        await pending
        return Response.json({ choices: [{ message: { content: 'OK' } }] })
      }) as typeof fetch,
    )
    await entered
    await changeContributorKey(
      pool,
      subject,
      added.id,
      'disable',
      environment,
      owners,
      fetchOk,
    )
    release()
    expect((await enable).enabled).toBe(false)
    expect((await contributorRuntime(pool, environment)).managed).toEqual([])
  })
  it('records failures, bounds repeated probes and requires usable inference before enabling', async () => {
    const bad = await addContributorKey(
      pool,
      subject,
      { provider: 'zai', apiKey: 'bad-test-key' },
      environment,
      (async () =>
        new Response('secret-containing upstream error', {
          status: 401,
        })) as typeof fetch,
    )
    expect(bad.enabled).toBe(false)
    expect(bad.lastProbe.status).toBe('invalid')
    await expect(
      changeContributorKey(
        pool,
        subject,
        bad.id,
        'probe',
        environment,
        owners,
        fetchOk,
      ),
    ).rejects.toThrow('probe_rate_limited')
    await pool.query(
      "UPDATE queen_contributor_keys SET probe_at=now()-interval '2 minutes'",
    )
    expect(
      (
        await changeContributorKey(
          pool,
          subject,
          bad.id,
          'enable',
          environment,
          owners,
          fetchOk,
        )
      ).enabled,
    ).toBe(true)
  })
  it('counts negative IDs in archived work and retains existing environment XP under the same owner', async () => {
    const added = await addContributorKey(
      pool,
      subject,
      { provider: 'nvidia', apiKey: 'worked-key' },
      environment,
      fetchOk,
    )
    await pool.query(
      `INSERT INTO queen_dispatch VALUES (10000,'accept','2026-09-30T00:00:00Z','2026-09-30T01:00:00Z','["specs/existing.t27"]')`,
    )
    await pool.query(`INSERT INTO queen_dispatch_history VALUES ($1,now())`, [
      JSON.stringify({
        key_index: added.id,
        review_state: 'accept',
        dispatched_at: '2026-09-30T00:00:00Z',
        finished_at: '2026-09-30T02:00:00Z',
        owned_paths: [],
      }),
    ])
    expect((await keyWork(pool)).map((row) => row.keyIndex)).toContain(added.id)
    const board = await leaderboard(pool)
    expect(board.contributors).toHaveLength(1)
    expect(board.contributors[0]).toMatchObject({
      github: 'dmitrii-f-t27',
      keys: [added.id, 10000],
      xp: 430,
      accepted: 2,
      specs: 1,
      hours: 3,
    })
    expect((await contributorOwnerNames(pool))[added.id]).toBe('@dmitrii-f-t27')
    const app = new Hono().route(
      '/queen/contributor-keys',
      createQueenContributorKeysRoute({
        pool: () => pool,
        environment: () => environment,
        owners: () => owners,
        fetcher: fetchOk,
      }),
    )
    const response = await app.request(
      '/queen/contributor-keys/10000/disable',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Queen-Contributor-Id': subject,
        },
      },
    )
    expect(response.status).toBe(200)
    expect((await response.json()).key.contribution).toEqual({
      xp: 310,
      accepted: 1,
      specs: 1,
      finished: 1,
      hours: 1,
    })
  })
  describe("one model for all of an owner's keys of a provider", () => {
    const toolCall = (calls: string[]) =>
      (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)).model)
        return Response.json({
          choices: [{ message: { tool_calls: [{ id: 'ping' }] } }],
        })
      }) as typeof fetch
    const app = (env = environment, fetcher: typeof fetch = fetchOk) =>
      new Hono().route(
        '/queen/contributor-keys',
        createQueenContributorKeysRoute({
          pool: () => pool,
          environment: () => env,
          owners: () => owners,
          fetcher,
        }),
      )
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Queen-Contributor-Id': subject,
      'Content-Type': 'application/json',
    }
    it('a stale binding row never overrides a changed pool model', async () => {
      await changeContributorKey(
        pool,
        subject,
        10000,
        'probe',
        environment,
        owners,
        fetchOk,
      )
      const moved = [{ ...environment[0], model: 'new-pool-model' }]
      const keys = await listContributorKeys(pool, subject, moved, owners)
      expect(keys.find((key) => key.id === 10000)?.model).toBe('new-pool-model')
      expect((await contributorRuntime(pool, moved)).models).toEqual({})
    })
    it('changes nothing unless a key of the provider called a tool with the model', async () => {
      const mine = await addContributorKey(
        pool,
        subject,
        { provider: 'nvidia', apiKey: 'managed-nvidia' },
        environment,
        fetchOk,
      )
      for (const [fetcher, code] of [
        [
          (async () =>
            new Response('no such model', { status: 404 })) as typeof fetch,
          'model_unavailable',
        ],
        [
          (async () =>
            Response.json({
              choices: [{ message: { content: 'pong' } }],
            })) as typeof fetch,
          'model_without_tools',
        ],
      ] as const)
        await expect(
          setContributorModel(
            pool,
            subject,
            { provider: 'nvidia', model: 'z-ai/glm-5.3' },
            environment,
            owners,
            fetcher,
          ),
        ).rejects.toThrow(code)
      let calls = 0
      await expect(
        setContributorModel(
          pool,
          subject,
          { provider: 'nvidia', model: 'z-ai/glm-5.3' },
          environment,
          owners,
          (async () => {
            calls++
            return new Response('busy', { status: 429 })
          }) as typeof fetch,
        ),
      ).rejects.toThrow('model_check_failed')
      expect(calls).toBe(CONTRIBUTOR_POLICY.MODEL_CHECK_ATTEMPTS)
      const keys = await listContributorKeys(pool, subject, environment, owners)
      expect(keys.map((key) => key.model)).toEqual([
        'nvidia/nemotron-3-ultra-550b-a55b',
        'production-model',
      ])
      expect(mine.model).toBe(CONTRIBUTOR_POLICY.NVIDIA_MODEL)
      expect((await contributorRuntime(pool, environment)).models).toEqual({})
    })
    it('switches every owned key of the provider and nothing else', async () => {
      const mine = await addContributorKey(
        pool,
        subject,
        { provider: 'nvidia', apiKey: 'managed-nvidia' },
        environment,
        fetchOk,
      )
      const zai = await addContributorKey(
        pool,
        subject,
        { provider: 'zai', apiKey: 'managed-zai' },
        environment,
        fetchOk,
      )
      const theirs = await addContributorKey(
        pool,
        other,
        { provider: 'nvidia', apiKey: 'their-nvidia' },
        environment,
        fetchOk,
      )
      const calls: string[] = []
      const result = await setContributorModel(
        pool,
        subject,
        { provider: 'nvidia', model: 'z-ai/glm-5.3' },
        environment,
        owners,
        toolCall(calls),
      )
      expect(calls).toEqual(['z-ai/glm-5.3'])
      expect(result).toEqual({
        provider: 'nvidia',
        model: 'z-ai/glm-5.3',
        keys: 2,
      })
      const keys = await listContributorKeys(pool, subject, environment, owners)
      expect(
        Object.fromEntries(keys.map((key) => [key.id, key.model])),
      ).toEqual({
        [mine.id]: 'z-ai/glm-5.3',
        [zai.id]: CONTRIBUTOR_POLICY.ZAI_MODEL,
        10000: 'z-ai/glm-5.3',
      })
      const runtime = await contributorRuntime(pool, environment)
      expect(runtime.models).toEqual({ 10000: 'z-ai/glm-5.3' })
      expect(
        Object.fromEntries(runtime.managed.map((key) => [key.id, key.model])),
      ).toEqual({
        [mine.id]: 'z-ai/glm-5.3',
        [zai.id]: CONTRIBUTOR_POLICY.ZAI_MODEL,
        [theirs.id]: CONTRIBUTOR_POLICY.NVIDIA_MODEL,
      })
      // A probe asks the chosen model, and a new key joins it.
      const probed: string[] = []
      await pool.query(
        "UPDATE queen_contributor_keys SET probe_at=now()-interval '2 minutes'",
      )
      await changeContributorKey(
        pool,
        subject,
        10000,
        'probe',
        environment,
        owners,
        toolCall(probed),
      )
      expect(probed).toEqual(['z-ai/glm-5.3'])
      const later = await addContributorKey(
        pool,
        subject,
        { provider: 'nvidia', apiKey: 'later-nvidia' },
        environment,
        toolCall(probed),
      )
      expect(later.model).toBe('z-ai/glm-5.3')
    })
    it('a managed copy of an environment secret carries the choice to that environment key', async () => {
      await addContributorKey(
        pool,
        subject,
        { provider: 'nvidia', apiKey: 'copied-later-into-environment' },
        [],
        fetchOk,
      )
      const both = [
        ...environment,
        {
          id: 10001,
          provider: 'nvidia' as const,
          model: 'production-model',
          apiKey: 'copied-later-into-environment',
          baseUrl: CONTRIBUTOR_POLICY.NVIDIA_URL,
        },
      ]
      const withCopy = { ...owners, 10001: '@dmitrii-f-t27' }
      await setContributorModel(
        pool,
        subject,
        { provider: 'nvidia', model: 'z-ai/glm-5.3' },
        both,
        withCopy,
        toolCall([]),
      )
      expect((await contributorRuntime(pool, both)).models).toEqual({
        10000: 'z-ai/glm-5.3',
        10001: 'z-ai/glm-5.3',
      })
    })
    it('serves the switch and the owner model through the route, refusing other fields first', async () => {
      let fetched = 0
      const counting = (async (url, init) => {
        fetched++
        return toolCall([])(url, init)
      }) as typeof fetch
      for (const body of [
        { provider: 'nvidia', model: 'z-ai/glm-5.3', owner: 'telegram:1' },
        { provider: 'nvidia', model: 'bad model' },
        { provider: 'openai', model: 'gpt' },
        { provider: 'nvidia', model: 'a'.repeat(129) },
      ]) {
        const response = await app(environment, counting).request(
          '/queen/contributor-keys/model',
          { method: 'POST', headers, body: JSON.stringify(body) },
        )
        expect(response.status).toBe(400)
      }
      expect(fetched).toBe(0)
      const response = await app(environment, counting).request(
        '/queen/contributor-keys/model',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ provider: 'nvidia', model: 'z-ai/glm-5.3' }),
        },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const account = await response.json()
      expect(account.providers).toEqual([
        {
          id: 'nvidia',
          label: 'NVIDIA NIM',
          model: 'z-ai/glm-5.3',
          defaultModel: CONTRIBUTOR_POLICY.NVIDIA_MODEL,
        },
        {
          id: 'zai',
          label: 'Z.ai',
          model: CONTRIBUTOR_POLICY.ZAI_MODEL,
          defaultModel: CONTRIBUTOR_POLICY.ZAI_MODEL,
        },
      ])
      expect(JSON.stringify(account)).not.toContain(environment[0].apiKey)
      const foreign = await app(environment, counting).request(
        '/queen/contributor-keys/model',
        {
          method: 'POST',
          headers: { ...headers, 'X-Queen-Contributor-Id': other },
          body: JSON.stringify({ provider: 'nvidia', model: 'z-ai/glm-5.3' }),
        },
      )
      expect(foreign.status).toBe(404)
      const list = await app(environment, (async () =>
        Response.json({
          data: [
            { id: 'z-ai/glm-5.3' },
            { id: 'bad id' },
            { id: 'nvidia/nemotron-3-super-120b-a12b' },
          ],
        })) as typeof fetch).request('/queen/contributor-keys/models/nvidia', {
        headers,
      })
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual({
        provider: 'nvidia',
        model: 'z-ai/glm-5.3',
        models: ['nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3'],
      })
    })
  })
})
