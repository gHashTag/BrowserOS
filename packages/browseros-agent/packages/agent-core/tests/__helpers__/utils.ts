import { execSync } from 'node:child_process'

// =============================================================================
// Port Management
// =============================================================================

export async function killProcessOnPort(port: number): Promise<void> {
  try {
    console.log(`Finding process on port ${port}...`)

    // -sTCP:LISTEN: only match the process LISTENING on the port.
    // A bare `lsof -ti :port` also matches connected clients — including
    // this very test process (lingering CDP sockets after a browser
    // shutdown) — and killing those aborts the whole test run.
    const raw = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    const pids = raw
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p && Number(p) !== process.pid)
      .join(' ')

    if (pids) {
      console.log(`Terminating process(es) ${pids} on port ${port}...`)

      try {
        execSync(`kill -15 ${pids}`, {
          stdio: 'ignore',
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch {
        execSync(`kill -9 ${pids}`, {
          stdio: 'ignore',
        })
      }

      console.log(`Terminated process on port ${port}`)
    }
  } catch {
    console.log(`No process found on port ${port}`)
  }

  console.log('Waiting 1 second for port to be released...')
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

// =============================================================================
// HTML Helper
// =============================================================================

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const bodyContent = strings.reduce((acc, str, i) => {
    return acc + str + (values[i] || '')
  }, '')

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My test page</title>
  </head>
  <body>
    ${bodyContent}
  </body>
</html>`
}


