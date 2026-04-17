/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Late Join Tests
 *
 * Multi-agent scenario tests for late agent join:
 * - Agent joins active conversation without history
 * - Existing agents continue during late join
 * - Late agent with different mode (observe)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createAgentPair, TestAgent } from './test-agent-factory'
import type { A2ARelayObserverConfig } from '../../../src/agent/portable/a2a-types'

describe('Late Join Multi-Agent Scenarios', () => {
  let agents: { agent1: TestAgent; agent2: TestAgent } | null = null

  beforeEach(async () => {
    // Create two active agents
    agents = await createAgentPair(
      {
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'Agent1',
      },
      {
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'Agent2',
      },
    )
  })

  afterEach(() => {
    if (agents) {
      agents.agent1.stop()
      agents.agent2.stop()
    }
  })

  describe('Agent joins active conversation without history', () => {
    it('should NOT receive conversation history on late join', () => {
      expect(agents).not.toBeNull()

      // Simulate message exchange before late join
      await agents!.agent1.send('Hello from Agent1')
      await agents!.agent2.send('Hello from Agent2')

      const agent1LogBefore = agents!.agent1.getMessages()
      const agent2LogBefore = agents!.agent2.getMessages()

      expect(agent1LogBefore.length).toBeGreaterThan(0)
      expect(agent2LogBefore.length).toBeGreaterThan(0)

      // Create late agent
      const lateAgent = await createSingleAgent({
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'LateAgent',
      })

      await lateAgent.waitForReady()

      // Late agent should NOT have history
      const lateLog = lateAgent.getMessages()

      // Verify no messages from existing conversation
      expect(lateLog.length).toBe(0)
    })

    it('should see new messages after joining', () => {
      expect(agents).not.toBeNull()

      // Initial exchange
      await agents!.agent1.send('Initial 1')
      await agents!.agent2.send('Initial 2')

      const agent1Before = agents!.agent1.getMessages().length
      const agent2Before = agents!.agent2.getMessages().length

      // Late join
      const lateAgent = await createSingleAgent({
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'LateAgent',
      })

      await lateAgent.waitForReady()

      // Send message after late join
      await agents!.agent1.send('After join')

      const agent1After = agents!.agent1.getMessages().length
      const agent2After = agents!.agent2.getMessages().length
      const lateAfter = lateAgent.getMessages().length

      // Verify agents didn't receive old messages
      expect(agent1After).toBe(agent1Before)
      expect(agent2After).toBe(agent2Before)

      // Verify all agents see new message
      expect(agent1After - agent1Before).toBe(1)
      expect(agent2After - agent2Before).toBe(1)
      expect(lateAfter).toBe(1)
    })

    it('should not disrupt existing agents during join', () => {
      expect(agents).not.toBeNull()

      // Establish message flow
      await agents!.agent1.send('Message 1')
      await agents!.agent2.send('Message 2')

      const agent1Flow = agents!.agent1.getMessages().length
      const agent2Flow = agents!.agent2.getMessages().length

      // Late join during active flow
      const lateAgent = await createSingleAgent({
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'LateAgent',
      })

      await lateAgent.waitForReady()

      // Verify existing agents continue
      const agent1During = agents!.agent1.getMessages().length
      const agent2During = agents!.agent2.getMessages().length
      const lateDuring = lateAgent.getMessages().length

      expect(agent1During).toBe(agent1Flow)
      expect(agent2During).toBe(agent2Flow)

      expect(lateDuring).toBe(0)
    })
  })

  describe('Existing agents continue during late join', () => {
    it('should maintain operation after late agent connects', () => {
      expect(agents).not.toBeNull()

      const agent1 = agents!.agent1
      const agent2 = agents!.agent2

      // Send exchange
      await agent1.send('A1->A2: 1')
      await agent2.send('A2->A1: 1')

      const msgCountBefore = agent1.getMessages().length

      // Late join
      const lateAgent = await createSingleAgent({
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'LateAgent',
      })

      await lateAgent.waitForReady()

      // Exchange after late join
      await agent1.send('A1->A2: 2')
      await agent2.send('A2->A1: 2')
      await agent1.send('A1->A2: 3')
      await agent2.send('A2->A1: 3')

      const msgCountAfter = agent1.getMessages().length

      // Verify flow continued
      expect(msgCountAfter).toBe(msgCountBefore + 4)
      expect(agent1.getMessages().slice(-2)).toEqual(['A2->A1: 2', 'A2->A1: 3'])
    })
  })

  describe('Late agent with different mode (observe)', () => {
    it('should observe messages without responding', () => {
      expect(agents).not.toBeNull()

      // Agent1 in echo mode (responds)
      const agent1 = agents!.agent1

      // Agent2 in observe mode (logs only)
      const agent2Config: A2ARelayObserverConfig = {
        a2aPort: 3001,
        mode: 'observe',
        agentName: 'ObserverAgent',
      }

      const agent2 = await createSingleAgent(agent2Config)

      await agent2.waitForReady()

      // Send from Agent1
      await agent1.send('Hello Observer')

      await new Promise((resolve) => setTimeout(resolve, 100))

      // Agent2 should have logged (in observe mode)
      const observerLog = agent2.getMessages()

      expect(observerLog.length).toBeGreaterThan(0)

      // Verify it's a log entry (not a chat message)
      const logContent = observerLog[0]?.payload as string || ''
      expect(logContent).toContain('[observe]')
    })

    it('should not interfere with other agents communication', () => {
      expect(agents).not.toBeNull()

      // Agent1 echo, Agent2 observe
      const agent1 = agents!.agent1
      const agent2 = agents!.agent2

      // Establish bidirectional flow
      await agent1.send('A1->A2: ping')
      await new Promise((resolve) => setTimeout(resolve, 100))

      const agent1Log = agent1.getMessages()
      const agent2Log = agent2.getMessages()

      // Agent1 should NOT have echo of Agent2's message
      expect(agent1Log.filter((m) => m.payload === 'A2->A1: ping').length).toBe(0)

      // Agent2 in observe mode should only log
      const observeLogs = agent2Log.filter((m) => typeof m.payload === 'string' && (m.payload as string).includes('[observe]'))

      expect(observeLogs.length).toBeGreaterThan(0)
    })
  })

  describe('Agent state during join', () => {
    it('should have correct states during join sequence', () => {
      expect(agents).not.toBeNull()

      // Agent1 active, send message
      await agents!.agent1.send('Active message')

      const agent1State = agents!.agent1.getObserver().getConnectionState()
      expect(agent1State).toBe('connected')

      // Agent2 connecting (late join)
      const agent2 = await createSingleAgent({
        a2aPort: 3001,
        mode: 'echo',
        agentName: 'LateAgent',
      })

      // While Agent2 is connecting, Agent1 sends
      await agents!.agent1.send('Message during connect')

      const agent1Messages = agents!.agent1.getMessages()

      expect(agent1Messages.length).toBe(2)
      expect(agent1Messages[agent1Messages.length - 1]?.payload).toBe('Message during connect')

      // Agent2 should be in connecting state
      const agent2State = agent2.getObserver().getConnectionState()

      // Note: state may have changed to 'connected' by now
      expect(['connecting', 'connected']).toContain(agent2State)
    })
  })
})
