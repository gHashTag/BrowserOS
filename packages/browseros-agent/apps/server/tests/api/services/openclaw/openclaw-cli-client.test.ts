/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it, mock } from 'bun:test'
import { OPENCLAW_CONTAINER_HOME } from '@browseros/shared/constants/openclaw'
import { OpenClawCliClient } from '../../../../src/api/services/openclaw/openclaw-cli-client'

describe('OpenClawCliClient', () => {
  it('passes real non-interactive onboarding flags through to the upstream cli', async () => {
    const execInContainer = mock(async (command: string[]) => {
      expect(command).toEqual([
        'node',
        'dist/index.js',
        'onboard',
        '--non-interactive',
        '--mode',
        'local',
        '--auth-choice',
        'skip',
        '--gateway-auth',
        'token',
        '--gateway-port',
        '18789',
        '--gateway-bind',
        'lan',
        '--no-install-daemon',
        '--skip-health',
        '--accept-risk',
      ])
      return 0
    })

    const client = new OpenClawCliClient({ execInContainer })
    await client.runOnboard({
      nonInteractive: true,
      mode: 'local',
      authChoice: 'skip',
      gatewayAuth: 'token',
      gatewayPort: 18789,
      gatewayBind: 'lan',
      installDaemon: false,
      skipHealth: true,
      acceptRisk: true,
    })
  })

  it('uses batch mode for grouped config writes', async () => {
    const execInContainer = mock(async (command: string[]) => {
      expect(command).toEqual([
        'node',
        'dist/index.js',
        'config',
        'set',
        '--batch-json',
        '[{"path":"gateway.mode","value":"local"},{"path":"gateway.http.endpoints.chatCompletions.enabled","value":true}]',
      ])
      return 0
    })

    const client = new OpenClawCliClient({ execInContainer })
    await client.setConfigBatch([
      {
        path: 'gateway.mode',
        value: 'local',
      },
      {
        path: 'gateway.http.endpoints.chatCompletions.enabled',
        value: true,
      },
    ])
  })

  it('runs upstream CLI commands without appending a gateway token flag', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        if (command[2] === 'agents' && command[3] === 'list') {
          onLog?.(
            JSON.stringify([
              {
                id: 'main',
                workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
                model: 'openrouter/anthropic/claude-sonnet-4.5',
              },
            ]),
          )
        }
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const agents = await client.listAgents()

    expect(execInContainer.mock.calls[0]?.[0]).toEqual([
      'node',
      'dist/index.js',
      'agents',
      'list',
      '--json',
    ])
    expect(agents[0]?.model).toBe('openrouter/anthropic/claude-sonnet-4.5')
  })

  it('derives the workspace when creating an agent', async () => {
    let callIndex = 0
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        callIndex += 1
        if (callIndex === 1) {
          expect(command).toEqual([
            'node',
            'dist/index.js',
            'agents',
            'add',
            'research',
            '--workspace',
            `${OPENCLAW_CONTAINER_HOME}/workspace-research`,
            '--model',
            'openai/gpt-5.4-mini',
            '--non-interactive',
            '--json',
          ])
          return 0
        }

        onLog?.(
          JSON.stringify([
            {
              id: 'main',
              workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
            },
            {
              id: 'research',
              workspace: `${OPENCLAW_CONTAINER_HOME}/workspace-research`,
              model: 'openai/gpt-5.4-mini',
            },
          ]),
        )
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const agent = await client.createAgent({
      name: 'research',
      model: 'openai/gpt-5.4-mini',
    })

    expect(execInContainer).toHaveBeenCalledTimes(2)
    expect(agent).toEqual({
      agentId: 'research',
      name: 'research',
      workspace: `${OPENCLAW_CONTAINER_HOME}/workspace-research`,
      model: 'openai/gpt-5.4-mini',
    })
  })

  it('parses agent lists from mixed log and JSON output', async () => {
    const execInContainer = mock(
      async (_command: string[], onLog?: (line: string) => void) => {
        onLog?.('starting agent listing')
        onLog?.(
          JSON.stringify([
            {
              id: 'main',
              workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
            },
          ]),
        )
        onLog?.('done')
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const agents = await client.listAgents()

    expect(agents).toEqual([
      {
        agentId: 'main',
        name: 'main',
        workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
      },
    ])
  })

  it('parses pretty-printed JSON surrounded by logs', async () => {
    const execInContainer = mock(
      async (_command: string[], onLog?: (line: string) => void) => {
        onLog?.('starting agent listing')
        onLog?.('[')
        onLog?.('  {')
        onLog?.('    "id": "main",')
        onLog?.(`    "workspace": "${OPENCLAW_CONTAINER_HOME}/workspace",`)
        onLog?.('    "model": "openrouter/anthropic/claude-sonnet-4.5"')
        onLog?.('  }')
        onLog?.(']')
        onLog?.('done')
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const agents = await client.listAgents()

    expect(agents).toEqual([
      {
        agentId: 'main',
        name: 'main',
        workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
        model: 'openrouter/anthropic/claude-sonnet-4.5',
      },
    ])
  })

  it('skips structured JSON logs before the real agent list payload', async () => {
    const execInContainer = mock(
      async (_command: string[], onLog?: (line: string) => void) => {
        onLog?.(
          JSON.stringify({
            level: 'info',
            message: 'agent list requested',
            workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
          }),
        )
        onLog?.(
          JSON.stringify([
            {
              id: 'main',
              workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
              model: 'openrouter/anthropic/claude-sonnet-4.5',
            },
          ]),
        )
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const agents = await client.listAgents()

    expect(agents).toEqual([
      {
        agentId: 'main',
        name: 'main',
        workspace: `${OPENCLAW_CONTAINER_HOME}/workspace`,
        model: 'openrouter/anthropic/claude-sonnet-4.5',
      },
    ])
  })

  it('preserves exit details when the CLI fails', async () => {
    const execInContainer = mock(
      async (_command: string[], onLog?: (line: string) => void) => {
        onLog?.('agent already exists')
        return 1
      },
    )

    const client = new OpenClawCliClient({ execInContainer })

    await expect(client.listAgents()).rejects.toThrow('agent already exists')
  })

  it('lists sessions for a specific agent', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        expect(command).toEqual([
          'node',
          'dist/index.js',
          'sessions',
          '--json',
          '--agent',
          'main',
        ])
        onLog?.(
          JSON.stringify({
            sessions: [
              {
                key: 'openai-user:browseros:main:session-1',
                updatedAt: 1710000000000,
                sessionId: 'session-1',
                agentId: 'main',
                kind: 'chat',
                status: 'active',
                totalTokens: 120,
                model: 'openai/gpt-5.4-mini',
                modelProvider: 'openai',
              },
            ],
            count: 1,
          }),
        )
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const sessions = await client.listSessions('main')

    expect(sessions).toEqual([
      {
        key: 'openai-user:browseros:main:session-1',
        updatedAt: 1710000000000,
        sessionId: 'session-1',
        agentId: 'main',
        kind: 'chat',
        status: 'active',
        totalTokens: 120,
        model: 'openai/gpt-5.4-mini',
        modelProvider: 'openai',
      },
    ])
  })

  it('fetches chat history through the OpenClaw gateway call command', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        expect(command).toEqual([
          'node',
          'dist/index.js',
          'gateway',
          'call',
          'chat.history',
          '--params',
          '{"sessionKey":"session-1"}',
          '--json',
        ])
        onLog?.(
          JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'Hello' }],
                timestamp: 1710000000001,
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'Hi there' }],
                timestamp: 1710000000002,
                usage: { input: 5, output: 6 },
              },
            ],
          }),
        )
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const history = await client.getChatHistory('session-1')

    expect(history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: 1710000000001,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        timestamp: 1710000000002,
        usage: { input: 5, output: 6 },
      },
    ])
  })

  it('parses config get output from mixed logs and pretty-printed JSON', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        if (command[2] === 'config' && command[3] === 'get') {
          onLog?.('reading config')
          onLog?.('{')
          onLog?.('  "gateway": {')
          onLog?.('    "mode": "local"')
          onLog?.('  }')
          onLog?.('}')
          onLog?.('done')
        }
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const config = await client.getConfig('gateway')

    expect(config).toEqual({
      gateway: {
        mode: 'local',
      },
    })
  })

  it('skips structured JSON log lines before config get payloads', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        if (command[2] === 'config' && command[3] === 'get') {
          onLog?.(
            JSON.stringify({
              level: 'info',
              message: 'reading config',
            }),
          )
          onLog?.('{')
          onLog?.('  "gateway": {')
          onLog?.('    "mode": "local"')
          onLog?.('  }')
          onLog?.('}')
        }
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const config = await client.getConfig('gateway')

    expect(config).toEqual({
      gateway: {
        mode: 'local',
      },
    })
  })

  it('skips structured JSON log lines before config validate payloads', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        if (command[2] === 'config' && command[3] === 'validate') {
          onLog?.(
            JSON.stringify({
              level: 'info',
              message: 'validating config',
            }),
          )
          onLog?.(
            JSON.stringify({
              ok: true,
              warnings: [],
            }),
          )
        }
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const result = await client.validateConfig()

    expect(result).toEqual({
      ok: true,
      warnings: [],
    })
  })

  it('keeps the config get payload when a structured JSON log follows it', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        if (command[2] === 'config' && command[3] === 'get') {
          onLog?.('{')
          onLog?.('  "gateway": {')
          onLog?.('    "mode": "local"')
          onLog?.('  }')
          onLog?.('}')
          onLog?.(
            JSON.stringify({
              level: 'info',
              message: 'config fetched',
            }),
          )
        }
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const config = await client.getConfig('gateway')

    expect(config).toEqual({
      gateway: {
        mode: 'local',
      },
    })
  })

  it('keeps the config validate payload when a structured JSON log follows it', async () => {
    const execInContainer = mock(
      async (command: string[], onLog?: (line: string) => void) => {
        if (command[2] === 'config' && command[3] === 'validate') {
          onLog?.(
            JSON.stringify({
              ok: true,
              warnings: [],
            }),
          )
          onLog?.(
            JSON.stringify({
              level: 'info',
              message: 'config validated',
            }),
          )
        }
        return 0
      },
    )

    const client = new OpenClawCliClient({ execInContainer })
    const result = await client.validateConfig()

    expect(result).toEqual({
      ok: true,
      warnings: [],
    })
  })
})
