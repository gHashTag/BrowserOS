import { describe, expect, it } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createQueenPublicHardwareRoute } from '../../src/api/routes/queen-public-hardware'

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
