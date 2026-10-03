import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import {
  addContributorKey,
  CONTRIBUTOR_PROVIDERS,
  ContributorError,
  changeContributorKey,
  contributorGithub,
  type EnvironmentKey,
  listContributorKeys,
  openCredential,
  ownerModel,
  providerModels,
  setContributorModel,
  trustedContributor,
} from '../services/queen-contributor-keys'
import { CONTRIBUTOR_POLICY } from '../services/queen-contributor-policy'
import { environmentContributorKeys } from '../services/queen-dispatch'
import {
  ACCEPTED_XP,
  HOUR_XP,
  keyWork,
  parseOwners,
  rank,
  SPEC_XP,
} from '../services/queen-leaderboard'

export interface ContributorRouteDeps {
  pool?: () => Pool
  environment?: () => EnvironmentKey[]
  owners?: () => Record<number, string>
  fetcher?: typeof fetch
}
let productionPool: Pool | undefined
function poolForKeys(): Pool {
  const url = process.env.DATABASE_URL
  if (!url) throw new ContributorError('contributor_keys_unavailable', 503)
  productionPool ??= createQueenPool(url)
  return productionPool
}
const emptyContribution = () => ({
  xp: 0,
  accepted: 0,
  specs: 0,
  finished: 0,
  hours: 0,
})
async function contributionOf(pool: Pool, id: number) {
  const work = (await keyWork(pool)).filter((entry) => entry.keyIndex === id)
  const total = rank(work, {})[0]
  return total
    ? {
        xp: total.xp,
        accepted: total.accepted,
        specs: total.specs ?? 0,
        finished: total.finished,
        hours: total.hours,
      }
    : emptyContribution()
}

