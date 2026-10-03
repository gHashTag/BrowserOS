import { describe, expect, it } from 'bun:test'
import { AGENT_LIMITS } from '@browseros/shared/constants/limits'
import {
  summarizationTimeoutMs,
  summarizerModelFor,
} from '../../src/agent/compaction/utils'

const NEMOTRON = 'nvidia/nemotron-3-super-120b-a12b'

describe('summarizationTimeoutMs', () => {
  it('keeps the 60 s default when unset or unreadable', () => {
    expect(summarizationTimeoutMs({})).toBe(
      AGENT_LIMITS.COMPACTION_SUMMARIZATION_TIMEOUT_MS,
    )
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: '3m',
      }),
    ).toBe(60_000)
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: '-1',
      }),
    ).toBe(60_000)
  })

  it('takes a named wait inside 10 s..10 min and refuses one outside it', () => {
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: '180000',
      }),
    ).toBe(180_000)
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: ' 10000 ',
      }),
    ).toBe(10_000)
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: '600000',
      }),
    ).toBe(600_000)
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: '9999',
      }),
    ).toBe(60_000)
    expect(
      summarizationTimeoutMs({
        TRIOS_COMPACTION_SUMMARIZATION_TIMEOUT_MS: '600001',
      }),
    ).toBe(60_000)
  })
})

describe('summarizerModelFor', () => {
  const env = {
    TRIOS_COMPACTION_SUMMARIZER_MODELS: ` openai-compatible = ${NEMOTRON} , zai=glm-4.5-flash`,
  }

  it('maps the bee provider to its named summarizer', () => {
    expect(summarizerModelFor('openai-compatible', 'z-ai/glm-5.3', env)).toBe(
      NEMOTRON,
    )
  })

  it('names nothing for an unmapped provider, an unset variable or the bee model itself', () => {
    expect(summarizerModelFor('anthropic', 'claude', env)).toBeNull()
    expect(
      summarizerModelFor('openai-compatible', 'z-ai/glm-5.3', {}),
    ).toBeNull()
    expect(summarizerModelFor('zai', 'glm-4.5-flash', env)).toBeNull()
  })

  it('refuses a malformed model name rather than sending it to a provider', () => {
    expect(
      summarizerModelFor('openai-compatible', 'x', {
        TRIOS_COMPACTION_SUMMARIZER_MODELS: 'openai-compatible=bad model',
      }),
    ).toBeNull()
    expect(
      summarizerModelFor('openai-compatible', 'x', {
        TRIOS_COMPACTION_SUMMARIZER_MODELS: '=m,openai-compatible',
      }),
    ).toBeNull()
  })
})
