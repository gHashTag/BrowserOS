import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { loadSuite } from '../../src/suites/load-suite'
import { resolveVariant } from '../../src/suites/resolve-variant'
import { EvalSuiteSchema } from '../../src/suites/schema'

describe('EvalSuiteSchema', () => {
  it('validates suite settings used by the eval pipeline', () => {
    const suite = EvalSuiteSchema.parse({
      id: 'agisdk-daily-10',
      dataset: 'data/agisdk-daily-10.jsonl',
      agent: {
        type: 'orchestrated',
        executorBackend: 'tool-loop',
      },
      graders: ['agisdk_state_diff'],
      workers: 4,
      restartBrowserPerTask: true,
      timeoutMs: 1_800_000,
    })

    expect(suite.id).toBe('agisdk-daily-10')
    expect(suite.agent.type).toBe('orchestrated')
    expect(suite.agent.executorBackend).toBe('tool-loop')
    expect(suite.workers).toBe(4)
  })

  it('rejects suites without a dataset', () => {
    const parsed = EvalSuiteSchema.safeParse({
      id: 'bad-suite',
      agent: { type: 'tool-loop' },
      graders: ['performance_grader'],
    })

    expect(parsed.success).toBe(false)
  })

  it('validates claude-code suites', () => {
    const suite = EvalSuiteSchema.parse({
      id: 'claude-code-agisdk',
      dataset: 'data/agisdk-real.jsonl',
      agent: { type: 'claude-code' },
    })

    expect(suite.agent.type).toBe('claude-code')
  })

  it('validates the daily AGISDK 10-task suite', async () => {
    const loaded = await loadSuite(
      'apps/eval/configs/suites/agisdk-daily-10.json',
    )
    const lines = (await readFile(loaded.datasetPath, 'utf-8'))
      .trim()
      .split('\n')

    expect(loaded.suite.id).toBe('agisdk-daily-10')
    expect(loaded.suite.graders).toEqual(['agisdk_state_diff'])
    expect(loaded.suite.workers).toBe(1)
    expect(lines).toHaveLength(10)
    expect(JSON.parse(lines[0]).query_id).toBe('agisdk-dashdish-10')
    expect(JSON.parse(lines[9]).query_id).toBe('agisdk-zilloft-6')
  })
})

describe('resolveVariant', () => {
  it('prefers CLI values over env values and does not expose raw API keys', () => {
    const variant = resolveVariant({
      variantId: 'cli-variant',
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'cli-secret',
      baseUrl: 'https://cli.example/v1',
      env: {
        EVAL_VARIANT: 'env-variant',
        EVAL_AGENT_PROVIDER: 'openai-compatible',
        EVAL_AGENT_MODEL: 'env-model',
        EVAL_AGENT_API_KEY: 'env-secret',
        EVAL_AGENT_BASE_URL: 'https://env.example/v1',
      },
    })

    expect(variant.id).toBe('cli-variant')
    expect(variant.agent.provider).toBe('anthropic')
    expect(variant.agent.model).toBe('claude-test')
    expect(variant.agent.apiKey).toBe('cli-secret')
    expect(variant.publicMetadata.agent.apiKeyConfigured).toBe(true)
    expect(JSON.stringify(variant.publicMetadata)).not.toContain('cli-secret')
    expect(JSON.stringify(variant.publicMetadata)).not.toContain('env-secret')
  })

  it('fails clearly when credentials are required but missing', () => {
    expect(() =>
      resolveVariant({
        variantId: 'missing-key',
        provider: 'openai-compatible',
        model: 'kimi',
        env: {},
        requireApiKey: true,
      }),
    ).toThrow('EVAL_AGENT_API_KEY')
  })

  it('resolves claude-code variants without model or API key requirements', () => {
    const variant = resolveVariant({
      variantId: 'claude-opus',
      provider: 'claude-code',
      model: 'opus',
      env: {},
    })

    expect(variant.id).toBe('claude-opus')
    expect(variant.agent).toEqual({
      provider: 'claude-code',
      model: 'opus',
    })
    expect(variant.publicMetadata.agent).toEqual({
      provider: 'claude-code',
      model: 'opus',
      apiKeyConfigured: false,
    })

    const defaultVariant = resolveVariant({
      provider: 'claude-code',
      env: {},
    })

    expect(defaultVariant.id).toBe('claude-code')
    expect(defaultVariant.agent).toEqual({
      provider: 'claude-code',
      model: '',
    })
    expect(defaultVariant.publicMetadata.agent).toEqual({
      provider: 'claude-code',
      model: 'default',
      apiKeyConfigured: false,
    })
  })
})
