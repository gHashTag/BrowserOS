#!/usr/bin/env bun
/**
 * Trinity A2A Benchmark CLI
 */

import { runBaselineScenario, runReconnectScenario, runMultiSessionScenario, getReport } from '../apps/server/src/agent/portable/benchmark-a2a-harness'

async function main() {
  console.log('Trinity A2A Benchmark CLI')
  console.log('============================')
  console.log()

  const command = process.argv[2] || 'baseline'

  switch (command) {
    case 'baseline':
      await runBaselineScenario({
        name: 'baseline',
        sessions: 1,
        messagesPerSession: 5,
      })
      break

    case 'reconnect':
      await runReconnectScenario({
        name: 'reconnect',
        sessions: 1,
        messagesPerSession: 2,
        simulateReconnectAfter: 2,
        maxReconnectAttempts: 3,
      })
      break

    case 'multi':
      await runMultiSessionScenario({
        name: 'multi-session',
        sessions: 2,
        messagesPerSession: 10,
      })
      break

    case 'report':
      const report = getReport()
      console.log(report)
      break

    default:
      console.log('Available commands:')
      console.log('  baseline  - Run baseline test (5 messages, no reconnect)')
      console.log('  reconnect  - Run reconnect test (2 messages, 1 reconnect)')
      console.log('  multi     - Run multi-session test (2 sessions, no reconnect)')
      console.log('  report    - Show report of all runs')
      break
  }

  console.log()
  console.log('Complete! Results saved to .trinity/experience/')
}

main()
