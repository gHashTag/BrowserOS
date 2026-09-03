import { describe, expect, it } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  createQueenPublicHardwareRoute,
  HARDWARE_REFUSAL_REASONS,
} from '../../src/api/routes/queen-public-hardware'
import { logger } from '../../src/lib/logger'

const { privateKey } = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString()
const now = new Date('2026-09-01T17:45:00Z')

describe('GET /queen/public-hardware', () => {
  it('signs an allowlisted registry and demotes stale online claims', async () => {
    const response = await createQueenPublicHardwareRoute({
      readRegistry: () =>
        JSON.stringify([
          {
            id: 'stand-alpha',
            family: 'Artix-7',
            state: 'online',
            evidence: 'https://github.com/gHashTag/t27/tree/master/fpga',
            observedAt: '2026-09-01T17:44:30Z',
            hostname: 'private-host',
            serialNumber: 'secret-serial',
            token: 'secret-token',
          },
          {
            id: 'stand-beta',
            family: 'Zynq-7000',
            state: 'online',
            evidence:
              'https://github.com/gHashTag/t27/blob/master/fpga/HARDWARE_SSOT.md',
            observedAt: '2026-09-01T17:40:00Z',
          },
          {
            id: 'rtl-profile',
            family: 'iCE40',
            state: 'synthesised',
            evidence: 'https://github.com/gHashTag/t27/tree/master/targets',
          },
        ]),
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => 'queen-fpga-test-1',
      now: () => now,
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.algorithm).toBe('Ed25519')
    expect(body.keyId).toBe('queen-fpga-test-1')
    expect(body.payload.devices).toHaveLength(3)
    expect(
      body.payload.devices.find(
        (device: { id: string }) => device.id === 'stand-alpha',
      ).state,
    ).toBe('online')
    expect(
      body.payload.devices.find(
        (device: { id: string }) => device.id === 'stand-beta',
      ).state,
    ).toBe('programmed')
    expect(body.payload.summary).toEqual({
      total: 3,
      registered: 0,
      synthesised: 1,
      programmed: 1,
      online: 1,
    })
    expect(body.canonical).toBe(JSON.stringify(body.payload))
    expect(
      verify(
        null,
        Buffer.from(body.canonical),
        body.publicKey,
        Buffer.from(body.signature, 'base64url'),
      ),
    ).toBe(true)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('private-host')
    expect(serialized).not.toContain('secret-serial')
    expect(serialized).not.toContain('secret-token')
  })

  it('fails closed when configuration is missing', async () => {
    const response = await createQueenPublicHardwareRoute({
      readRegistry: () => undefined,
      readPrivateKey: () => undefined,
      readKeyId: () => undefined,
    }).request('/')
    expect(response.status).toBe(503)
  })

  it('derives a stable Ed25519 key from a protected deployment secret', async () => {
    const request = () =>
      createQueenPublicHardwareRoute({
        readRegistry: () =>
          JSON.stringify([
            {
              id: 'stand-alpha',
              family: 'Artix-7',
              state: 'programmed',
              evidence: 'https://example.test/evidence',
            },
          ]),
        readPrivateKey: () => undefined,
        readSigningSecret: () => 'test-only-high-entropy-secret',
        readKeyId: () => 'queen-fpga-derived-1',
        now: () => now,
      }).request('/')
    const first = await (await request()).json()
    const second = await (await request()).json()
    expect(first.publicKey).toBe(second.publicKey)
    expect(first.signature).toBe(second.signature)
  })

  it('never derives a signing key from the API token', async () => {
    // The page pins one public key. A key derived from TRIOS_API_TOKEN would
    // sign a 200 the browser discards in silence, which is the failure this
    // route exists to remove. With no explicit key or secret the answer is 503.
    const previous = process.env.TRIOS_API_TOKEN
    process.env.TRIOS_API_TOKEN = 'a-token-that-must-not-become-a-key'
    try {
      const response = await createQueenPublicHardwareRoute({
        readRegistry: () =>
          JSON.stringify([
            {
              id: 'stand-alpha',
              family: 'Artix-7',
              state: 'programmed',
              evidence: 'https://example.test/evidence',
            },
          ]),
        readPrivateKey: () => undefined,
        readKeyId: () => 'queen-fpga-1',
        now: () => now,
      }).request('/')
      expect(response.status).toBe(503)
    } finally {
      if (previous === undefined) delete process.env.TRIOS_API_TOKEN
      else process.env.TRIOS_API_TOKEN = previous
    }
  })

  it('fails closed for duplicate identifiers or malformed evidence', async () => {
    for (const registry of [
      [
        {
          id: 'same',
          family: 'A',
          state: 'registered',
          evidence: 'https://example.test/a',
        },
        {
          id: 'same',
          family: 'B',
          state: 'registered',
          evidence: 'https://example.test/b',
        },
      ],
      [
        {
          id: 'bad',
          family: 'A',
          state: 'registered',
          evidence: 'file:///private/path',
        },
      ],
      [
        {
          id: 'bad',
          family: 'A',
          state: 'invented',
          evidence: 'https://example.test/a',
        },
      ],
    ]) {
      const response = await createQueenPublicHardwareRoute({
        readRegistry: () => JSON.stringify(registry),
        readPrivateKey: () => privateKeyPem,
        readKeyId: () => 'queen-fpga-test-1',
      }).request('/')
      expect(response.status).toBe(503)
    }
  })
})

interface CapturedWarning {
  message: string
  meta?: Record<string, unknown>
}

/**
 * Runs one request against the route with logger.warn captured, so a test can
 * assert on the exact warnings one refusal produced.
 */
async function requestCapturingWarnings(
  makeRequest: () => Promise<Response>,
): Promise<{ response: Response; warnings: CapturedWarning[] }> {
  const warnings: CapturedWarning[] = []
  const originalWarn = logger.warn
  logger.warn = (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta })
  }
  try {
    const response = await makeRequest()
    return { response, warnings }
  } finally {
    logger.warn = originalWarn
  }
}

