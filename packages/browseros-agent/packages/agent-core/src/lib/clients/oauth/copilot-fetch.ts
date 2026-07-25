/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Custom fetch wrapper for GitHub Copilot API requests.
 * Injects required Copilot headers and resizes images following
 * VS Code's algorithm (max 2048px longest side, 768px shortest side).
 */

import { Jimp } from 'jimp'
import { logger } from '../../logger'

const MAX_LONG_SIDE = 2048
const MAX_SHORT_SIDE = 768

export function createCopilotFetch() {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit)

    headers.set('Openai-Intent', 'conversation-edits')
    headers.set('x-initiator', 'user')

    let body = init?.body
    if (body && typeof body === 'string') {
      try {
        const json = JSON.parse(body)
        if (hasImageContent(json)) {
          headers.set('Copilot-Vision-Request', 'true')
          await shrinkImages(json)
          body = JSON.stringify(json)
        }
      } catch {
        // Not JSON or resize failed, send as-is
      }
    }

    return fetch(input, { ...init, headers, body })
  }
}

function hasImageContent(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false
  for (const msg of body.messages) {
    if (!Array.isArray(msg?.content)) continue
    for (const part of msg.content) {
      if (part?.type === 'image_url') return true
    }
  }
  return false
}

// Resize images following VS Code's algorithm for OpenAI vision token optimization
async function shrinkImages(body: Record<string, unknown>): Promise<void> {
  if (!Array.isArray(body.messages)) return

  for (const msg of body.messages) {
    if (!Array.isArray(msg?.content)) continue
    for (const part of msg.content) {
      if (part?.type !== 'image_url' || !part.image_url) continue

      const url = part.image_url.url as string
      if (!url?.startsWith('data:')) continue

      try {
        const resized = await resizeDataUrl(url)
        if (resized) part.image_url.url = resized
      } catch (err) {
        logger.warn('Failed to resize image for Copilot', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

async function resizeDataUrl(dataUrl: string): Promise<string | null> {
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx === -1) return null

  const base64Data = dataUrl.substring(commaIdx + 1)
  const buffer = Buffer.from(base64Data, 'base64')

  const image = await Jimp.fromBuffer(buffer)
  const origWidth = image.width
  const origHeight = image.height
  if (!origWidth || !origHeight) return null

  let width = origWidth
  let height = origHeight

  // Skip if already within both limits (no resize step will fire)
  if (
    Math.max(width, height) <= MAX_LONG_SIDE &&
    Math.min(width, height) <= MAX_SHORT_SIDE
  ) {
    return null
  }

  // Step 1: scale longest side to 2048
  if (width > MAX_LONG_SIDE || height > MAX_LONG_SIDE) {
    const scale = MAX_LONG_SIDE / Math.max(width, height)
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }

  // Step 2: scale shortest side to 768
  const shortSide = Math.min(width, height)
  if (shortSide > MAX_SHORT_SIDE) {
    const scale = MAX_SHORT_SIDE / shortSide
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }

  image.resize({ w: width, h: height })

  // Jimp always outputs with alpha; use PNG for alpha sources, JPEG otherwise
  const hasAlpha = image.hasAlpha()
  const mime = hasAlpha ? 'image/png' : 'image/jpeg'
  const resizedBuffer = hasAlpha
    ? await image.getBuffer('image/png')
    : await image.getBuffer('image/jpeg', { quality: 75 })

  const originalKB = Math.round(base64Data.length / 1024)
  const resizedB64 = resizedBuffer.toString('base64')
  const resizedKB = Math.round(resizedB64.length / 1024)
  logger.debug('Resized image for Copilot', {
    original: `${origWidth}x${origHeight} (${originalKB}KB)`,
    resized: `${width}x${height} (${resizedKB}KB)`,
  })

  return `data:${mime};base64,${resizedB64}`
}
