/**
 * Signed, redacted public FPGA registry for the QUEEN research city.
 *
 * The operator owns discovery and the hardware source of truth. This route only
 * validates, projects, and signs configured observations. It never programs a
 * board and never infers connectivity from repository artifacts.
 *
 * Every refusal answers the same one sentence with 503, because a public
 * endpoint that explains which secret is missing is an information leak. The
 * diagnosis belongs in the log instead: each refusal emits exactly one warning
 * whose reason is a member of HARDWARE_REFUSAL_REASONS, and those reasons name
 * WHICH input was wrong, never its content, so no secret, key material, key
 * id, or environment value can reach a log line.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
} from 'node:crypto'
import { type Context, Hono } from 'hono'
import { logger } from '../../lib/logger'

type HardwareState = 'registered' | 'synthesised' | 'programmed' | 'online'

interface HardwareObservation {
  id: string
  family: string
  state: HardwareState
  evidence: string
  observedAt?: string
}

interface QueenPublicHardwareDeps {
  readRegistry?: () => string | undefined
  readPrivateKey?: () => string | undefined
  readSigningSecret?: () => string | undefined
  readKeyId?: () => string | undefined
  now?: () => Date
}

const ONLINE_WINDOW_MS = 120_000
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/
const STATES = new Set<HardwareState>([
  'registered',
  'synthesised',
  'programmed',
  'online',
])

/**
 * The closed set of reasons this route refuses a request, defined once so the
 * log carries a stable, greppable identifier for every distinct cause. Eight
 * members name the eight known misconfigurations, so the eight causes yield
 * eight distinct reasons. UNKNOWN is the explicit member for a cause the code
 * does not recognise: it is emitted rather than omitted or guessed. Values are
 * literals only - they never embed input content.
 */
export const HARDWARE_REFUSAL_REASONS = {
  /** QUEEN_FPGA_REGISTRY_JSON is unset or empty. */
  REGISTRY_UNSET: 'registry-unset',
  /** Neither signing private key nor signing secret is set. */
  SIGNING_KEY_UNSET: 'signing-key-unset',
  /** QUEEN_FPGA_SIGNING_KEY_ID is unset or empty. */
  KEY_ID_UNSET: 'key-id-unset',
  /** QUEEN_FPGA_SIGNING_KEY_ID fails the allowed-character pattern. */
  KEY_ID_MALFORMED: 'key-id-malformed',
  /** QUEEN_FPGA_REGISTRY_JSON is not valid JSON. */
  REGISTRY_UNPARSEABLE: 'registry-unparseable',
  /** QUEEN_FPGA_REGISTRY_JSON parses but is not a JSON array. */
  REGISTRY_NOT_ARRAY: 'registry-not-array',
  /** A registry array entry fails observation validation. */
  REGISTRY_INVALID_OBSERVATION: 'registry-invalid-observation',
  /** Two registry array entries claim the same hardware id. */
  REGISTRY_DUPLICATE_ID: 'registry-duplicate-id',
  /** The refusal came from a cause this code does not classify. */
  UNKNOWN: 'unknown',
} as const

export type HardwareRefusalReason =
  (typeof HARDWARE_REFUSAL_REASONS)[keyof typeof HARDWARE_REFUSAL_REASONS]

/**
 * Internal control-flow carrier for a refusal raised while projecting the
 * registry. The detail carries positions and field NAMES only, never values,
 * so nothing that reaches a log can contain configuration content.
 */
