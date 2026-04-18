/**
 * Validation script for Gemini Computer Use integration
 * Run: bun apps/eval/scripts/validate-computer-use-tools.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:9105/mcp'

interface McpToolResult {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

async function callMcpTool(
  serverUrl: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const client = new Client({ name: 'validate-computer-use', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { 'X-TRIOS-Source': 'validation' } },
  })

  try {
    await client.connect(transport)
    return (await client.callTool({ name, arguments: args })) as McpToolResult
  } finally {
    try {
      await transport.close()
    } catch {}
  }
}

async function validateTools() {
  console.log('🔍 Validating MCP tools for Gemini Computer Use integration\n')
  console.log(`MCP URL: ${MCP_URL}\n`)

  // Get active tab first
  console.log('1. Getting active tab...')
  const tabResult = await callMcpTool(MCP_URL, 'browser_get_active_tab', {})
  if (tabResult.isError) {
    console.error('❌ Failed to get active tab:', tabResult.content)
    process.exit(1)
  }
  const tabText = tabResult.content.find((c) => c.type === 'text')?.text ?? ''
  const tabIdMatch = tabText.match(/ID: (\d+)/)
  const tabId = tabIdMatch ? parseInt(tabIdMatch[1], 10) : 1
  console.log(`   ✅ Active tab ID: ${tabId}\n`)

  // Validate each tool needed for Computer Use
  const toolTests = [
    {
      name: 'browser_get_screenshot',
      args: { tabId, size: 'medium' },
      description: 'Screenshot capture',
      validate: (r: McpToolResult) => r.content.some((c) => c.type === 'image'),
    },
    {
      name: 'browser_click_coordinates',
      args: { tabId, x: 100, y: 100 },
      description: 'Click at coordinates',
      validate: (r: McpToolResult) => !r.isError,
    },
    {
      name: 'browser_type_at_coordinates',
      args: { tabId, x: 100, y: 100, text: 'test' },
      description: 'Type at coordinates',
      validate: (r: McpToolResult) => !r.isError,
    },
    {
      name: 'browser_scroll_down',
      args: { tabId },
      description: 'Scroll down',
      validate: (r: McpToolResult) => !r.isError,
    },
    {
      name: 'browser_scroll_up',
      args: { tabId },
      description: 'Scroll up',
      validate: (r: McpToolResult) => !r.isError,
    },
    {
      name: 'browser_send_keys',
      args: { tabId, key: 'Enter' },
      description: 'Send keyboard key',
      validate: (r: McpToolResult) => !r.isError,
    },
    {
      name: 'browser_execute_javascript',
      args: { tabId, code: 'window.location.href' },
      description: 'Execute JavaScript (for go_back/forward workaround)',
      validate: (r: McpToolResult) => !r.isError,
    },
  ]

  let passed = 0
  let failed = 0

  for (const test of toolTests) {
    process.stdout.write(`2. Testing ${test.name} (${test.description})... `)
    try {
      const result = await callMcpTool(MCP_URL, test.name, test.args)
      if (test.validate(result)) {
        console.log('✅')
        passed++
      } else {
        console.log('❌ Validation failed')
        console.log('   Result:', JSON.stringify(result, null, 2))
        failed++
      }
    } catch (err) {
      console.log('❌ Error:', err instanceof Error ? err.message : err)
      failed++
    }
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log('='.repeat(50))

  if (failed === 0) {
    console.log(
      '\n✅ All tools validated! Gemini Computer Use integration should work.',
    )
    console.log('\nGaps to address with workarounds:')
    console.log('  - key_combination: Use browser_execute_javascript')
    console.log(
      '  - go_back/go_forward: Use browser_execute_javascript with history.back()/forward()',
    )
    console.log(
      '  - type_text_at press_enter: Chain browser_send_keys after typing',
    )
  } else {
    console.log('\n⚠️  Some tools failed. Check your server is running.')
  }
}

// Validate Gemini API access
async function validateGeminiApi() {
  const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.log('\n⚠️  GOOGLE_AI_API_KEY not set - skipping API validation')
    return
  }

  console.log('\n3. Validating Gemini Computer Use API access...')

  const MODEL = 'gemini-2.5-computer-use-preview-10-2025'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

  // Minimal test - just check if model is accessible
  const testPayload = {
    contents: [{ role: 'user', parts: [{ text: 'test' }] }],
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(testPayload),
    })

    if (response.ok) {
      console.log('   ✅ Gemini Computer Use API is accessible')
    } else {
      const error = await response.json()
      console.log(
        '   ❌ API error:',
        error.error?.message || response.statusText,
      )
    }
  } catch (err) {
    console.log(
      '   ❌ Network error:',
      err instanceof Error ? err.message : err,
    )
  }
}

async function main() {
  try {
    await validateTools()
    await validateGeminiApi()
  } catch (err) {
    console.error('Validation failed:', err)
    process.exit(1)
  }
}

main()
