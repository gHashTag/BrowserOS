#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { runEval } from './runner/eval-runner'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`
Web Agent Eval System

Usage:
  bun run eval                          # Opens dashboard in config mode
  bun run eval --config <config.json>   # Runs eval with config file

Config file should include:
  - agent: Agent configuration (single or orchestrator-executor)
  - dataset: Path to dataset JSONL file
  - output_dir: Output directory for results (optional, default: ./results)
  - num_workers: Number of parallel workers
  - trios.server_url: TRIOS server URL
  - grader_model, grader_api_key_env, grader_base_url: Grader settings (optional)
  - timeout_ms: Task timeout in ms (optional)

Preset configs available in configs/:
  - configs/webvoyager-full.json    Full WebVoyager evaluation
  - configs/mind2web-full.json      Full Mind2Web evaluation
  - configs/webvoyager-test.json    WebVoyager test subset (10 tasks)
  - configs/mind2web-test.json      Mind2Web test subset (10 tasks)

Examples:
  bun run eval                                    # Dashboard config mode
  bun run eval -c configs/webvoyager-test.json   # WebVoyager test
  bun run eval -c configs/mind2web-full.json     # Full Mind2Web eval
`)
  process.exit(0)
}

if (values.config) {
  try {
    await runEval({ configPath: values.config })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  process.exit(0)
} else {
  // No config — start dashboard in config mode, wait for user to configure and run
  const { startDashboard } = await import('./dashboard/server')
  startDashboard({
    tasks: [],
    configName: '',
    agentType: '',
    outputDir: '',
    configMode: true,
  })
  console.log(
    'Dashboard running at http://localhost:9900 — configure and run from the UI',
  )

  // Keep process alive until SIGINT
  await new Promise(() => {})
}