class RegistryRefusalError extends Error {
  constructor(
    readonly reason: HardwareRefusalReason,
    readonly detail: Record<string, string | number> = {},
  ) {
    super(reason)
    this.name = 'RegistryRefusalError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  )
}

function safeEvidenceUri(value: unknown): value is string {
  if (!nonEmptyString(value, 1200)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Name of the first field of a registry entry that fails validation, or null
 * when the entry is valid. Field names are literals; field values never leave
 * this function, so the log can name the culprit without quoting it.
 */
function invalidObservationField(value: unknown, now: Date): string | null {
  if (!isRecord(value)) return 'entry'
  if (!nonEmptyString(value.id, 80)) return 'id'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.id)) return 'id'
  if (!nonEmptyString(value.family, 120)) return 'family'
  if (typeof value.state !== 'string') return 'state'
  if (!STATES.has(value.state as HardwareState)) return 'state'
  if (!safeEvidenceUri(value.evidence)) return 'evidence'
  if (value.observedAt !== undefined) {
    if (!nonEmptyString(value.observedAt, 80)) return 'observedAt'
    const observedTime = Date.parse(value.observedAt)
    if (!Number.isFinite(observedTime)) return 'observedAt'
    if (observedTime > now.getTime() + 30_000) return 'observedAt'
  }
  return null
}

function parseObservation(
  value: unknown,
  now: Date,
): HardwareObservation | null {
  if (invalidObservationField(value, now) !== null) return null
  const entry = value as {
    id: string
    family: string
    state: HardwareState
    evidence: string
    observedAt?: string
  }

  let observedAt: string | undefined
  let observedTime: number | null = null
  if (entry.observedAt !== undefined) {
    observedTime = Date.parse(entry.observedAt)
    observedAt = new Date(observedTime).toISOString()
  }

  let state = entry.state
  if (
    state === 'online' &&
    (observedTime === null || now.getTime() - observedTime > ONLINE_WINDOW_MS)
  ) {
    state = 'programmed'
  }

  return {
    id: entry.id,
    family: entry.family.trim(),
    state,
    evidence: entry.evidence,
    ...(observedAt ? { observedAt } : {}),
  }
}

function registryProjection(raw: string, now: Date) {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RegistryRefusalError(
      HARDWARE_REFUSAL_REASONS.REGISTRY_UNPARSEABLE,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new RegistryRefusalError(HARDWARE_REFUSAL_REASONS.REGISTRY_NOT_ARRAY)
  }

  const devices: HardwareObservation[] = []
  for (let index = 0; index < parsed.length; index++) {
    const observation = parseObservation(parsed[index], now)
    if (observation === null) {
      throw new RegistryRefusalError(
        HARDWARE_REFUSAL_REASONS.REGISTRY_INVALID_OBSERVATION,
        {
          index,
          field: invalidObservationField(parsed[index], now) ?? 'entry',
        },
      )
    }
    devices.push(observation)
  }

  const firstSeenAtIndex = new Map<string, number>()
  for (let index = 0; index < devices.length; index++) {
    const firstIndex = firstSeenAtIndex.get(devices[index].id)
    if (firstIndex !== undefined) {
      // Positions only: the hardware id is part of a configured environment
      // value and must not reach the log.
      throw new RegistryRefusalError(
        HARDWARE_REFUSAL_REASONS.REGISTRY_DUPLICATE_ID,
        { firstIndex, index },
      )
    }
    firstSeenAtIndex.set(devices[index].id, index)
  }
  devices.sort((left, right) => left.id.localeCompare(right.id))

  const count = (state: HardwareState) =>
    devices.filter((device) => device.state === state).length
  return {
    version: 'queen-fpga-registry/v1',
    generatedAt: now.toISOString(),
    onlineWindowSeconds: ONLINE_WINDOW_MS / 1000,
    devices,
    summary: {
      total: devices.length,
      registered: count('registered'),
      synthesised: count('synthesised'),
      programmed: count('programmed'),
      online: count('online'),
    },
  }
}

function privateKeyFromSecret(secret: string) {
  const seed = createHash('sha256')
    .update('queen-fpga-registry/v1\0')
    .update(secret)
    .digest()
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
  return createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

/**
 * Log exactly one warning naming the refusal reason, then answer the same one
 * sentence and 503 that every cause has always answered. The public body and
 * status are identical for every cause; only the log line distinguishes them.
 */
function refuse(
  c: Context,
  reason: HardwareRefusalReason,
  detail?: Record<string, string | number>,
) {
  logger.warn('Queen public hardware registry refused', { reason, ...detail })
  return c.json({ error: 'Signed hardware registry is unavailable' }, 503)
}

export function createQueenPublicHardwareRoute(
  deps: QueenPublicHardwareDeps = {},
) {
  const readRegistry =
    deps.readRegistry ?? (() => process.env.QUEEN_FPGA_REGISTRY_JSON)
  const readPrivateKey =
    deps.readPrivateKey ?? (() => process.env.QUEEN_FPGA_SIGNING_PRIVATE_KEY)
  // No fallback to the API token. The browser pins one public key and
  // silently discards any envelope signed by another, so a key derived from
  // whatever token happens to be set produces a 200 that renders as nothing -
  // indistinguishable from the 404 this route replaces. Unconfigured is 503.
  const readSigningSecret =
    deps.readSigningSecret ?? (() => process.env.QUEEN_FPGA_SIGNING_SECRET)
  const readKeyId =
    deps.readKeyId ?? (() => process.env.QUEEN_FPGA_SIGNING_KEY_ID)
  const now = deps.now ?? (() => new Date())

  return new Hono().get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    const registry = readRegistry()
    const privateKeyPem = readPrivateKey()
    const signingSecret = readSigningSecret()
    const keyId = readKeyId()
    if (!registry) {
      return refuse(c, HARDWARE_REFUSAL_REASONS.REGISTRY_UNSET)
    }
    if (!privateKeyPem && !signingSecret) {
      return refuse(c, HARDWARE_REFUSAL_REASONS.SIGNING_KEY_UNSET)
    }
    if (!keyId) {
      return refuse(c, HARDWARE_REFUSAL_REASONS.KEY_ID_UNSET)
    }
    if (!KEY_ID_PATTERN.test(keyId)) {
      return refuse(c, HARDWARE_REFUSAL_REASONS.KEY_ID_MALFORMED)
    }

    try {
      const payload = registryProjection(registry, now())
      const canonical = JSON.stringify(payload)
      const privateKey = privateKeyPem
        ? createPrivateKey(privateKeyPem)
        : privateKeyFromSecret(signingSecret as string)
      if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('Signing key must be Ed25519')
      }
      const publicKey = createPublicKey(privateKey)
        .export({ format: 'pem', type: 'spki' })
        .toString()
      const signature = signPayload(
        null,
        Buffer.from(canonical),
        privateKey,
      ).toString('base64url')

      return c.json({
        algorithm: 'Ed25519',
        keyId,
        publicKey,
        canonical,
        signature,
        payload,
      })
    } catch (error) {
      if (error instanceof RegistryRefusalError) {
        return refuse(c, error.reason, error.detail)
      }
      // A cause this code does not classify. Log the error's name only:
      // an error message can echo input, and no input value may be logged.
      return refuse(c, HARDWARE_REFUSAL_REASONS.UNKNOWN, {
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
  })
}