/** The one sentence every refusal has always answered with, byte for byte. */
const REFUSAL_BODY = '{"error":"Signed hardware registry is unavailable"}'

const validRegistryEntry = {
  id: 'stand-alpha',
  family: 'Artix-7',
  state: 'programmed',
  evidence: 'https://example.test/evidence',
}

const validRegistryJson = JSON.stringify([validRegistryEntry])

/**
 * The eight documented refusal causes, one row per cause. Each row names the
 * distinct member of HARDWARE_REFUSAL_REASONS the refusal must log.
 */
const refusalCauses = [
  {
    cause: 'nothing configured at all',
    reason: HARDWARE_REFUSAL_REASONS.REGISTRY_UNSET,
    deps: {
      readRegistry: () => undefined,
      readPrivateKey: () => undefined,
      readSigningSecret: () => undefined,
      readKeyId: () => undefined,
    },
  },
  {
    cause: 'registry set, no signing key',
    reason: HARDWARE_REFUSAL_REASONS.SIGNING_KEY_UNSET,
    deps: {
      readRegistry: () => validRegistryJson,
      readPrivateKey: () => undefined,
      readSigningSecret: () => undefined,
      readKeyId: () => 'queen-fpga-1',
    },
  },
  {
    cause: 'registry and key set, keyId missing',
    reason: HARDWARE_REFUSAL_REASONS.KEY_ID_UNSET,
    deps: {
      readRegistry: () => validRegistryJson,
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => undefined,
    },
  },
  {
    cause: 'keyId has a space in it',
    reason: HARDWARE_REFUSAL_REASONS.KEY_ID_MALFORMED,
    deps: {
      readRegistry: () => validRegistryJson,
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => 'queen fpga 1',
    },
  },
  {
    cause: 'registry is not valid JSON',
    reason: HARDWARE_REFUSAL_REASONS.REGISTRY_UNPARSEABLE,
    deps: {
      readRegistry: () => '{"registry": ',
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => 'queen-fpga-1',
    },
  },
  {
    cause: 'registry is not an array',
    reason: HARDWARE_REFUSAL_REASONS.REGISTRY_NOT_ARRAY,
    deps: {
      readRegistry: () => '{"devices":[]}',
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => 'queen-fpga-1',
    },
  },
  {
    cause: 'registry contains an invalid observation',
    reason: HARDWARE_REFUSAL_REASONS.REGISTRY_INVALID_OBSERVATION,
    deps: {
      readRegistry: () =>
        JSON.stringify([
          validRegistryEntry,
          {
            id: 'stand-beta',
            family: 'Zynq-7000',
            state: 'registered',
            evidence: 'file:///private/path',
          },
        ]),
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => 'queen-fpga-1',
    },
  },
  {
    cause: 'registry contains a duplicate hardware id',
    reason: HARDWARE_REFUSAL_REASONS.REGISTRY_DUPLICATE_ID,
    deps: {
      readRegistry: () =>
        JSON.stringify([
          validRegistryEntry,
          { ...validRegistryEntry, family: 'Zynq-7000' },
        ]),
      readPrivateKey: () => privateKeyPem,
      readKeyId: () => 'queen-fpga-1',
    },
  },
] as const

