/**
 * Test script for Clado API endpoints (grounding + action models)
 *
 * Usage:
 *   bun apps/eval/scripts/test-clado-api.ts [screenshot-path]
 *
 * If no screenshot provided, captures one from a running BrowserOS server.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ACTION_URL =
  'https://clado-ai--clado-browseros-action-actionmodel-generate.modal.run'
const ACTION_HEALTH_URL =
  'https://clado-ai--clado-browseros-action-actionmodel-health.modal.run'
const GROUNDING_URL =
  'https://clado-ai--clado-browseros-grounding-groundingmodel-generate.modal.run'
const GROUNDING_HEALTH_URL =
  'https://clado-ai--clado-browseros-grounding-groundingmodel-health.modal.run'

async function checkHealth(name: string, url: string): Promise<boolean> {
  console.log(`\n--- ${name} health check ---`)
  console.log(`  URL: ${url}`)
  const start = performance.now()
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    const body = await resp.text()
    console.log(`  Status: ${resp.status} (${elapsed}s)`)
    console.log(`  Body: ${body.slice(0, 200)}`)
    return resp.ok
  } catch (err) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    console.log(
      `  FAILED (${elapsed}s): ${err instanceof Error ? err.message : err}`,
    )
    return false
  }
}

async function testGenerate(
  name: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  console.log(`\n--- ${name} generate ---`)
  console.log(`  URL: ${url}`)
  console.log(`  Instruction: ${payload.instruction}`)
  console.log(
    `  Image size: ${((payload.image_base64 as string).length / 1024).toFixed(0)} KB (base64)`,
  )
  if (payload.history) console.log(`  History: ${payload.history}`)

  const start = performance.now()
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    })
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)

    if (!resp.ok) {
      const body = await resp.text()
      console.log(`  FAILED: HTTP ${resp.status} (${elapsed}s)`)
      console.log(`  Body: ${body.slice(0, 400)}`)
      return null
    }

    const result = (await resp.json()) as Record<string, unknown>
    console.log(`  Status: ${resp.status} (${elapsed}s)`)
    console.log(`  Action: ${result.action}`)
    if (result.x !== null && result.x !== undefined)
      console.log(`  Coordinates: (${result.x}, ${result.y})`)
    if (result.text)
      console.log(`  Text: ${(result.text as string).slice(0, 100)}`)
    if (result.key) console.log(`  Key: ${result.key}`)
    if (result.inference_time_seconds)
      console.log(`  Inference: ${result.inference_time_seconds}s`)

    // Show thinking if present
    const raw = result.raw_response as string | undefined
    if (raw) {
      const thinkMatch = raw.match(/<thinking>([\s\S]*?)<\/thinking>/)
      if (thinkMatch) {
        const thinking = thinkMatch[1].trim()
        console.log(
          `  Thinking: ${thinking.slice(0, 200)}${thinking.length > 200 ? '...' : ''}`,
        )
      }
    }

    return result
  } catch (err) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    console.log(
      `  FAILED (${elapsed}s): ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}

async function loadScreenshot(path?: string): Promise<string> {
  if (path) {
    const resolved = resolve(path)
    console.log(`Loading screenshot: ${resolved}`)
    const data = await readFile(resolved)
    return data.toString('base64')
  }

  // Try to capture from a running BrowserOS server
  const serverUrl = process.env.trios_URL || 'http://127.0.0.1:9110'
  console.log(
    `No screenshot path provided. Trying to capture from ${serverUrl}...`,
  )

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )

  const client = new Client({ name: 'clado-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
    { requestInit: { headers: { 'X-TRIOS-Source': 'sdk-internal' } } },
  )

  try {
    await client.connect(transport)
    const result = (await client.callTool({
      name: 'take_screenshot',
      arguments: { format: 'png', page: 1 },
    })) as { content: Array<{ type: string; data?: string }> }

    const imageContent = result.content?.find((c) => c.type === 'image')
    if (!imageContent?.data)
      throw new Error('No image data in screenshot response')

    console.log(
      `Captured screenshot (${(imageContent.data.length / 1024).toFixed(0)} KB base64)`,
    )
    return imageContent.data
  } finally {
    try {
      await transport.close()
    } catch {}
  }
}

async function main() {
  const screenshotPath = process.argv[2]

  console.log('=== Clado API Test ===\n')

  // Health checks (parallel)
  const [actionHealthy, groundingHealthy] = await Promise.all([
    checkHealth('Action Model', ACTION_HEALTH_URL),
    checkHealth('Grounding Model', GROUNDING_HEALTH_URL),
  ])

  if (!actionHealthy && !groundingHealthy) {
    console.log('\nBoth endpoints are down. Exiting.')
    process.exit(1)
  }

  // Load screenshot
  let imageBase64: string
  try {
    imageBase64 = await loadScreenshot(screenshotPath)
  } catch (err) {
    console.log(
      `\nFailed to load screenshot: ${err instanceof Error ? err.message : err}`,
    )
    console.log(
      'Provide a screenshot path: bun apps/eval/scripts/test-clado-api.ts path/to/screenshot.png',
    )
    process.exit(1)
  }

  const instruction = 'Click on the search button or search bar'

  // Test grounding model
  if (groundingHealthy) {
    await testGenerate('Grounding Model', GROUNDING_URL, {
      instruction,
      image_base64: imageBase64,
    })
  } else {
    console.log('\nSkipping grounding model (unhealthy)')
  }

  // Test action model (no history)
  if (actionHealthy) {
    const result = await testGenerate('Action Model (step 1)', ACTION_URL, {
      instruction,
      image_base64: imageBase64,
      history: 'None',
    })

    // Test action model with history (simulate multi-turn)
    if (result && result.action === 'click') {
      await testGenerate('Action Model (step 2, with history)', ACTION_URL, {
        instruction: 'Type "hello world" in the search bar',
        image_base64: imageBase64,
        history: `click(${result.x}, ${result.y})`,
      })
    }
  } else {
    console.log('\nSkipping action model (unhealthy)')
  }

  console.log('\n=== Done ===')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
