import { describe, expect, it } from 'bun:test'
import { parseEvalCliArgs } from '../../src/cli/args'

describe('parseEvalCliArgs', () => {
  it('parses the workflow-compatible suite config command', () => {
    expect(
      parseEvalCliArgs([
        'suite',
        '--config',
        'configs/legacy/browseros-agent-weekly.json',
        '--publish',
        'r2',
      ]),
    ).toEqual({
      command: 'suite',
      configPath: 'configs/legacy/browseros-agent-weekly.json',
      publishTarget: 'r2',
    })
  })

  it('parses suite variant and model options', () => {
    expect(
      parseEvalCliArgs([
        'suite',
        '--suite',
        'configs/suites/agisdk-daily-10.json',
        '--variant',
        'kimi-fireworks',
        '--provider',
        'openai-compatible',
        '--model',
        'accounts/fireworks/models/kimi-k2p5',
        '--base-url',
        'https://api.fireworks.ai/inference/v1',
      ]),
    ).toEqual({
      command: 'suite',
      suitePath: 'configs/suites/agisdk-daily-10.json',
      variantId: 'kimi-fireworks',
      provider: 'openai-compatible',
      model: 'accounts/fireworks/models/kimi-k2p5',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
    })
  })

  it('keeps the old config shorthand as legacy config mode', () => {
    expect(
      parseEvalCliArgs(['-c', 'configs/legacy/browseros-agent-weekly.json']),
    ).toEqual({
      command: 'legacy',
      configPath: 'configs/legacy/browseros-agent-weekly.json',
    })
  })

  it('rejects missing required command options with targeted errors', () => {
    expect(() => parseEvalCliArgs(['run'])).toThrow(
      'run requires --config or --suite',
    )
    expect(() => parseEvalCliArgs(['grade'])).toThrow('grade requires --run')
    expect(() =>
      parseEvalCliArgs(['publish', '--run', 'results/run-1']),
    ).toThrow('publish requires --target')
  })
})
