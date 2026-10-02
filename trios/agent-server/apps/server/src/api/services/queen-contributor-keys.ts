import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { CONTRIBUTOR_POLICY as P } from './queen-contributor-policy'

export type ContributorProvider = 'nvidia' | 'zai'
export type ProbeStatus =
  | 'ok'
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'not_checked'
export interface KeyProbe {
  status: ProbeStatus
  checkedAt: string | null
  latencyMs: number | null
}
export interface EnvironmentKey {
  id: number
  apiKey: string
  provider: ContributorProvider
  model: string
  baseUrl: string
  contextWindow?: number
}
export interface ContributorKey {
  id: number
  source: 'managed' | 'environment'
  provider: ContributorProvider
  model: string
  label: string
  fingerprint: string
  enabled: boolean
  createdAt: string | null
  lastProbe: KeyProbe
}
interface KeyRow {
  key_index: number
  source: 'managed' | 'environment'
  fingerprint: string
  owner_subject: string
  owner_name: string
  provider: ContributorProvider
  model: string
  /** True once the owner chose the model; an environment row then overrides its pool's model. */
  model_chosen?: boolean
  label: string
  sealed: string | null
  enabled: boolean
  revision: number
  probe_status: ProbeStatus
  probe_at: Date | string | null
  probe_ms: number | null
  created_at: Date | string
}
export class ContributorError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code)
  }
}
export const CONTRIBUTOR_PROVIDERS = [
  {
    id: 'nvidia' as const,
    label: 'NVIDIA NIM',
    model: P.NVIDIA_MODEL,
    baseUrl: P.NVIDIA_URL,
  },
  { id: 'zai' as const, label: 'Z.ai', model: P.ZAI_MODEL, baseUrl: P.ZAI_URL },
]
/** Provider model ids as both catalogs print them: `z-ai/glm-5.3`, `glm-4.5-flash`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
export function validModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= P.MODEL_LIMIT &&
    MODEL_ID.test(value)
  )
}
const ready = new WeakMap<Pool, Promise<void>>()
export function contributorsEnabled(): boolean {
  return (
    (process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN?.length ?? 0) >=
    P.PROXY_TOKEN_MIN_BYTES
  )
}
export function trustedContributor(
  authorization: string | undefined,
  subject: string | undefined,
): string {
  const expected = process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN ?? ''
  if (!contributorsEnabled())
    throw new ContributorError('contributor_keys_unavailable', 503)
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : ''
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  if (!provided || !timingSafeEqual(a, b))
    throw new ContributorError('forbidden', 403)
  if (
    !subject ||
    subject !== subject.trim() ||
    !/^telegram:[1-9][0-9]{0,19}$/.test(subject)
  ) {
    throw new ContributorError('invalid_contributor', 400)
  }
  return subject
}
export function contributorGithub(subject: string): string | undefined {
  try {
    const identities = JSON.parse(
      process.env.QUEEN_CONTRIBUTOR_IDENTITIES ?? '{}',
    )
    const login = Object.hasOwn(identities, subject)
      ? identities[subject]
      : undefined
    return typeof login === 'string' &&
      login === login.trim() &&
      /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/.test(login)
      ? login
      : undefined
  } catch {
    return undefined
  }
}
export function contributorName(subject: string): string {
  const github = contributorGithub(subject)
  // Never publish a Telegram subject. The pseudonym is stable but not an ID.
  return github
    ? `@${github}`
    : `contributor ${fingerprint(subject).slice(0, 8)}`
}
export function fingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex')
}
function masterKey(): Buffer {
  const encoded = process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY ?? ''
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new ContributorError('key_storage_unavailable', 503)
  }
  return key
}
export function sealCredential(
  secret: string,
  subject: string,
  digest: string,
): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), nonce)
  cipher.setAAD(Buffer.from(`${subject}\n${digest}`))
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ])
  return [nonce, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString('base64'))
    .join('.')
}
export function openCredential(
  sealed: string,
  subject: string,
  digest: string,
): string {
  const parts = sealed.split('.')
  if (parts.length !== 3)
    throw new ContributorError('key_storage_unavailable', 503)
  try {
    const [nonce, tag, ciphertext] = parts.map((part) =>
      Buffer.from(part, 'base64'),
    )
    const cipher = createDecipheriv('aes-256-gcm', masterKey(), nonce)
    cipher.setAAD(Buffer.from(`${subject}\n${digest}`))
    cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString(
      'utf8',
    )
  } catch {
    throw new ContributorError('key_storage_unavailable', 503)
  }
}
export async function ensureContributorKeys(pool: Pool): Promise<void> {
  let promise = ready.get(pool)
  if (!promise) {
    promise = pool
      .query(`
      CREATE SEQUENCE IF NOT EXISTS queen_contributor_key_index AS integer
        INCREMENT BY -1 MINVALUE -2147483647 MAXVALUE -1 START WITH -1 NO CYCLE;
      CREATE TABLE IF NOT EXISTS queen_contributor_keys (
        key_index integer PRIMARY KEY DEFAULT nextval('queen_contributor_key_index'),
        source text NOT NULL CHECK (source IN ('managed','environment')),
        fingerprint text NOT NULL UNIQUE,
        owner_subject text NOT NULL,
        owner_name text NOT NULL,
        provider text NOT NULL CHECK (provider IN ('nvidia','zai')),
        model text NOT NULL,
        label text NOT NULL,
        sealed text,
        enabled boolean NOT NULL DEFAULT false,
        revision integer NOT NULL DEFAULT 0,
        probe_status text NOT NULL DEFAULT 'not_checked'
          CHECK (probe_status IN ('ok','invalid','rate_limited','unavailable','not_checked')),
        probe_at timestamptz,
        probe_ms integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((source='managed' AND key_index<0 AND sealed IS NOT NULL)
          OR (source='environment' AND key_index>=0 AND sealed IS NULL))
      );
      ALTER TABLE queen_contributor_keys
        ADD COLUMN IF NOT EXISTS model_chosen boolean NOT NULL DEFAULT false;
    `)
      .then(() => undefined)
      .catch((error) => {
        ready.delete(pool)
        throw error
      })
    ready.set(pool, promise)
  }
  return promise
}
const date = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null
function publicKey(row: KeyRow): ContributorKey {
  return {
    id: row.key_index,
    source: row.source,
    provider: row.provider,
    model: row.model,
    label: row.label,
    fingerprint: row.fingerprint.slice(0, 12),
    enabled: row.enabled,
    createdAt: date(row.created_at),
    lastProbe: {
      status: row.probe_status,
      checkedAt: date(row.probe_at),
      latencyMs: row.probe_ms,
    },
  }
}
function environmentOwned(
  key: EnvironmentKey,
  subject: string,
  owners: Record<number, string>,
): boolean {
  const github = contributorGithub(subject)
  return (
    !!github && owners[key.id]?.toLowerCase() === `@${github}`.toLowerCase()
  )
}
export async function listContributorKeys(
  pool: Pool,
  subject: string,
  environment: EnvironmentKey[],
  owners: Record<number, string>,
): Promise<ContributorKey[]> {
  await ensureContributorKeys(pool)
  const { rows } = await pool.query<KeyRow>(
    'SELECT * FROM queen_contributor_keys WHERE owner_subject=$1 ORDER BY key_index',
    [subject],
  )
  const bindings = await pool.query<
    Pick<KeyRow, 'key_index' | 'owner_subject' | 'fingerprint'>
  >(
    "SELECT key_index,owner_subject,fingerprint FROM queen_contributor_keys WHERE source='environment'",
  )
  const out = rows.filter((row) => row.source === 'managed').map(publicKey)
  for (const key of environment) {
    const digest = fingerprint(key.apiKey)
    const bound = bindings.rows.find((row) => row.key_index === key.id)
    if (
      bound
        ? bound.owner_subject !== subject || bound.fingerprint !== digest
        : !environmentOwned(key, subject, owners)
    )
      continue
    const stored = rows.find(
      (row) =>
        row.source === 'environment' &&
        row.key_index === key.id &&
        row.fingerprint === digest,
    )
    out.push(
      stored
        ? {
            ...publicKey(stored),
            // A binding row records the model it was bound under; only an
            // owner's explicit choice outlives a change of the pool's model.
            model: stored.model_chosen ? stored.model : key.model,
          }
        : {
            id: key.id,
            source: 'environment',
            provider: key.provider,
            model: key.model,
            label: `${key.provider} #${key.id + 1}`,
            fingerprint: digest.slice(0, 12),
            enabled: true,
            createdAt: null,
            lastProbe: {
              status: 'not_checked',
              checkedAt: null,
              latencyMs: null,
            },
          },
    )
  }
  return out
}

/** No response bodies, redirects, arbitrary URLs, retries or provider messages escape. */
let probesInFlight = 0
export async function probeCredential(
  key: Pick<EnvironmentKey, 'provider' | 'model' | 'apiKey'>,
  fetcher: typeof fetch = fetch,
): Promise<KeyProbe> {
  const started = Date.now()
  const provider = CONTRIBUTOR_PROVIDERS.find((p) => p.id === key.provider)
  if (!provider) throw new ContributorError('unsupported_provider')
  if (probesInFlight >= P.MAX_PROBES_IN_FLIGHT)
    throw new ContributorError('probe_rate_limited', 429)
  probesInFlight++
  let status: ProbeStatus = 'unavailable'
  try {
    const response = await fetcher(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(P.PROBE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: key.model,
        messages: [{ role: 'user', content: 'Reply OK.' }],
        max_tokens: P.PROBE_MAX_TOKENS,
        stream: false,
      }),
    })
    if (response.status === 401 || response.status === 403) status = 'invalid'
    else if (response.status === 429) status = 'rate_limited'
    else if (response.ok) {
      // A login/proxy HTML response or an empty 200 is not usable inference.
      const body = (await response.json()) as {
        choices?: Array<{
          message?: { content?: unknown; reasoning_content?: unknown }
        }>
      }
      const message = body.choices?.[0]?.message
      if (typeof message?.content === 'string' && message.content.trim())
        status = 'ok'
      else if (
        typeof message?.reasoning_content === 'string' &&
        message.reasoning_content.trim()
      )
        status = 'ok'
    }
    await response.body?.cancel().catch(() => {})
  } catch {
    /* The closed result intentionally excludes errors carrying credentials. */
  } finally {
    probesInFlight--
  }
  return {
    status,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
  }
}

