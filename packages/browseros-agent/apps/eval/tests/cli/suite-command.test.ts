import { describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  resolveSuiteCommand,
  runSuiteCommand,
} from '../../src/cli/commands/suite'
import type { RunEvalOptions } from '../../src/runner/types'
import type { EvalSuite } from '../../src/suites/schema'

async function writeTempSuite(
  overrides: Partial<EvalSuite> = {},
): Promise<{ dir: string; suitePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-suite-cli-'))
  const suitePath = join(dir, 'agisdk-daily-10.json')
  await writeFile(
    suitePath,
    JSON.stringify(
      {
        id: 'agisdk-daily-10',
        dataset: 'tasks.jsonl',
        agent: { type: 'single' },
        graders: ['agisdk_state_diff'],
        workers: 2,
        restartBrowserPerTask: true,
        browseros: {
          server_url: 'http://127.0.0.1:9110',
          headless: false,
        },
        ...overrides,
      },
      null,
      2,
    ),
  )
  await writeFile(join(dir, 'tasks.jsonl'), '')
  return { dir, suitePath }
}

describe('suite command', () => {
  it('resolves an existing config through the config adapter', async () => {
    const resolved = await resolveSuiteCommand({
      configPath: 'apps/eval/configs/legacy/browseros-agent-weekly.json',
      env: {},
    })

    expect(resolved.kind).toBe('config')
    expect(resolved.suite.id).toBe('browseros-agent-weekly')
    expect(resolved.evalConfig.dataset).toBe('../../data/agisdk-real.jsonl')
    expect(resolved.variant.publicMetadata.agent.apiKeyConfigured).toBe(true)
  })

  it('resolves a suite file and variant into a runnable eval config', async () => {
    const { dir, suitePath } = await writeTempSuite()

    const resolved = await resolveSuiteCommand({
      suitePath,
      variantId: 'kimi-fireworks',
      provider: 'openai-compatible',
      model: 'accounts/fireworks/models/kimi-k2p5',
      apiKey: 'test-key',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      env: {},
    })

    expect(resolved.kind).toBe('suite')
    expect(resolved.suite.id).toBe('agisdk-daily-10')
    expect(resolved.datasetPath).toBe(join(dir, 'tasks.jsonl'))
    expect(resolved.evalConfig.agent).toMatchObject({
      type: 'single',
      provider: 'openai-compatible',
      model: 'accounts/fireworks/models/kimi-k2p5',
      apiKey: 'test-key',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
    })
    expect(resolved.evalConfig.num_workers).toBe(2)
  })

  it('resolves claude-code suites without provider API credentials', async () => {
    const { dir, suitePath } = await writeTempSuite({
      agent: { type: 'claude-code' },
    })

    const resolved = await resolveSuiteCommand({
      suitePath,
      model: 'opus',
      env: {},
    })

    expect(resolved.kind).toBe('suite')
    expect(resolved.evalConfig.agent).toMatchObject({
      type: 'claude-code',
      model: 'opus',
    })
    expect(resolved.datasetPath).toBe(join(dir, 'tasks.jsonl'))
  })

  it('runs config and suite commands through the runner dependency', async () => {
    const calls: RunEvalOptions[] = []
    await runSuiteCommand(
      {
        configPath: 'apps/eval/configs/legacy/browseros-agent-weekly.json',
        env: {},
      },
      {
        runEval: async (options) => {
          calls.push(options)
        },
      },
    )

    const { suitePath } = await writeTempSuite()
    await runSuiteCommand(
      {
        suitePath,
        model: 'moonshotai/kimi-k2.5',
        provider: 'openai-compatible',
        env: {},
      },
      {
        runEval: async (options) => {
          calls.push(options)
        },
      },
    )

    expect(calls).toHaveLength(2)
    expect(calls[0].configPath.endsWith('browseros-agent-weekly.json')).toBe(
      true,
    )
    expect(basename(calls[1].configPath)).toBe('agisdk-daily-10.json')
    expect(calls[1].config).toBeDefined()
    expect(calls[1].dataPath?.endsWith('tasks.jsonl')).toBe(true)
  })
})
