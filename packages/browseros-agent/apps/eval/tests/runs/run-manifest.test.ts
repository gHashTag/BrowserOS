import { describe, expect, it } from 'bun:test'
import { buildRunManifest } from '../../src/runs/run-manifest'

describe('buildRunManifest', () => {
  it('captures reproducibility fields without raw secrets', () => {
    const manifest = buildRunManifest({
      runId: 'agisdk-daily-10__kimi__2026-04-29-0600',
      suiteId: 'agisdk-daily-10',
      variant: {
        id: 'kimi',
        agent: {
          provider: 'openai-compatible',
          model: 'moonshotai/kimi-k2.5',
          apiKey: 'secret-value',
          baseUrl: 'https://api.example.com/v1',
        },
        publicMetadata: {
          id: 'kimi',
          agent: {
            provider: 'openai-compatible',
            model: 'moonshotai/kimi-k2.5',
            baseUrlHost: 'api.example.com',
            apiKeyConfigured: true,
            apiKeyEnv: 'EVAL_AGENT_API_KEY',
          },
        },
      },
      datasetPath: 'apps/eval/data/agisdk-real.jsonl',
      datasetHash: 'sha256:abc',
      graders: ['agisdk_state_diff'],
      gitSha: 'abc123',
      browserosVersion: 'BrowserOS 1.0.0',
      startedAt: '2026-04-29T06:00:00.000Z',
    })

    expect(manifest.variant.agent.baseUrlHost).toBe('api.example.com')
    expect(manifest.dataset.hash).toBe('sha256:abc')
    expect(JSON.stringify(manifest)).not.toContain('secret-value')
  })
})