/**
 * Whether a model can carry a bee: one request that hands it a tool.
 *
 * A model that answers text and never calls a tool would accept every bee and
 * finish none of them, so plain "Reply OK." is not enough evidence to switch a
 * whole pool. 404/400 name a model the endpoint does not serve; a refused or
 * busy key says nothing about the model and lets the caller try another key.
 */
export type ModelCheck =
  | 'ok'
  | 'unknown_model'
  | 'no_tool_call'
  | 'inconclusive'
export async function checkModel(
  key: Pick<EnvironmentKey, 'provider' | 'model' | 'apiKey'>,
  fetcher: typeof fetch = fetch,
): Promise<ModelCheck> {
  const provider = CONTRIBUTOR_PROVIDERS.find((p) => p.id === key.provider)
  if (!provider) throw new ContributorError('unsupported_provider')
  if (probesInFlight >= P.MAX_PROBES_IN_FLIGHT)
    throw new ContributorError('probe_rate_limited', 429)
  probesInFlight++
  let result: ModelCheck = 'inconclusive'
  try {
    const response = await fetcher(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(P.PROBE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: key.model,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Answer a liveness check.',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'auto',
        max_tokens: P.MODEL_PROBE_MAX_TOKENS,
        stream: false,
      }),
    })
    if ([400, 404, 410, 422].includes(response.status)) result = 'unknown_model'
    else if (response.ok) {
      const body = (await response.json()) as {
        choices?: Array<{ message?: { tool_calls?: unknown } }>
      }
      const calls = body.choices?.[0]?.message?.tool_calls
      result = Array.isArray(calls) && calls.length > 0 ? 'ok' : 'no_tool_call'
    }
    await response.body?.cancel().catch(() => {})
  } catch {
    /* Timeouts and network errors say nothing about the model. */
  } finally {
    probesInFlight--
  }
  return result
}

