import { describe, expect, it } from 'bun:test'
import {
  accumulateUsage,
  turnProfile,
} from '../../src/api/services/chat-service'

describe('Agent turn profile', () => {
  it('counts steps, tool calls by name, single-call steps and tool errors', () => {
    const tally = { inputTokens: 0, outputTokens: 0 }
    const step = accumulateUsage(tally)
    step({
      usage: { inputTokens: 10, outputTokens: 2 },
      toolCalls: [{ toolName: 'filesystem_read' }],
      content: [{ type: 'tool-call' }, { type: 'tool-error' }],
    })
    step({
      usage: { inputTokens: 5, outputTokens: 1 },
      toolCalls: [
        { toolName: 'filesystem_read' },
        { toolName: 'filesystem_ls' },
      ],
      content: [],
    })
    step({ usage: { inputTokens: 1, outputTokens: 1 } })
    const profile = turnProfile(tally)
    expect(profile.steps).toBe(3)
    expect(profile.toolCalls).toBe(3)
    expect(profile.singleCallSteps).toBe(1)
    expect(profile.toolErrors).toBe(1)
    expect(profile.inputTokens).toBe(16)
    expect(profile.byTool).toBe('filesystem_read:2 filesystem_ls:1')
  })
})
