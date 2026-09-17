/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'

import { Jimp } from 'jimp'

import { createCopilotFetch } from '../../src/lib/clients/oauth/copilot-fetch'

function makeImageBody(dataUrls: string[]) {
  return JSON.stringify({
    messages: [
      {
        role: 'user',
        content: dataUrls.map((url) => ({
          type: 'image_url',
          image_url: { url },
        })),
      },
    ],
  })
}

async function createTestImage(
  width: number,
  height: number,
  hasAlpha = false,
): Promise<string> {
  const image = new Jimp({ width, height, color: 0xff0000ff })
  if (hasAlpha) {
    // Set some pixels to transparent so hasAlpha() returns true
    for (let x = 0; x < Math.min(width, 10); x++) {
      image.setPixelColor(0xff000080, x, 0)
    }
  }
  const mime = hasAlpha ? 'image/png' : 'image/jpeg'
  const buffer = await image.getBuffer(mime)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function parseDataUrl(dataUrl: string) {
  const [header, b64] = dataUrl.split(',')
  const mime = header.match(/data:([^;]+)/)?.[1]
  return { mime, buffer: Buffer.from(b64, 'base64') }
}

describe('createCopilotFetch', () => {
  it('sets Copilot headers on every request', async () => {
    const copilotFetch = createCopilotFetch()
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = []

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ input, init })
      return new Response('ok')
    }) as typeof fetch

    try {
      await copilotFetch('https://api.example.com', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })

      assert.strictEqual(calls.length, 1)
      const headers = new Headers(calls[0].init?.headers as HeadersInit)
      assert.strictEqual(headers.get('Openai-Intent'), 'conversation-edits')
      assert.strictEqual(headers.get('x-initiator'), 'user')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sets Copilot-Vision-Request header when images present', async () => {
    const copilotFetch = createCopilotFetch()
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = []

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ input, init })
      return new Response('ok')
    }) as typeof fetch

    try {
      const dataUrl = await createTestImage(100, 100)
      await copilotFetch('https://api.example.com', {
        body: makeImageBody([dataUrl]),
      })

      const headers = new Headers(calls[0].init?.headers as HeadersInit)
      assert.strictEqual(headers.get('Copilot-Vision-Request'), 'true')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('image resizing', () => {
  async function resizeViaFetch(dataUrl: string): Promise<string> {
    let capturedBody = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response('ok')
    }) as typeof fetch

    try {
      const copilotFetch = createCopilotFetch()
      await copilotFetch('https://api.example.com', {
        body: makeImageBody([dataUrl]),
      })
      const parsed = JSON.parse(capturedBody)
      return parsed.messages[0].content[0].image_url.url
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  it('does not resize images already within limits', async () => {
    const dataUrl = await createTestImage(800, 600)
    const result = await resizeViaFetch(dataUrl)
    assert.strictEqual(result, dataUrl)
  })

  it('scales down when longest side exceeds 2048', async () => {
    const dataUrl = await createTestImage(4096, 2048)
    const result = await resizeViaFetch(dataUrl)

    assert.notStrictEqual(result, dataUrl)
    const { buffer } = parseDataUrl(result)
    const resized = await Jimp.fromBuffer(buffer)
    assert.ok(resized.width <= 2048)
    assert.ok(resized.height <= 1024)
  })

  it('scales down when shortest side exceeds 768', async () => {
    const dataUrl = await createTestImage(2000, 1500)
    const result = await resizeViaFetch(dataUrl)

    assert.notStrictEqual(result, dataUrl)
    const { buffer } = parseDataUrl(result)
    const resized = await Jimp.fromBuffer(buffer)
    assert.ok(Math.min(resized.width, resized.height) <= 768)
  })

  it('outputs JPEG for opaque images', async () => {
    const dataUrl = await createTestImage(4096, 3072, false)
    const result = await resizeViaFetch(dataUrl)
    const { mime } = parseDataUrl(result)
    assert.strictEqual(mime, 'image/jpeg')
  })

  it('outputs PNG for images with alpha', async () => {
    const dataUrl = await createTestImage(4096, 3072, true)
    const result = await resizeViaFetch(dataUrl)
    const { mime } = parseDataUrl(result)
    assert.strictEqual(mime, 'image/png')
  })

  it('applies both scaling steps (long side then short side)', async () => {
    // 4000x3000: step 1 scales to 2048x1536, step 2 scales 1536→768 so 1024x768
    const dataUrl = await createTestImage(4000, 3000)
    const result = await resizeViaFetch(dataUrl)

    const { buffer } = parseDataUrl(result)
    const resized = await Jimp.fromBuffer(buffer)
    assert.ok(resized.width <= 2048)
    assert.ok(Math.min(resized.width, resized.height) <= 768)
  })
})