/** Model ids a provider lists, per provider, read with an owner's key. */
const modelLists = new Map<
  ContributorProvider,
  { at: number; models: string[] }
>()
export async function providerModels(
  key: Pick<EnvironmentKey, 'provider' | 'apiKey'>,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const provider = CONTRIBUTOR_PROVIDERS.find((p) => p.id === key.provider)
  if (!provider) throw new ContributorError('unsupported_provider')
  const cached = modelLists.get(provider.id)
  if (cached && Date.now() - cached.at < P.MODEL_LIST_CACHE_SECONDS * 1000)
    return cached.models
  let models: string[] = []
  try {
    const response = await fetcher(`${provider.baseUrl}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(P.PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key.apiKey}` },
    })
    if (response.ok) {
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
      models = [
        ...new Set(
          (Array.isArray(body.data) ? body.data : [])
            .map((entry) => entry?.id)
            .filter(validModel),
        ),
      ]
        .sort()
        .slice(0, P.MODEL_LIST_LIMIT)
    } else await response.body?.cancel().catch(() => {})
  } catch {
    /* An unreadable catalog is an empty suggestion list, never an error body. */
  }
  // Only a real list is cached: one failed read must not hide the catalog.
  if (models.length) modelLists.set(provider.id, { at: Date.now(), models })
  return models
}

