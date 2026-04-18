/**
 * Test script to validate failure scenario handling
 * Run with: bun apps/eval/scripts/test-failure-scenarios.ts
 *
 * This script simulates various failure scenarios and shows the recovery flow.
 * Run each scenario individually to see how the system handles it.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Subprocess, spawn, spawnSync } from 'bun'

// Ports from config.dev.json - must match TRIOS server_config.json
const EVAL_PORTS = {
  cdp: 9005,
  server: 9105, // http_mcp in config.dev.json
} as const
const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

// ============================================================================
// Utility Functions (copied from parallel-executor for testing)
// ============================================================================

function log(category: string, message: string): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 12)
  console.log(`[${timestamp}] [${category}] ${message}`)
}

function killPort(port: number): void {
  log('UTIL', `Killing processes on port ${port}`)
  spawnSync({
    cmd: ['sh', '-c', `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`],
  })
}

function isTRIOSAppRunning(): boolean {
  const result = spawnSync({
    cmd: ['sh', '-c', 'pgrep -f "TRIOS" 2>/dev/null || true'],
  })
  const output = result.stdout?.toString().trim() ?? ''
  return output.length > 0
}

async function killTRIOSApp(): Promise<void> {
  log('trios', 'Killing TRIOS application...')
  spawnSync({
    cmd: ['sh', '-c', 'pkill -9 -f "TRIOS" 2>/dev/null || true'],
  })
  killPort(EVAL_PORTS.cdp)
  for (let i = 0; i < 10; i++) {
    if (!isTRIOSAppRunning()) {
      log('trios', 'Application killed')
      return
    }
    await sleep(500)
  }
  log('trios', 'Warning: Application may not have fully terminated')
}

async function launchTRIOSApp(): Promise<boolean> {
  log(
    'trios',
    `Launching TRIOS (server disabled, CDP=${EVAL_PORTS.cdp})...`,
  )
  spawnSync({
    cmd: [
      'open',
      '-a',
      'TRIOS',
      '--args',
      '--disable-trios-server',
      `--trios-cdp-port=${EVAL_PORTS.cdp}`,
    ],
  })
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    if (isTRIOSAppRunning()) {
      log('trios', 'Application launched, waiting for initialization (8s)...')
      await sleep(8000)
      return true
    }
  }
  log('trios', 'Failed to launch application')
  return false
}

async function waitForPortFree(
  port: number,
  maxAttempts = 30,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync({
      cmd: ['sh', '-c', `lsof -ti:${port} 2>/dev/null`],
    })
    if (!result.stdout || result.stdout.toString().trim() === '') {
      return true
    }
    await sleep(500)
  }
  return false
}

async function waitForServerHealth(
  port: number,
  maxAttempts = 60,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (res.ok) return true
    } catch {
      /* not ready */
    }
    await sleep(500)
  }
  return false
}

async function waitForBrowserReady(
  port: number,
  maxAttempts = 60,
): Promise<boolean> {
  let connectedCount = 0
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const data = (await res.json()) as { cdpConnected?: boolean }
        if (data.cdpConnected) {
          connectedCount++
          if (connectedCount >= 3) return true
        } else {
          connectedCount = 0
        }
      }
    } catch {
      connectedCount = 0
    }
    await sleep(500)
  }
  return false
}

async function checkBrowserReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const data = (await res.json()) as { cdpConnected?: boolean }
      return data.cdpConnected === true
    }
  } catch {
    /* failed */
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let serverProc: Subprocess | null = null

async function startServer(): Promise<Subprocess> {
  log('SERVER', 'Cleaning up ports...')
  killPort(EVAL_PORTS.server)
  await waitForPortFree(EVAL_PORTS.server, 30)

  log('SERVER', 'Starting server process...')
  const proc = spawn({
    cmd: [
      'bun',
      'apps/server/src/index.ts',
      '--server-port',
      String(EVAL_PORTS.server),
      '--cdp-port',
      String(EVAL_PORTS.cdp),
    ],
    cwd: MONOREPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'development' },
  })
  serverProc = proc
  log('SERVER', `Server started with PID ${proc.pid}`)
  return proc
}

async function stopServer(proc: Subprocess): Promise<void> {
  log('SERVER', 'Stopping server...')
  try {
    proc.kill('SIGKILL')
    await Promise.race([proc.exited, sleep(5000)])
  } catch {
    /* ignore */
  }
  serverProc = null
  log('SERVER', 'Server stopped')
}

// ============================================================================
// Scenario Tests
// ============================================================================

