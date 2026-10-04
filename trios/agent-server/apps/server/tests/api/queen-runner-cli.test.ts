import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The runner script a volunteer runs, driven end to end: a stand-in swarm
 * that offers one task, a local "upstream" it clones, a local "fork" it pushes
 * to, and a stand-in agent. What it must do is the whole contract of a runner:
 * start from the commit it was given, let the agent work, commit what the
 * agent left, push, and tell the swarm the exact commit - or hand the task
 * back when nothing was done.
 */

const SCRIPT = join(
  import.meta.dir,
  '../../../../tools/queen-runner/queen-runner.mjs',
)
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

let dir: string
let upstream: string
let fork: string
let base: string
let server: ReturnType<typeof Bun.serve>
let completed: Record<string, unknown>[]
let offered: boolean

const CONVERSATION = '6f1c2f9e-3b1d-4c55-9d5c-0a7f1d2e3b4c'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queen-runner-cli-'))
  upstream = join(dir, 'upstream')
  fork = join(dir, 'fork.git')
  spawnSync('git', ['init', '-q', '-b', 'dev', upstream])
  writeFileSync(join(upstream, 'README.md'), 'base\n')
  spawnSync('mkdir', ['-p', join(upstream, 'trios')])
  writeFileSync(join(upstream, 'trios/keep.txt'), 'project\n')
  sh(upstream, 'add', '.')
  sh(upstream, 'commit', '-qm', 'base')
  base = sh(upstream, 'rev-parse', 'HEAD')
  spawnSync('git', ['init', '-q', '--bare', fork])

  completed = []
  offered = false
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (req.headers.get('authorization') !== 'Bearer qr_test')
        return Response.json({ error: 'no' }, { status: 401 })
      if (path === '/queen/runner/heartbeat')
        return Response.json({
          protocol: 2,
          runner: { id: 7, label: 'laptop', lane: 100000007 },
          work: null,
          note: 'ok',
        })
      if (path === '/queen/runner/claim') {
        if (offered) return Response.json({ protocol: 2, work: null })
        offered = true
        return Response.json({
          protocol: 2,
          work: {
            issue: 42,
            branch: 'queen-42',
            conversationId: CONVERSATION,
            repo: 'gHashTag/trios',
            repoUrl: upstream,
            baseRef: 'origin/dev',
            start: { sha: base },
            subdir: 'trios',
            brief: 'Write note.md.',
            systemPrompt: 'Your repository is {{WORKDIR}}.',
            workdirPlaceholder: '{{WORKDIR}}',
            ownedPaths: ['note.md'],
            criteria: ['note.md exists'],
            heartbeatSeconds: 60,
            leaseMinutes: 15,
            capMinutes: 360,
          },
        })
      }
      if (path === '/queen/runner/complete') {
        completed.push((await req.json()) as Record<string, unknown>)
        return Response.json({ issue: 42, closed: true, protocol: 2 })
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterEach(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function runRunner(agent: string) {
  const child = Bun.spawn([process.execPath, SCRIPT, '--once'], {
    env: {
      ...process.env,
      TRIOS_QUEEN_URL: `http://127.0.0.1:${server.port}`,
      TRIOS_RUNNER_TOKEN: 'qr_test',
      TRIOS_RUNNER_REMOTE: 'https://github.com/alice/trios.git',
      TRIOS_RUNNER_PUSH_URL: fork,
      TRIOS_RUNNER_AGENT: agent,
      TRIOS_RUNNER_HOME: join(dir, 'home'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await child.exited
  const out = await new Response(child.stdout).text()
  const err = await new Response(child.stderr).text()
  return { code, out, err }
}

describe('the runner script', () => {
  it('runs the agent in the project, commits its work, pushes, and names the commit', async () => {
    const ran = await runRunner(
      'cat > prompt.seen && printf "a note\\n" > note.md && ' +
        'printf "Done.\\n## VERDICT\\n- 1. note.md exists: met\\n"',
    )
    expect(ran.err).toBe('')
    expect(ran.code).toBe(0)
    expect(completed).toHaveLength(1)
    const [done] = completed
    expect(done.conversationId).toBe(CONVERSATION)
    expect(done.remoteUrl).toBe('https://github.com/alice/trios.git')
    expect(done.branch).toBe('queen-42')
    expect(String(done.said)).toContain('## VERDICT')

    // The commit it named is the one on the fork, and it starts from the base.
    const pushed = sh(fork, 'rev-parse', 'refs/heads/queen-42')
    expect(done.headSha).toBe(pushed)
    expect(sh(fork, 'rev-parse', `${pushed}^`)).toBe(base)
    // The agent ran in the project directory, with the prompt on stdin and
    // the placeholder replaced by the real checkout.
    const files = sh(fork, 'show', '--name-only', '--format=', pushed)
    expect(files.split('\n').sort()).toEqual([
      'trios/note.md',
      'trios/prompt.seen',
    ])
    const prompt = sh(fork, 'show', `${pushed}:trios/prompt.seen`)
    expect(prompt).toContain('Write note.md.')
    expect(prompt).not.toContain('{{WORKDIR}}')
    expect(prompt).toContain(join(dir, 'home', 'work', 'queen-42', 'trios'))
  })

  it('hands the task back when the agent fails and changes nothing', async () => {
    const ran = await runRunner('echo "no key configured" >&2; exit 3')
    expect(ran.code).toBe(0)
    expect(completed).toEqual([
      {
        conversationId: CONVERSATION,
        gaveUp: true,
        reason: 'the agent exited 3 and changed nothing',
      },
    ])
    expect(
      spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/queen-42'], {
        cwd: fork,
      }).status,
    ).not.toBe(0)
  })
})