/** Tests only. */
export function resetProviderModels(): void {
  modelLists.clear()
}

/** The model most of the owner's keys of a provider use, else the default. */
export function ownerModel(
  keys: Pick<ContributorKey, 'provider' | 'model'>[],
  provider: ContributorProvider,
): string {
  const counts = new Map<string, number>()
  for (const key of keys)
    if (key.provider === provider)
      counts.set(key.model, (counts.get(key.model) ?? 0) + 1)
  let best: string | undefined
  for (const [model, count] of counts)
    if (!best || count > (counts.get(best) ?? 0)) best = model
  return (
    best ?? CONTRIBUTOR_PROVIDERS.find((p) => p.id === provider)?.model ?? ''
  )
}

export async function addContributorKey(
  pool: Pool,
  subject: string,
  input: unknown,
  environment: EnvironmentKey[],
  fetcher: typeof fetch = fetch,
): Promise<ContributorKey> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ContributorError('invalid_key')
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['provider', 'apiKey', 'label'].includes(key),
    )
  )
    throw new ContributorError('invalid_key')
  const provider = CONTRIBUTOR_PROVIDERS.find((p) => p.id === value.provider)
  if (!provider) throw new ContributorError('unsupported_provider')
  if (typeof value.apiKey !== 'string')
    throw new ContributorError('invalid_key')
  const secret = value.apiKey
  if (
    !secret ||
    Buffer.byteLength(secret) > P.MAX_KEY_BYTES ||
    /[^!-~]/.test(secret)
  )
    throw new ContributorError('invalid_key')
  if (value.label !== undefined && typeof value.label !== 'string')
    throw new ContributorError('invalid_label')
  const label =
    typeof value.label === 'string' ? value.label.trim() : provider.label
  if (
    label.length > P.LABEL_LIMIT ||
    [...label].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new ContributorError('invalid_label')
  const digest = fingerprint(secret)
  if (environment.some((key) => fingerprint(key.apiKey) === digest))
    throw new ContributorError('key_already_connected', 409)
  const sealed = sealCredential(secret, subject, digest)
  await ensureContributorKeys(pool)
  const duplicate = await pool.query<KeyRow>(
    'SELECT * FROM queen_contributor_keys WHERE fingerprint=$1',
    [digest],
  )
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].owner_subject !== subject)
      throw new ContributorError('key_already_connected', 409)
    return publicKey(duplicate.rows[0])
  }
  const chosen = await pool.query<{ model: string }>(
    `SELECT model FROM queen_contributor_keys
    WHERE owner_subject=$1 AND provider=$2 AND model_chosen
    GROUP BY model ORDER BY count(*) DESC, model LIMIT 1`,
    [subject, provider.id],
  )
  // A new key joins the model its owner already switched this provider to.
  const model = chosen.rows[0]?.model ?? provider.model
  const checked = await probeCredential(
    { provider: provider.id, model, apiKey: secret },
    fetcher,
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `contributor:${subject}`,
    ])
    const count = await client.query(
      'SELECT count(*)::integer AS n FROM queen_contributor_keys WHERE owner_subject=$1',
      [subject],
    )
    if (Number(count.rows[0]?.n) >= P.MAX_KEYS_PER_OWNER)
      throw new ContributorError('key_limit', 409)
    const { rows } = await client.query<KeyRow>(
      `INSERT INTO queen_contributor_keys
      (source,fingerprint,owner_subject,owner_name,provider,model,label,sealed,enabled,probe_status,probe_at,probe_ms,model_chosen)
      VALUES ('managed',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        digest,
        subject,
        contributorName(subject),
        provider.id,
        model,
        label,
        sealed,
        checked.status === 'ok',
        checked.status,
        checked.checkedAt,
        checked.latencyMs,
        !!chosen.rows[0],
      ],
    )
    await client.query('COMMIT')
    return publicKey(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505')
      throw new ContributorError('key_already_connected', 409)
    throw error
  } finally {
    client.release()
  }
}

async function ownedRow(
  pool: Pool,
  subject: string,
  id: number,
  environment: EnvironmentKey[],
  owners: Record<number, string>,
  includeSecret: boolean,
): Promise<{ row: KeyRow; secret: string }> {
  await ensureContributorKeys(pool)
  if (id >= 0) {
    const current = environment.find((key) => key.id === id)
    if (!current) throw new ContributorError('key_not_found', 404)
    const digest = fingerprint(current.apiKey)
    const existing = await pool.query<KeyRow>(
      'SELECT * FROM queen_contributor_keys WHERE key_index=$1',
      [id],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.owner_subject !== subject)
        throw new ContributorError('key_not_found', 404)
      if (row.fingerprint !== digest)
        throw new ContributorError('key_binding_conflict', 409)
      return { row, secret: current.apiKey }
    }
    if (!environmentOwned(current, subject, owners))
      throw new ContributorError('key_not_found', 404)
    await pool.query(
      `INSERT INTO queen_contributor_keys
      (key_index,source,fingerprint,owner_subject,owner_name,provider,model,label,enabled)
      VALUES ($1,'environment',$2,$3,$4,$5,$6,$7,true) ON CONFLICT DO NOTHING`,
      [
        id,
        digest,
        subject,
        contributorName(subject),
        current.provider,
        current.model,
        `${current.provider} #${id + 1}`,
      ],
    )
    const { rows } = await pool.query<KeyRow>(
      'SELECT * FROM queen_contributor_keys WHERE key_index=$1 AND owner_subject=$2 AND fingerprint=$3',
      [id, subject, digest],
    )
    if (!rows[0]) throw new ContributorError('key_binding_conflict', 409)
    return { row: rows[0], secret: current.apiKey }
  }
  const { rows } = await pool.query<KeyRow>(
    'SELECT * FROM queen_contributor_keys WHERE key_index=$1 AND owner_subject=$2',
    [id, subject],
  )
  const row = rows[0]
  if (!row || row.source !== 'managed' || !row.sealed)
    throw new ContributorError('key_not_found', 404)
  return {
    row,
    secret: includeSecret
      ? openCredential(row.sealed, subject, row.fingerprint)
      : '',
  }
}