async function scenario1_AppNotRunningAtStart(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 1: TRIOS App Not Running at Start')
  console.log('='.repeat(70))
  console.log(
    'Expected: Detect missing app → Launch app → Wait for init → Continue\n',
  )

  // Kill the app first
  await killTRIOSApp()
  await sleep(2000)

  // Now check what happens
  log('CHECK', `Is TRIOS running? ${isTRIOSAppRunning()}`)

  if (!isTRIOSAppRunning()) {
    log('FLOW', '→ App not running, attempting to launch...')
    const launched = await launchTRIOSApp()
    if (launched) {
      log('FLOW', '→ App launched successfully')
      log('CHECK', `Is TRIOS running now? ${isTRIOSAppRunning()}`)
    } else {
      log('FLOW', '→ FAILED to launch app')
      log(
        'RESULT',
        'Task would FAIL with: "TRIOS application is not running"',
      )
      return
    }
  }

  log('RESULT', 'SUCCESS - App is now running, can proceed with server start')
}

async function scenario2_BrowserNotReady(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 2: Browser Does Not Become Ready Within 30 Seconds')
  console.log('='.repeat(70))
  console.log(
    'Expected: Wait 30s → Restart TRIOS app → Retry → Success or fail after 3 attempts\n',
  )

  // Make sure app is running first
  if (!isTRIOSAppRunning()) {
    log('SETUP', 'Launching TRIOS for test...')
    await launchTRIOSApp()
  }

  const MAX_RETRIES = 3
  let browserOSRestartAttempted = false

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log('ATTEMPT', `Server start attempt ${attempt}/${MAX_RETRIES}`)

    try {
      const proc = await startServer()

      log('WAIT', 'Waiting for server health...')
      const healthy = await waitForServerHealth(EVAL_PORTS.server, 30)
      if (!healthy) {
        throw new Error('Server health check failed')
      }
      log('HEALTH', 'Server health OK')

      log('WAIT', 'Waiting for browser readiness (30s timeout)...')
      const browserReady = await waitForBrowserReady(EVAL_PORTS.server, 60)

      if (!browserReady) {
        log('TIMEOUT', 'Browser did not become ready within 30 seconds')
        await stopServer(proc)

        if (!browserOSRestartAttempted) {
          log('RECOVERY', '→ Restarting TRIOS application...')
          await killTRIOSApp()
          await sleep(2000)
          const restarted = await launchTRIOSApp()
          browserOSRestartAttempted = true

          if (restarted) {
            log('RECOVERY', '→ TRIOS restarted, will retry server')
            continue
          } else {
            log('RECOVERY', '→ FAILED to restart TRIOS')
          }
        }

        throw new Error('Browser did not become ready')
      }

      log('CONNECTED', 'Browser ready!')
      await stopServer(proc)
      log('RESULT', 'SUCCESS - Would proceed with task execution')
      return
    } catch (error) {
      log('ERROR', `Attempt ${attempt} failed: ${error}`)
      if (attempt === MAX_RETRIES) {
        log('RESULT', 'FAILURE - All retries exhausted, task would fail')
      }
    }

    await sleep(5000)
  }
}

async function scenario3_ServerCrashesMidTask(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 3: Server Process Crashes Mid-Task')
  console.log('='.repeat(70))
  console.log(
    'Expected: Task fails → Clean up ports → Next task restarts fresh\n',
  )

  if (!isTRIOSAppRunning()) {
    log('SETUP', 'Launching TRIOS for test...')
    await launchTRIOSApp()
  }

  const proc = await startServer()

  log('WAIT', 'Waiting for server to be ready...')
  const healthy = await waitForServerHealth(EVAL_PORTS.server, 30)
  if (!healthy) {
    log('SETUP', 'Server failed to become healthy')
    return
  }

  const browserReady = await waitForBrowserReady(EVAL_PORTS.server, 60)
  if (!browserReady) {
    log('SETUP', 'Browser did not become ready')
    await stopServer(proc)
    return
  }

  log('READY', 'Server and browser ready')
  log('SIMULATE', 'Simulating server crash by killing the process...')

  // Kill the server to simulate crash
  proc.kill('SIGKILL')
  await sleep(1000)

  // Check what we see now
  log('CHECK', 'Checking server health after crash...')
  const stillHealthy = await waitForServerHealth(EVAL_PORTS.server, 5)
  log('CHECK', `Server health: ${stillHealthy ? 'OK' : 'FAILED'}`)

  log('CHECK', 'Checking browser readiness...')
  const stillConnected = await checkBrowserReady(EVAL_PORTS.server)
  log('CHECK', `Browser ready: ${stillConnected}`)

  if (!stillHealthy || !stillConnected) {
    log('DETECTED', '→ Infrastructure failure detected!')
    log(
      'RECOVERY',
      '→ In real flow: Would clean up ports and restart for next task',
    )

    killPort(EVAL_PORTS.server)
    log('CLEANUP', 'Ports cleaned')

    log('RESULT', 'Task would FAIL, but next task gets clean environment')
  }
}