describe('GET /queen/public-hardware refusal diagnostics', () => {
  const emittedReasons: string[] = []

  for (const { cause, reason, deps } of refusalCauses) {
    it(`refuses '${cause}' with 503, the one sentence, and exactly one warning '${reason}'`, async () => {
      const { response, warnings } = await requestCapturingWarnings(() =>
        createQueenPublicHardwareRoute({ ...deps, now: () => now }).request(
          '/',
        ),
      )
      expect(response.status).toBe(503)
      expect(await response.text()).toBe(REFUSAL_BODY)
      expect(warnings).toHaveLength(1)
      expect(warnings[0].meta?.reason).toBe(reason)
      emittedReasons.push(reason)
    })
  }

  it('yields eight distinct reasons, every one a member of the closed set', () => {
    expect(emittedReasons).toHaveLength(8)
    expect(new Set(emittedReasons).size).toBe(8)
    const members = Object.values(HARDWARE_REFUSAL_REASONS)
    for (const reason of emittedReasons) {
      expect(members).toContain(reason)
    }
  })

  it('names the index and the field that failed, so a six-board registry needs no search', async () => {
    const registry = Array.from({ length: 6 }, (_, index) => ({
      ...validRegistryEntry,
      id: `stand-${index}`,
      ...(index === 4 ? { state: 'invented' } : {}),
    }))
    const { response, warnings } = await requestCapturingWarnings(() =>
      createQueenPublicHardwareRoute({
        readRegistry: () => JSON.stringify(registry),
        readPrivateKey: () => privateKeyPem,
        readKeyId: () => 'queen-fpga-test-1',
        now: () => now,
      }).request('/'),
    )
    expect(response.status).toBe(503)
    expect(await response.text()).toBe(REFUSAL_BODY)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].meta).toEqual({
      reason: HARDWARE_REFUSAL_REASONS.REGISTRY_INVALID_OBSERVATION,
      index: 4,
      field: 'state',
    })
  })

  it('names both positions of a duplicate hardware id, never the id itself', async () => {
    const { response, warnings } = await requestCapturingWarnings(() =>
      createQueenPublicHardwareRoute({
        readRegistry: () =>
          JSON.stringify([
            validRegistryEntry,
            { ...validRegistryEntry, id: 'stand-beta' },
            { ...validRegistryEntry, family: 'Zynq-7000' },
          ]),
        readPrivateKey: () => privateKeyPem,
        readKeyId: () => 'queen-fpga-test-1',
        now: () => now,
      }).request('/'),
    )
    expect(response.status).toBe(503)
    expect(await response.text()).toBe(REFUSAL_BODY)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].meta).toEqual({
      reason: HARDWARE_REFUSAL_REASONS.REGISTRY_DUPLICATE_ID,
      firstIndex: 0,
      index: 2,
    })
  })

  it('reports the explicit unknown member for a cause the code does not classify', async () => {
    // Configuration passes every named check, but the key material cannot be
    // loaded - no member of the set names this, so the refusal must carry the
    // explicit unknown member rather than omitting or guessing a reason.
    const { response, warnings } = await requestCapturingWarnings(() =>
      createQueenPublicHardwareRoute({
        readRegistry: () => validRegistryJson,
        readPrivateKey: () => 'not loadable key material',
        readKeyId: () => 'queen-fpga-1',
        now: () => now,
      }).request('/'),
    )
    expect(response.status).toBe(503)
    expect(await response.text()).toBe(REFUSAL_BODY)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].meta?.reason).toBe(HARDWARE_REFUSAL_REASONS.UNKNOWN)
  })

  it('never logs the value of any of the four environment inputs', async () => {
    const sentinel = {
      registry: 'SENTINEL-REGISTRY-9f1c',
      privateKey: 'SENTINEL-PRIVATE-KEY-9f1c',
      signingSecret: 'SENTINEL-SIGNING-SECRET-9f1c',
      keyId: 'SENTINEL-KEY-ID-9f1c',
    }
    const names = [
      'QUEEN_FPGA_REGISTRY_JSON',
      'QUEEN_FPGA_SIGNING_PRIVATE_KEY',
      'QUEEN_FPGA_SIGNING_SECRET',
      'QUEEN_FPGA_SIGNING_KEY_ID',
    ] as const
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    ) as Record<string, string | undefined>

    const warnings: CapturedWarning[] = []
    const originalWarn = logger.warn
    logger.warn = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }
    try {
      // Drive every refusal cause through the real environment wiring, with a
      // recognisable sentinel in each input wherever that input is present.
      const setAll = () => {
        process.env.QUEEN_FPGA_REGISTRY_JSON = JSON.stringify([
          { ...validRegistryEntry, family: sentinel.registry },
        ])
        process.env.QUEEN_FPGA_SIGNING_PRIVATE_KEY = sentinel.privateKey
        process.env.QUEEN_FPGA_SIGNING_SECRET = sentinel.signingSecret
        process.env.QUEEN_FPGA_SIGNING_KEY_ID = `${sentinel.keyId}-1`
      }
      const request = () => createQueenPublicHardwareRoute().request('/')

      setAll()
      // registry set, no signing key
      delete process.env.QUEEN_FPGA_SIGNING_PRIVATE_KEY
      delete process.env.QUEEN_FPGA_SIGNING_SECRET
      await request()
      setAll()
      // keyId missing
      delete process.env.QUEEN_FPGA_SIGNING_KEY_ID
      await request()
      // keyId malformed, sentinel inside the malformed value
      process.env.QUEEN_FPGA_SIGNING_KEY_ID = `${sentinel.keyId} has a space`
      await request()
      setAll()
      // registry unparseable, sentinel inside the malformed JSON
      process.env.QUEEN_FPGA_REGISTRY_JSON = `{"family":"${sentinel.registry}"`
      await request()
      // registry not an array, sentinel inside the object
      process.env.QUEEN_FPGA_REGISTRY_JSON = `{"devices":"${sentinel.registry}"}`
      await request()
      // invalid observation, sentinel inside the failing field
      process.env.QUEEN_FPGA_REGISTRY_JSON = JSON.stringify([
        validRegistryEntry,
        {
          ...validRegistryEntry,
          id: 'stand-beta',
          evidence: `file://${sentinel.registry}`,
        },
      ])
      await request()
      // duplicate hardware id, sentinel inside a family value
      process.env.QUEEN_FPGA_REGISTRY_JSON = JSON.stringify([
        { ...validRegistryEntry, family: sentinel.registry },
        { ...validRegistryEntry, id: 'stand-beta' },
        { ...validRegistryEntry },
      ])
      await request()
      // nothing configured at all
      delete process.env.QUEEN_FPGA_REGISTRY_JSON
      delete process.env.QUEEN_FPGA_SIGNING_PRIVATE_KEY
      delete process.env.QUEEN_FPGA_SIGNING_SECRET
      delete process.env.QUEEN_FPGA_SIGNING_KEY_ID
      await request()
    } finally {
      logger.warn = originalWarn
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
    }

    // Every cause must have logged, or this check would pass vacuously.
    expect(warnings).toHaveLength(8)
    for (const warning of warnings) {
      const line = JSON.stringify(warning)
      expect(line).not.toContain(sentinel.registry)
      expect(line).not.toContain(sentinel.privateKey)
      expect(line).not.toContain(sentinel.signingSecret)
      expect(line).not.toContain(sentinel.keyId)
    }
  })
})