export async function changeContributorKey(
  pool: Pool,
  subject: string,
  id: number,
  action: 'probe' | 'enable' | 'disable',
  environment: EnvironmentKey[],
  owners: Record<number, string>,
  fetcher: typeof fetch = fetch,
): Promise<ContributorKey> {
  const { row, secret } = await ownedRow(
    pool,
    subject,
    id,
    environment,
    owners,
    action !== 'disable',
  )
  // An environment key runs on its pool's model until its owner chooses one.
  const pooled = environment.find((key) => key.id === id)
  const effective = (stored: KeyRow): ContributorKey => ({
    ...publicKey(stored),
    model:
      stored.source === 'environment' && pooled && !stored.model_chosen
        ? pooled.model
        : stored.model,
  })
  if (action === 'disable') {
    const { rows } = await pool.query<KeyRow>(
      'UPDATE queen_contributor_keys SET enabled=false,revision=revision+1 WHERE key_index=$1 AND owner_subject=$2 RETURNING *',
      [id, subject],
    )
    return effective(rows[0])
  }
  // Database claim, so multiple tabs/processes cannot fan out probes on one key.
  const claimed = await pool.query(
    `UPDATE queen_contributor_keys SET probe_at=now()
    WHERE key_index=$1 AND owner_subject=$2
      AND (probe_at IS NULL OR probe_at < now() - ($3::integer * interval '1 second'))
    RETURNING key_index,revision`,
    [id, subject, P.PROBE_COOLDOWN_SECONDS],
  )
  if (!claimed.rows.length)
    throw new ContributorError('probe_rate_limited', 429)
  const checked = await probeCredential(
    { provider: row.provider, model: effective(row).model, apiKey: secret },
    fetcher,
  )
  const { rows } = await pool.query<KeyRow>(
    `UPDATE queen_contributor_keys
    SET probe_status=$3,probe_at=$4,probe_ms=$5,
      enabled=CASE WHEN $3='invalid' THEN false WHEN $6 AND $3='ok' AND revision=$7 THEN true ELSE enabled END
    WHERE key_index=$1 AND owner_subject=$2 RETURNING *`,
    [
      id,
      subject,
      checked.status,
      checked.checkedAt,
      checked.latencyMs,
      action === 'enable',
      claimed.rows[0].revision,
    ],
  )
  return effective(rows[0])
}

