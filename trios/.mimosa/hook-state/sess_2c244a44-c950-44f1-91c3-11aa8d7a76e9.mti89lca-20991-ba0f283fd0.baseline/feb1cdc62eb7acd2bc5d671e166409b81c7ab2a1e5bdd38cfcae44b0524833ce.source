import { describe, expect, it } from 'bun:test'
import { CladoExecutorBackend } from '../../src/agents/orchestrated/backends/clado/clado-executor-backend'
import {
  backendKindForProvider,
  createExecutorBackend,
} from '../../src/agents/orchestrated/backends/create-executor-backend'
import { ToolLoopExecutorBackend } from '../../src/agents/orchestrated/backends/tool-loop/tool-loop-executor-backend'
import type { ExecutorBackend } from '../../src/agents/orchestrated/executor-backend'

describe('executor backend boundary', () => {
  it('selects Clado only for the Clado action provider', () => {
    expect(backendKindForProvider('clado-action')).toBe('clado')
    expect(backendKindForProvider('openai-compatible')).toBe('tool-loop')
  })

  it('creates concrete backend classes for each executor path', () => {
    expect(
      createExecutorBackend({
        backendKind: 'tool-loop',
        configTemplate: {
          provider: 'openai-compatible',
          model: 'tool-loop-model',
        },
        browser: null,
        serverUrl: 'http://127.0.0.1:9110',
      }),
    ).toBeInstanceOf(ToolLoopExecutorBackend)

    expect(
      createExecutorBackend({
        backendKind: 'clado',
        configTemplate: {
          provider: 'clado-action',
          model: 'clado-model',
          baseUrl: 'https://clado.example.test',
        },
        serverUrl: 'http://127.0.0.1:9110',
      }),
    ).toBeInstanceOf(CladoExecutorBackend)
  })

  it('forwards execution and step state through the backend interface', async () => {
    const signal = new AbortController().signal
    const fakeBackend: ExecutorBackend = {
      kind: 'tool-loop',
      async execute(instruction, receivedSignal) {
        expect(instruction).toBe('Click checkout')
        expect(receivedSignal).toBe(signal)
        return {
          observation: 'Clicked checkout',
          status: 'done',
          url: 'https://example.test/checkout',
          actionsPerformed: 2,
          toolsUsed: ['browser_click_element'],
        }
      },
      async close() {},
      getTotalSteps() {
        return 2
      },
    }

    const backend = createExecutorBackend({
      executor: fakeBackend,
    })
    const result = await backend.execute('Click checkout', signal)

    expect(result.observation).toBe('Clicked checkout')
    expect(result.actionsPerformed).toBe(2)
    expect(backend.getTotalSteps()).toBe(2)
  })
})
