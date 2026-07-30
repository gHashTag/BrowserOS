import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..')
const junitPath = process.env.BROWSEROS_JUNIT_PATH?.trim()
const testArgs = process.argv.slice(2)

const cmd = [process.execPath, 'test']

if (junitPath) {
  const outputPath = resolve(projectRoot, junitPath)
  mkdirSync(dirname(outputPath), { recursive: true })
  cmd.push('--reporter=junit', `--reporter-outfile=${outputPath}`)
}

cmd.push(...testArgs)

const result = spawnSync(cmd[0], cmd.slice(1), {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