/**
 * One model for every key the owner holds of one provider.
 *
 * Switching a pool is all-or-nothing for that owner, so the evidence comes
 * first: a key of the provider must make the model call a tool. Only then are
 * the owner's environment keys bound (the same binding a probe creates) and
 * every owned row of the provider set to the model. Other owners' keys and the
 * operator's pool variables are untouched; an environment row overrides its
 * pool's model only while `model_chosen` is set.
 */
export async function setContributorModel(
  pool: Pool,
  subject: string,
  input: unknown,
  environment: EnvironmentKey[],
  owners: Record<number, string>,
  fetcher: typeof fetch = fetch,
): Promise<{ provider: ContributorProvider; model: string; keys: number }> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ContributorError('invalid_model')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some((key) => !['provider', 'model'].includes(key)))
    throw new ContributorError('invalid_model')
  const provider = CONTRIBUTOR_PROVIDERS.find((p) => p.id === value.provider)
  if (!provider) throw new ContributorError('unsupported_provider')
  if (!validModel(value.model)) throw new ContributorError('invalid_model')
  const model = value.model
  const keys = (
    await listContributorKeys(pool, subject, environment, owners)
  ).filter((key) => key.provider === provider.id)
  if (!keys.length) throw new ContributorError('key_not_found', 404)
  const sealed = await pool.query<
    Pick<KeyRow, 'key_index' | 'sealed' | 'fingerprint'>
  >(
    "SELECT key_index,sealed,fingerprint FROM queen_contributor_keys WHERE owner_subject=$1 AND provider=$2 AND source='managed'",
    [subject, provider.id],
  )
  const secretOf = (key: ContributorKey): string | undefined => {
    if (key.source === 'environment')
      return environment.find((entry) => entry.id === key.id)?.apiKey
    const row = sealed.rows.find((entry) => entry.key_index === key.id)
    if (!row?.sealed) return undefined
    try {
      return openCredential(row.sealed, subject, row.fingerprint)
    } catch {
      return undefined
    }
  }
  // Keys that answered last time first: a refused key proves nothing either way.
  const order = (key: ContributorKey) =>
    (key.enabled ? 0 : 2) + (key.lastProbe.status === 'ok' ? 0 : 1)
  let attempts = 0
  let verdict: ModelCheck = 'inconclusive'
  for (const key of [...keys].sort((a, b) => order(a) - order(b))) {
    if (attempts >= P.MODEL_CHECK_ATTEMPTS) break
    const secret = secretOf(key)
    if (!secret) continue
    attempts++
    verdict = await checkModel(
      { provider: provider.id, model, apiKey: secret },
      fetcher,
    )
    if (verdict !== 'inconclusive') break
  }
  if (verdict === 'unknown_model')
    throw new ContributorError('model_unavailable', 422)
  if (verdict === 'no_tool_call')
    throw new ContributorError('model_without_tools', 422)
  if (verdict !== 'ok') throw new ContributorError('model_check_failed', 504)
  for (const key of keys) {
    if (key.source !== 'environment') continue
    // A fingerprint already held by the owner's managed copy cannot be bound
    // twice; that copy carries the choice for the environment key instead.
    await ownedRow(pool, subject, key.id, environment, owners, false).catch(
      (error) => {
        if (
          !(error instanceof ContributorError) ||
          error.code !== 'key_binding_conflict'
        )
          throw error
      },
    )
  }
  const updated = await pool.query(
    'UPDATE queen_contributor_keys SET model=$3,model_chosen=true WHERE owner_subject=$1 AND provider=$2',
    [subject, provider.id, model],
  )
  return { provider: provider.id, model, keys: updated.rowCount ?? 0 }
}

