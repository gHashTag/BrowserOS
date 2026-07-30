import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCodeProcessRunner } from '../../src/agents/claude-code/process-runner'

async function writeStdoutScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-code-runner-'))
  const script = join(dir, 'stdout-lines')
  await writeFile(script, '#!/bin/sh\nprintf "first\\nbad\\nlast\\n"\n')
  await chmod(script, 0o755)
  return script
}

describe('createClaudeCodeProcessRunner', () => {
  it('passes executable and args to the spawn dependency', async () => {
    const calls: unknown[] = []
    const runner = createClaudeCodeProcessRunner({
      spawn: async (cmd, options) => {
        calls.push({ cmd, options })
        await options.onStdoutLine('{"type":"result","result":"done"}')
        return { exitCode: 0, stderr: '' }
      },
    })

    const result = await runner.run({
      executable: 'claude',
      args: ['-p', 'hello'],
      cwd: '/tmp',
      signal: new AbortController().signal,
      onStdoutLine: async () => {},
    })

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      {
        cmd: ['claude', '-p', 'hello'],
        options: expect.objectContaining({ cwd: '/tmp' }),
      },
    ])
  })

  it('returns stderr and non-zero exit codes', async () => {
    const runner = createClaudeCodeProcessRunner({
      spawn: async () => ({ exitCode: 2, stderr: 'bad auth' }),
    })

    const result = await runner.run({
      executable: 'claude',
      args: [],
      cwd: '/tmp',
      signal: new AbortController().signal,
      onStdoutLine: async () => {},
    })

    expect(result).toEqual({ exitCode: 2, stderr: 'bad auth' })
  })

  it('continues reading stdout after a line handler error', async () => {
    const script = await writeStdoutScript()
    const lines: string[] = []
    const runner = createClaudeCodeProcessRunner()

    const result = await runner.run({
      executable: script,
      args: [],
      cwd: '/tmp',
      onStdoutLine: async (line) => {
        lines.push(line)
        if (line === 'bad') throw new Error('bad line')
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.streamErrors).toEqual(['bad line'])
    expect(lines).toEqual(['first', 'bad', 'last'])
  })
})
