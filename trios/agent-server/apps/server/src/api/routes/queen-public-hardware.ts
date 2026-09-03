/**
 * Signed, redacted public FPGA registry for the QUEEN research city.
 *
 * The operator owns discovery and the hardware source of truth. This route only
 * validates, projects, and signs configured observations. It never programs a
 * board and never infers connectivity from repository artifacts.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
} from 'node:crypto'
import { Hono } from 'hono'
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
const STATES = new Set<HardwareState>([
  'registered',
  'synthesised',
  'programmed',
  'online',
])

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

function parseObservation(
  value: unknown,
  now: Date,
): HardwareObservation | null {
  if (!isRecord(value)) return null
  if (
    !nonEmptyString(value.id, 80) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(value.id) ||
    !nonEmptyString(value.family, 120) ||
    typeof value.state !== 'string' ||
    !STATES.has(value.state as HardwareState) ||
    !safeEvidenceUri(value.evidence)
  ) {
    return null
  }

  let observedAt: string | undefined
  let observedTime: number | null = null
  if (value.observedAt !== undefined) {
    if (!nonEmptyString(value.observedAt, 80)) return null
    observedTime = Date.parse(value.observedAt)
    if (!Number.isFinite(observedTime)) return null
    if (observedTime > now.getTime() + 30_000) return null
    observedAt = new Date(observedTime).toISOString()
  }

  let state = value.state as HardwareState
  if (
    state === 'online' &&
    (observedTime === null || now.getTime() - observedTime > ONLINE_WINDOW_MS)
  ) {
    state = 'programmed'
  }

  return {
    id: value.id,
    family: value.family.trim(),
    state,
    evidence: value.evidence,
    ...(observedAt ? { observedAt } : {}),
  }
}

function registryProjection(raw: string, now: Date) {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Registry must be an array')

  const devices = parsed.map((value) => parseObservation(value, now))
  if (devices.some((device) => device === null)) {
    throw new Error('Registry contains an invalid observation')
  }
  const projected = devices as HardwareObservation[]
  const ids = new Set(projected.map((device) => device.id))
  if (ids.size !== projected.length) throw new Error('Duplicate hardware ID')
  projected.sort((left, right) => left.id.localeCompare(right.id))

  const count = (state: HardwareState) =>
    projected.filter((device) => device.state === state).length
  return {
    version: 'queen-fpga-registry/v1',
    generatedAt: now.toISOString(),
    onlineWindowSeconds: ONLINE_WINDOW_MS / 1000,
    devices: projected,
    summary: {
      total: projected.length,
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
    if (
      !registry ||
      (!privateKeyPem && !signingSecret) ||
      !keyId ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(keyId)
    ) {
      return c.json({ error: 'Signed hardware registry is unavailable' }, 503)
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
      logger.warn('Queen public hardware registry rejected configuration', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Signed hardware registry is unavailable' }, 503)
    }
  })
}