export interface ContributorRuntime {
  managed: EnvironmentKey[]
  disabled: number[]
  /** Environment index -> the model its owner chose instead of the pool's. */
  models?: Record<number, string>
}
async function contributorRegistryAvailable(pool: Pool): Promise<boolean> {
  if (contributorsEnabled()) {
    await ensureContributorKeys(pool)
    return true
  }
  // The management capability gates requests, never the already-persisted
  // consent ledger. Revoking that capability cannot revive a disabled key.
  const result = await pool.query<{ registry: string | null }>(
    "SELECT to_regclass('queen_contributor_keys')::text AS registry",
  )
  return !!result.rows[0]?.registry
}
/**
 * Environment index -> the model its owner chose, for keys whose current
 * secret matches the row. An owner's managed copy of a secret the environment
 * also holds carries the choice too: the environment key does the work.
 */
function chosenEnvironmentModels(
  rows: KeyRow[],
  environment: EnvironmentKey[],
): Record<number, string> {
  const pooled = new Map(
    environment.map((key) => [fingerprint(key.apiKey), key]),
  )
  const models: Record<number, string> = {}
  const choose = (row: KeyRow, current: EnvironmentKey | undefined) => {
    if (
      current &&
      row.model_chosen &&
      !(current.id in models) &&
      row.model !== current.model
    )
      models[current.id] = row.model
  }
  for (const row of rows)
    if (row.source === 'environment' && row.enabled) {
      const current = pooled.get(row.fingerprint)
      choose(row, current?.id === row.key_index ? current : undefined)
    }
  for (const row of rows)
    if (row.source === 'managed') choose(row, pooled.get(row.fingerprint))
  return models
}
export async function contributorRuntime(
  pool: Pool,
  environment: EnvironmentKey[],
): Promise<ContributorRuntime> {
  if (!(await contributorRegistryAvailable(pool)))
    return { managed: [], disabled: [], models: {} }
  const { rows } = await pool.query<KeyRow>(
    'SELECT * FROM queen_contributor_keys',
  )
  const disabled: number[] = []
  const managed: EnvironmentKey[] = []
  const digests = new Set(environment.map((key) => fingerprint(key.apiKey)))
  for (const row of rows) {
    if (row.source === 'environment') {
      const current = environment.find((key) => key.id === row.key_index)
      if (
        !row.enabled &&
        current &&
        fingerprint(current.apiKey) === row.fingerprint
      )
        disabled.push(row.key_index)
    } else if (
      row.enabled &&
      row.probe_status !== 'invalid' &&
      row.probe_status !== 'not_checked' &&
      row.sealed &&
      !digests.has(row.fingerprint)
    ) {
      const provider = CONTRIBUTOR_PROVIDERS.find((p) => p.id === row.provider)
      if (!provider) continue
      let secret: string
      try {
        secret = openCredential(row.sealed, row.owner_subject, row.fingerprint)
      } catch {
        // One unreadable managed key must not revive disabled keys or stop
        // independent environment credentials. Never log the cipher/error.
        logger.warn('Contributor credential unavailable for allocation', {
          keyIndex: row.key_index,
        })
        continue
      }
      managed.push({
        id: row.key_index,
        provider: row.provider,
        model: row.model,
        apiKey: secret,
        baseUrl: provider.baseUrl,
        contextWindow: 65536,
      })
      digests.add(row.fingerprint)
    }
  }
  return {
    managed,
    disabled,
    models: chosenEnvironmentModels(rows, environment),
  }
}
export async function contributorOwnerNames(
  pool: Pool,
): Promise<Record<number, string>> {
  if (!(await contributorRegistryAvailable(pool))) return {}
  const { rows } = await pool.query<Pick<KeyRow, 'key_index' | 'owner_name'>>(
    'SELECT key_index,owner_name FROM queen_contributor_keys',
  )
  return Object.fromEntries(rows.map((row) => [row.key_index, row.owner_name]))
}
