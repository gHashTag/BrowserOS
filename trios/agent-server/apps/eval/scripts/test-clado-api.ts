/**
 * Smoke-test for the Clado BrowserOS Action endpoint.
 *
 * Health-checks the model, then runs a generate call and prints every
 * field the new contract documents (action, coordinates, text, key,
 * direction, scroll/drag fields, wait, end+final_answer, thinking,
 * parse_error, raw_response).
 *
 * Usage:
 *   bun apps/eval/scripts/test-clado-api.ts [screenshot-path]
 *
 * If no screenshot path is given, captures one over MCP from a
 * running BrowserOS server (default http://127.0.0.1:9110, override
 * with BROWSEROS_URL).
 *
 * Cold start can take ~5 minutes; the script waits up to 6.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ACTION_URL =
  'https://clado-ai--clado-browseros-action-000159-merged-actionmod-f4a6ef.modal.run'
const ACTION_HEALTH_URL =
  'https://clado-ai--clado-browseros-action-000159-merged-actionmod-5e5033.modal.run'

const COLD_START_BUDGET_MS = 360_000 // 6 min — Clado cold start is ~5 min
const COLD_START_WARN_MS = 30_000

interface CladoResponse {
  action?: string | null
  thinking?: string | null
  raw_response?: string
  parse_error?: string | null
  inference_time_seconds?: number
  x?: number
  y?: number
  text?: string
  key?: string
  direction?: string
  amount?: number
  startX?: number
  startY?: number
  endX?: number
  endY?: number
  time?: number
  final_answer?: string | null
}

async function checkHealth(): Promise<boolean> {
  console.log(`\n--- Action model health ---`)
  console.log(`  URL:   ${ACTION_HEALTH_URL}`)
  console.log(
    `  Note:  cold start can take ~5 min; waiting up to ${COLD_START_BUDGET_MS / 1000}s.`,
  )
  const start = performance.now()
  const warn = setTimeout(() => {
    console.log(
      `  ...still waiting (${COLD_START_WARN_MS / 1000}s in) — model is likely cold-starting on Modal.`,
    )
  }, COLD_START_WARN_MS)

  try {
    const resp = await fetch(ACTION_HEALTH_URL, {
      signal: AbortSignal.timeout(COLD_START_BUDGET_MS),
    })
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    const body = await resp.text()
    console.log(`  Status: ${resp.status} (${elapsed}s)`)
    console.log(`  Body:   ${body.slice(0, 400)}`)
    return resp.ok
  } catch (err) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    console.log(
      `  FAILED (${elapsed}s): ${err instanceof Error ? err.message : err}`,
    )
    return false
  } finally {
    clearTimeout(warn)
  }
}

async function generate(
  label: string,
  payload: Record<string, unknown>,
): Promise<CladoResponse | null> {
  console.log(`\n--- ${label} ---`)
  console.log(`  URL:         ${ACTION_URL}`)
  console.log(`  Instruction: ${payload.instruction}`)
  console.log(
    `  Image size:  ${((payload.image_base64 as string).length / 1024).toFixed(0)} KB (base64)`,
  )
  if (payload.history && payload.history !== 'None') {
    console.log(`  History:     ${payload.history}`)
  }

  const start = performance.now()
  let resp: Response
  try {
    resp = await fetch(ACTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(COLD_START_BUDGET_MS),
    })
  } catch (err) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    console.log(
      `  FAILED (${elapsed}s): ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
  const elapsed = ((performance.now() - start) / 1000).toFixed(2)

  if (!resp.ok) {
    const body = await resp.text()
    console.log(`  HTTP ${resp.status} ${resp.statusText} (${elapsed}s)`)
    console.log(`  Body: ${body.slice(0, 400)}`)
    return null
  }

  const result = (await resp.json()) as CladoResponse
  console.log(`  HTTP ${resp.status} (${elapsed}s)`)
  console.log(`  action:                ${result.action ?? 'null'}`)
  if (result.parse_error) {
    console.log(`  parse_error:           ${result.parse_error}`)
  }
  if (result.thinking) {
    const trimmed = result.thinking.replace(/\s+/g, ' ').trim()
    console.log(
      `  thinking:              ${trimmed.slice(0, 240)}${trimmed.length > 240 ? '…' : ''}`,
    )
  }
  if (typeof result.x === 'number' || typeof result.y === 'number') {
    console.log(`  x, y:                  ${result.x}, ${result.y}`)
  }
  if (typeof result.text === 'string')
    console.log(`  text:                  ${result.text.slice(0, 120)}`)
  if (typeof result.key === 'string')
    console.log(`  key:                   ${result.key}`)
  if (typeof result.direction === 'string')
    console.log(`  direction:             ${result.direction}`)
  if (typeof result.amount === 'number')
    console.log(`  amount:                ${result.amount}`)
  if (typeof result.startX === 'number' || typeof result.endX === 'number') {
    console.log(
      `  drag:                  (${result.startX}, ${result.startY}) → (${result.endX}, ${result.endY})`,
    )
  }
  if (typeof result.time === 'number')
    console.log(`  time:                  ${result.time}s`)
  if (result.final_answer)
    console.log(`  final_answer:          ${result.final_answer.slice(0, 240)}`)
  if (typeof result.inference_time_seconds === 'number')
    console.log(`  inference_time_seconds: ${result.inference_time_seconds}`)
  return result
}

async function loadScreenshot(path?: string): Promise<string> {
  if (path) {
    const resolved = resolve(path)
    console.log(`Loading screenshot: ${resolved}`)
    const data = await readFile(resolved)
    return data.toString('base64')
  }

  const serverUrl = process.env.BROWSEROS_URL || 'http://127.0.0.1:9110'
  console.log(
    `No screenshot path provided. Capturing from ${serverUrl} via MCP...`,
  )

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )

  const client = new Client({ name: 'clado-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
    { requestInit: { headers: { 'X-BrowserOS-Source': 'sdk-internal' } } },
  )

  try {
    await client.connect(transport)
    const result = (await client.callTool({
      name: 'take_screenshot',
      arguments: { format: 'png', page: 1 },
    })) as { content: Array<{ type: string; data?: string }> }

    const image = result.content?.find((c) => c.type === 'image')
    if (!image?.data)
      throw new Error('No image data in take_screenshot response')

    console.log(
      `Captured screenshot (${(image.data.length / 1024).toFixed(0)} KB base64)`,
    )
    return image.data
  } finally {
    try {
      await transport.close()
    } catch {
      /* ignore */
    }
  }
}