/** Render attests a verified app subject. No browser can self-assert ownership. */
export function createQueenContributorKeysRoute(
  deps: ContributorRouteDeps = {},
) {
  const app = new Hono<{ Variables: { contributor: string; body: string } }>()
  app.use('/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    try {
      c.set(
        'contributor',
        trustedContributor(
          c.req.header('authorization'),
          c.req.header('x-queen-contributor-id'),
        ),
      )
      return await next()
    } catch (error) {
      const known =
        error instanceof ContributorError
          ? error
          : new ContributorError('contributor_keys_unavailable', 503)
      return c.json({ error: known.code }, known.status as 400)
    }
  })
  app.use('/*', async (c, next) => {
    if (c.req.method !== 'POST') return next()
    const reader = c.req.raw.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > CONTRIBUTOR_POLICY.MAX_BODY_BYTES) {
            await reader.cancel()
            throw new ContributorError('request_too_large', 413)
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
    }
    c.set('body', Buffer.concat(chunks).toString('utf8'))
    return await next()
  })
  const environmentOf = () => (deps.environment ?? environmentContributorKeys)()
  const ownersOf = () =>
    (deps.owners ?? (() => parseOwners(process.env.TRIOS_KEY_OWNERS)))()
  const account = async (pool: Pool, subject: string) => {
    const keys = await listContributorKeys(
      pool,
      subject,
      environmentOf(),
      ownersOf(),
    )
    const work = await keyWork(pool)
    const byKey = new Map(work.map((item) => [item.keyIndex, item]))
    const own = work.filter((item) =>
      keys.some((key) => key.id === item.keyIndex),
    )
    const totals = rank(
      own,
      Object.fromEntries(keys.map((key) => [key.id, 'own'])),
    )[0]
    const contribution = (entry: typeof totals) =>
      entry
        ? {
            xp: entry.xp,
            accepted: entry.accepted,
            specs: entry.specs ?? 0,
            finished: entry.finished,
            hours: entry.hours,
          }
        : emptyContribution()
    return {
      keys: keys.map((key) => {
        const entry = byKey.get(key.id)
        return {
          ...key,
          contribution: contribution(rank(entry ? [entry] : [], {})[0]),
        }
      }),
      // `model` is what this owner's keys of the provider run on now;
      // `defaultModel` is what a provider starts on before any choice.
      providers: CONTRIBUTOR_PROVIDERS.map(({ id, label, model }) => ({
        id,
        label,
        model: ownerModel(keys, id),
        defaultModel: model,
      })),
      contribution: contribution(totals),
      attribution: { subject, github: contributorGithub(subject) },
      scoring: { acceptedXp: ACCEPTED_XP, specXp: SPEC_XP, hourXp: HOUR_XP },
    }
  }
  app.get('/', async (c) => {
    const pool = (deps.pool ?? poolForKeys)()
    return c.json(await account(pool, c.get('contributor')))
  })
  app.get('/models/:provider', async (c) => {
    const provider = CONTRIBUTOR_PROVIDERS.find(
      (p) => p.id === c.req.param('provider'),
    )
    if (!provider) throw new ContributorError('unsupported_provider')
    const pool = (deps.pool ?? poolForKeys)()
    const subject = c.get('contributor')
    const environment = environmentOf()
    const keys = (
      await listContributorKeys(pool, subject, environment, ownersOf())
    ).filter((key) => key.provider === provider.id)
    if (!keys.length) throw new ContributorError('key_not_found', 404)
    // The catalog is read with one of the owner's own keys, never an operator's.
    let apiKey = environment.find((entry) =>
      keys.some((key) => key.source === 'environment' && key.id === entry.id),
    )?.apiKey
    if (!apiKey) {
      const { rows } = await pool.query<{
        sealed: string
        fingerprint: string
      }>(
        "SELECT sealed,fingerprint FROM queen_contributor_keys WHERE owner_subject=$1 AND provider=$2 AND source='managed' AND sealed IS NOT NULL LIMIT 1",
        [subject, provider.id],
      )
      if (rows[0])
        apiKey = openCredential(rows[0].sealed, subject, rows[0].fingerprint)
    }
    if (!apiKey) throw new ContributorError('key_not_found', 404)
    return c.json({
      provider: provider.id,
      model: ownerModel(keys, provider.id),
      models: await providerModels(
        { provider: provider.id, apiKey },
        deps.fetcher,
      ),
    })
  })
  app.post('/model', async (c) => {
    let body: unknown
    try {
      body = JSON.parse(c.get('body'))
    } catch {
      throw new ContributorError('invalid_json')
    }
    const pool = (deps.pool ?? poolForKeys)()
    const subject = c.get('contributor')
    await setContributorModel(
      pool,
      subject,
      body,
      environmentOf(),
      ownersOf(),
      deps.fetcher,
    )
    return c.json(await account(pool, subject))
  })
  app.post('/', async (c) => {
    let body: unknown
    try {
      body = JSON.parse(c.get('body'))
    } catch {
      throw new ContributorError('invalid_json')
    }
    const pool = (deps.pool ?? poolForKeys)()
    const key = await addContributorKey(
      pool,
      c.get('contributor'),
      body,
      (deps.environment ?? environmentContributorKeys)(),
      deps.fetcher,
    )
    return c.json(
      { key: { ...key, contribution: await contributionOf(pool, key.id) } },
      201,
    )
  })
  app.post('/:id/:action', async (c) => {
    const raw = c.req.param('id')
    const id = Number(raw)
    if (
      raw !== String(id) ||
      !/^-?(?:0|[1-9][0-9]*)$/.test(raw) ||
      !Number.isInteger(id) ||
      id < -2147483647 ||
      id > 2147483647
    ) {
      throw new ContributorError('invalid_key_id')
    }
    const action = c.req.param('action')
    if (action !== 'probe' && action !== 'enable' && action !== 'disable')
      throw new ContributorError('invalid_action')
    const pool = (deps.pool ?? poolForKeys)()
    const key = await changeContributorKey(
      pool,
      c.get('contributor'),
      id,
      action,
      (deps.environment ?? environmentContributorKeys)(),
      (deps.owners ?? (() => parseOwners(process.env.TRIOS_KEY_OWNERS)))(),
      deps.fetcher,
    )
    return c.json({
      key: { ...key, contribution: await contributionOf(pool, key.id) },
    })
  })
  app.onError((error, c) => {
    const known =
      error instanceof ContributorError
        ? error
        : new ContributorError('contributor_keys_unavailable', 503)
    return c.json({ error: known.code }, known.status as 400)
  })
  return app
}