async function scenario4_ToolTimeout(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 4: Tool Execution Timeout')
  console.log('='.repeat(70))
  console.log(
    'Expected: Tool times out → Error contains "timeout" → Classified as infra error → Clean restart\n',
  )

  // Simulate what happens when we get a timeout error
  const errorMessage = 'MCP tool call timed out after 65000ms'

  log('ERROR', `Received error: "${errorMessage}"`)

  const isInfraError =
    errorMessage.includes('TRIOS') ||
    errorMessage.includes('server') ||
    errorMessage.includes('not connected') ||
    errorMessage.includes('timed out') ||
    errorMessage.includes('timeout')

  log('CLASSIFY', `Is infrastructure error? ${isInfraError}`)

  if (isInfraError) {
    log('FLOW', '→ Error classified as infrastructure failure')
    log('FLOW', '→ Would kill ports for clean next-task state')
    log('FLOW', '→ killPort(9110)')
    log('FLOW', '→ killPort(9310)')
    log('RESULT', 'Task FAILS, but ports cleaned for next task')
  } else {
    log('FLOW', '→ Error classified as task-specific failure')
    log('RESULT', 'Task FAILS, environment not reset')
  }
}

async function scenario5_BrowserUnavailableMidTask(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 5: Browser Becomes Unavailable Mid-Task (App Crashes)')
  console.log('='.repeat(70))
  console.log(
    'Expected: Tool call fails → "not connected" error → Kill app → Restart for next task\n',
  )

  if (!isTRIOSAppRunning()) {
    log('SETUP', 'Launching TRIOS for test...')
    await launchTRIOSApp()
  }

  const proc = await startServer()

  log('WAIT', 'Waiting for server to be ready...')
  await waitForServerHealth(EVAL_PORTS.server, 30)
  await waitForBrowserReady(EVAL_PORTS.server, 60)
  log('READY', 'Server and browser ready')

  log('SIMULATE', 'Simulating TRIOS crash by killing the app...')
  await killTRIOSApp()
  await sleep(2000)

  // Check browser status
  log('CHECK', 'Checking browser readiness after app crash...')
  const stillConnected = await checkBrowserReady(EVAL_PORTS.server)
  log('CHECK', `Browser ready: ${stillConnected}`)

  if (!stillConnected) {
    log('DETECTED', '→ Browser became unavailable!')

    const errorMessage = 'TRIOS helper service not connected'
    log('ERROR', `Tool call would fail with: "${errorMessage}"`)

    const isInfraError = errorMessage.includes('not connected')
    log('CLASSIFY', `Is infrastructure error? ${isInfraError}`)

    if (isInfraError) {
      log('RECOVERY', '→ Cleaning up for next task...')
      await stopServer(proc)
      killPort(EVAL_PORTS.server)

      log('RECOVERY', '→ Next task would check if TRIOS is running...')
      const appRunning = isTRIOSAppRunning()
      log('CHECK', `TRIOS running: ${appRunning}`)

      if (!appRunning) {
        log('RECOVERY', '→ Would launch TRIOS app')
        await launchTRIOSApp()
      }

      log('RESULT', 'Current task FAILS, next task gets fresh environment')
    }
  } else {
    await stopServer(proc)
  }
}

async function scenario6_GracefulShutdown(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 6: Graceful Shutdown (Ctrl+C)')
  console.log('='.repeat(70))
  console.log('Expected: SIGINT received → Kill server → Clean ports → Exit\n')

  log('INFO', 'In real flow, signal handlers are registered at startup:')
  log('CODE', '  process.on("SIGINT", cleanup)')
  log('CODE', '  process.on("SIGTERM", cleanup)')
  log('CODE', '  process.on("uncaughtException", cleanup)')

  log('FLOW', 'When Ctrl+C is pressed:')
  log('FLOW', '  1. isShuttingDown = true (prevent duplicate cleanup)')
  log('FLOW', '  2. Kill server process if running')
  log('FLOW', '  3. Kill processes on ports 9110, 9310')
  log('FLOW', '  4. Exit with code 0')

  log('RESULT', 'Clean shutdown, no orphaned processes')
}