function summarize(history: CladoResponse[]): string {
  if (history.length === 0) return 'None'
  return history
    .map((h) => {
      switch (h.action) {
        case 'click':
        case 'double_click':
        case 'right_click':
        case 'hover':
          return `${h.action}(${h.x}, ${h.y})`
        case 'type':
          return `type(${JSON.stringify(h.text ?? '')})`
        case 'press_key':
          return `press_key(${JSON.stringify(h.key ?? '')})`
        case 'scroll':
          return `scroll(${h.direction ?? 'down'})`
        case 'drag':
          return `drag(${h.startX},${h.startY} -> ${h.endX},${h.endY})`
        case 'wait':
          return `wait(${h.time ?? 1}s)`
        case 'end':
          return 'end()'
        default:
          return h.action ?? 'invalid'
      }
    })
    .join(' -> ')
}

async function main() {
  console.log('=== Clado action endpoint smoke test ===')

  const healthy = await checkHealth()
  if (!healthy) {
    console.log('\nHealth check failed. Exiting.')
    process.exit(1)
  }

  let imageBase64: string
  try {
    imageBase64 = await loadScreenshot(process.argv[2])
  } catch (err) {
    console.log(
      `\nFailed to load screenshot: ${err instanceof Error ? err.message : err}`,
    )
    console.log(
      'Pass a path: bun apps/eval/scripts/test-clado-api.ts path/to/screenshot.png',
    )
    process.exit(1)
  }

  const history: CladoResponse[] = []

  // Step 1: open task — let the model decide what to do.
  const step1 = await generate('Step 1: cold task', {
    instruction: 'Find the search bar and click it',
    image_base64: imageBase64,
    history: 'None',
  })
  if (step1?.action) history.push(step1)

  // Step 2: continuation with history, asks for typing.
  if (step1?.action) {
    const step2 = await generate('Step 2: with history', {
      instruction: 'Type "hello world" into the search bar',
      image_base64: imageBase64,
      history: summarize(history),
    })
    if (step2?.action) history.push(step2)
  }

  // Step 3: ask for end with a final answer to exercise that field.
  await generate('Step 3: ask for end+final_answer', {
    instruction:
      'You have completed the task. Reply with end() and final_answer="done".',
    image_base64: imageBase64,
    history: summarize(history),
  })

  console.log('\n=== Done ===')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
