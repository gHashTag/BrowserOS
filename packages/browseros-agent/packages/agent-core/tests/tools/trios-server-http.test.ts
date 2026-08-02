/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * Smoke tests for the HTTP surface of the Rust `trios-server` — the
 * production agent server that replaced the retired TS server surface.
 *
 * Runs only when the binary is available (TRIOS_SERVER_BIN or PATH);
 * skips gracefully otherwise so browser-only environments stay green.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { createServer } from 'node:net'
import {
  killServer,
  resolveTriosServerBin,
  spawnServer,
} from '../__helpers__/trios-server'

const serverBin = resolveTriosServerBin()

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('No port assigned')))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

describe.skipIf(!serverBin)('trios-server (Rust) HTTP surface', () => {
  let baseUrl: string | null = null

  async function ensureServer(): Promise<string> {
    if (baseUrl) {
      return baseUrl
    }
    const port = await findFreePort()
    await spawnServer({ cdpPort: 0, serverPort: port, extensionPort: 0 })
    baseUrl = `http://127.0.0.1:${port}`
    return baseUrl
  }

  afterAll(async () => {
    await killServer()
  })

  it('responds ok on /health', async () => {
    const url = await ensureServer()
    const response = await fetch(`${url}/health`)
    expect(response.ok).toBe(true)
    expect(await response.text()).toBe('ok')
  }, 60_000)

  it('advertises browser tools on /agent/tools', async () => {
    const url = await ensureServer()
    const response = await fetch(`${url}/agent/tools`)
    expect(response.ok).toBe(true)
    const body = (await response.json()) as {
      tools?: Array<{ name: string }>
    }
    expect(Array.isArray(body.tools)).toBe(true)
    const names = (body.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('echo')
    expect(names).toContain('browser_goto')
    expect(names).toContain('browser_screenshot')
    expect(names.length).toBeGreaterThanOrEqual(8)
  }, 60_000)

  it('exposes queue metrics on /metrics', async () => {
    const url = await ensureServer()
    const response = await fetch(`${url}/metrics`)
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const text = await response.text()
    expect(text).toContain('trios_browser_queue_depth')
    expect(text).toContain('trios_agents_registered')
  }, 60_000)
})