async function scenario7_ConsecutiveFailures(): Promise<void> {
  console.log(`\n${'='.repeat(70)}`)
  console.log('SCENARIO 7: Consecutive Task Failures')
  console.log('='.repeat(70))
  console.log(
    'Expected: Each failed task cleans up → Next task gets fresh start\n',
  )

  const tasks = ['task-1', 'task-2', 'task-3']

  for (const taskId of tasks) {
    log('TASK', `=== Starting ${taskId} ===`)

    // Check if app is running
    log('CHECK', `TRIOS running: ${isTRIOSAppRunning()}`)
    if (!isTRIOSAppRunning()) {
      log('FLOW', '→ Would launch TRIOS')
    }

    // Simulate infrastructure check before task
    log('FLOW', '→ Start server')
    log('FLOW', '→ Wait for health')
    log('FLOW', '→ Wait for browser readiness')

    // Simulate task failure
    const failureReason =
      taskId === 'task-1'
        ? 'Browser did not become ready'
        : taskId === 'task-2'
          ? 'Tool timed out after 65000ms'
          : 'TRIOS helper service not connected'

    log('ERROR', `Task failed: ${failureReason}`)

    const isInfraError =
      failureReason.includes('timeout') ||
      failureReason.includes('not connected')

    if (isInfraError) {
      log('CLEANUP', '→ Detected infra error, cleaning ports')
      log('CLEANUP', '→ killPort(9110)')
    }

    log('CLEANUP', '→ Stop server')
    log('CLEANUP', '→ Wait 2s before next task')

    console.log()
  }

  log('RESULT', 'Each task failure is isolated, next task starts clean')
}

// ============================================================================
// Main Menu
// ============================================================================

async function main() {
  console.log('='.repeat(70))
  console.log('Failure Scenario Test Suite')
  console.log('='.repeat(70))
  console.log(`Server Port: ${EVAL_PORTS.server}`)
  console.log(`CDP Port: ${EVAL_PORTS.cdp}`)
  console.log()

  const scenarios = [
    {
      num: 1,
      name: 'TRIOS App Not Running at Start',
      fn: scenario1_AppNotRunningAtStart,
    },
    {
      num: 2,
      name: 'Browser Does Not Become Ready (30s timeout)',
      fn: scenario2_BrowserNotReady,
    },
    {
      num: 3,
      name: 'Server Process Crashes Mid-Task',
      fn: scenario3_ServerCrashesMidTask,
    },
    {
      num: 4,
      name: 'Tool Execution Timeout (simulated)',
      fn: scenario4_ToolTimeout,
    },
    {
      num: 5,
      name: 'Browser Becomes Unavailable Mid-Task (App Crash)',
      fn: scenario5_BrowserUnavailableMidTask,
    },
    {
      num: 6,
      name: 'Graceful Shutdown (explanation)',
      fn: scenario6_GracefulShutdown,
    },
    {
      num: 7,
      name: 'Consecutive Task Failures (simulated)',
      fn: scenario7_ConsecutiveFailures,
    },
  ]

  console.log('Available scenarios:')
  for (const s of scenarios) {
    console.log(`  ${s.num}. ${s.name}`)
  }
  console.log('  all. Run all scenarios')
  console.log()

  const arg = process.argv[2]

  if (!arg) {
    console.log(
      'Usage: bun apps/eval/scripts/test-failure-scenarios.ts <scenario-number|all>',
    )
    console.log('Example: bun apps/eval/scripts/test-failure-scenarios.ts 1')
    console.log('Example: bun apps/eval/scripts/test-failure-scenarios.ts all')
    process.exit(0)
  }

  // Setup cleanup handler
  const cleanup = async () => {
    console.log('\n[CLEANUP] Cleaning up...')
    if (serverProc) {
      try {
        serverProc.kill('SIGKILL')
      } catch {}
    }
    killPort(EVAL_PORTS.server)
    process.exit(0)
  }
  process.on('SIGINT', cleanup)

  if (arg === 'all') {
    for (const s of scenarios) {
      await s.fn()
      await sleep(3000)
    }
  } else {
    const num = parseInt(arg, 10)
    const scenario = scenarios.find((s) => s.num === num)
    if (!scenario) {
      console.log(`Unknown scenario: ${arg}`)
      process.exit(1)
    }
    await scenario.fn()
  }

  // Cleanup
  if (serverProc) {
    await stopServer(serverProc)
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log('Test completed')
  console.log('='.repeat(70))
}

main().catch(console.error)
