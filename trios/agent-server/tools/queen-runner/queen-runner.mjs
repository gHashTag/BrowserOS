#!/usr/bin/env node
// queen-runner -- run the Queen's tasks on your own machine, with your own key.
//
// The swarm hands this runner a task (an issue, a brief, a commit to start
// from). The runner checks the repository out locally, runs YOUR coding agent
// on it with YOUR provider key, pushes the result to YOUR fork, and tells the
// swarm where the branch is. The swarm fetches it and its review judges it
// exactly like any other bee's work. Your key never leaves this machine: the
// swarm never asks for it and this script never sends it.
//
// Node 20+ standard library only. Configuration is environment variables:
//
//   TRIOS_QUEEN_URL       the swarm, e.g. https://<server>          (required)
//   TRIOS_RUNNER_TOKEN    the qr_... token from your cabinet         (required)
//   TRIOS_RUNNER_REMOTE   https://github.com/<you>/<fork>.git - a PUBLIC fork
//                         the swarm can fetch your branch from      (required)
//   TRIOS_RUNNER_PUSH_URL where to push, if not the same address (e.g. ssh)
//   TRIOS_RUNNER_AGENT    the agent command. It runs in the project directory
//                         with the full prompt on stdin; what it prints is its
//                         answer. Default: claude -p --permission-mode acceptEdits
//   TRIOS_RUNNER_HOME     where the checkout lives (default ~/.trios-runner)
//
//   node queen-runner.mjs           take tasks until stopped (Ctrl-C hands back)
//   node queen-runner.mjs --once    take at most one task, then exit
//   node queen-runner.mjs --check   say hello to the swarm and exit

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROTOCOL = 2
const IDLE_POLL_MS = Number(process.env.TRIOS_RUNNER_POLL_MS || 30_000)
const SAID_MAX = 64_000
const DEFAULT_AGENT = 'claude -p --permission-mode acceptEdits'

const args = new Set(process.argv.slice(2))
const env = (name) => (process.env[name] || '').trim()

function config() {
  const base = env('TRIOS_QUEEN_URL').replace(/\/+$/, '')
  const token = env('TRIOS_RUNNER_TOKEN')
  const remote = env('TRIOS_RUNNER_REMOTE')
  const missing = [
    !base && 'TRIOS_QUEEN_URL',
    !token && 'TRIOS_RUNNER_TOKEN',
    !remote && !args.has('--check') && 'TRIOS_RUNNER_REMOTE',
  ].filter(Boolean)
  if (missing.length > 0) {
    fail(`set ${missing.join(', ')} first (see the top of this file)`)
  }
  return {
    base,
    token,
    remote,
    pushUrl: env('TRIOS_RUNNER_PUSH_URL') || remote,
    agent: env('TRIOS_RUNNER_AGENT') || DEFAULT_AGENT,
    home: env('TRIOS_RUNNER_HOME') || join(homedir(), '.trios-runner'),
  }
}

function say(line) {
  console.log(
    `[queen-runner ${new Date().toISOString().slice(11, 19)}] ${line}`,
  )
}

function fail(line) {
  console.error(`queen-runner: ${line}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// The swarm. Every call is also a heartbeat on the server side.
// ---------------------------------------------------------------------------
async function call(cfg, path, body) {
  const res = await fetch(`${cfg.base}/queen/runner/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // An error page, not an answer.
  }
  if (res.status === 401)
    fail('the swarm refused this token (revoked, or mistyped)')
  if (!res.ok) {
    const error = new Error(
      json?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`,
    )
    error.status = res.status
    throw error
  }
  return json
}

// ---------------------------------------------------------------------------
// Git, run where it is told and never through a shell.
// ---------------------------------------------------------------------------
function git(cwd, ...argv) {
  const r = spawnSync('git', argv, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(
      `git ${argv.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
    )
  }
  return r.stdout.trim()
}

function hasCommit(cwd, sha) {
  return (
    spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status ===
    0
  )
}

/** The shared clone, fetched up to date, holding the commit the task starts from. */
function prepareClone(cfg, work) {
  const clone = join(cfg.home, 'repo')
  if (!existsSync(join(clone, '.git'))) {
    mkdirSync(cfg.home, { recursive: true })
    say(`cloning ${work.repoUrl} (once)`)
    git(
      cfg.home,
      'clone',
      '--quiet',
      '--filter=blob:none',
      work.repoUrl,
      'repo',
    )
  } else {
    git(clone, 'fetch', '--quiet', 'origin')
  }
  if (work.start.remote) {
    // The review sent the work back: continue from the previous push.
    git(clone, 'fetch', '--quiet', work.start.remote, work.start.branch)
  } else if (!hasCommit(clone, work.start.sha)) {
    git(clone, 'fetch', '--quiet', 'origin', work.start.sha)
  }
  if (!hasCommit(clone, work.start.sha)) {
    throw new Error(`the start commit ${work.start.sha} could not be fetched`)
  }
  return clone
}

/** A fresh worktree for this task, on branch queen-<issue>, at the start commit. */
function prepareWorktree(clone, cfg, work) {
  const tree = join(cfg.home, 'work', work.branch)
  if (existsSync(tree)) {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: clone })
    rmSync(tree, { recursive: true, force: true })
  }
  git(clone, 'worktree', 'prune')
  mkdirSync(join(cfg.home, 'work'), { recursive: true })
  git(
    clone,
    'worktree',
    'add',
    '--quiet',
    '-B',
    work.branch,
    tree,
    work.start.sha,
  )
  return tree
}

// ---------------------------------------------------------------------------
// The agent: your command, your key, this checkout.
// ---------------------------------------------------------------------------
function promptFor(work, workdir) {
  const system = work.systemPrompt.split(work.workdirPlaceholder).join(workdir)
  return [
    system,
    '',
    work.brief,
    '',
    'You are running on a volunteer runner. Edit files in this checkout; the',
    'runner commits anything you leave uncommitted and hands the branch back.',
    'Finish with the "## VERDICT" block the brief asks for: it is how the',
    'review reads your answer.',
  ].join('\n')
}

function runAgent(cfg, workdir, prompt, work, limitMs) {
  return new Promise((resolve) => {
    const child = spawn(cfg.agent, {
      cwd: workdir,
      shell: true,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        QUEEN_ISSUE: String(work.issue),
        QUEEN_WORKDIR: workdir,
        QUEEN_BRANCH: work.branch,
      },
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (out.length < SAID_MAX * 2) out += chunk
    })
    const timer = setTimeout(() => {
      say(
        `the agent ran past ${Math.round(limitMs / 60_000)} minutes; stopping it`,
      )
      child.kill('SIGTERM')
    }, limitMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, out, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** Commit whatever the agent left, so the branch carries all of its work. */
function commitLeftovers(tree, issue) {
  if (git(tree, 'status', '--porcelain') === '') return false
  git(tree, 'add', '-A')
  git(
    tree,
    '-c',
    'user.name=queen-runner',
    '-c',
    'user.email=queen-runner@users.noreply.github.com',
    'commit',
    '--quiet',
    '-m',
    `Work on #${issue} left uncommitted by the agent\n\nCommitted by queen-runner when the agent stopped.`,
  )
  return true
}

// ---------------------------------------------------------------------------
// One task, start to finish.
// ---------------------------------------------------------------------------
let current = null

async function handBack(cfg, work, reason) {
  say(`handing #${work.issue} back: ${reason}`)
  await call(cfg, 'complete', {
    conversationId: work.conversationId,
    gaveUp: true,
    reason: reason.slice(0, 2000),
  }).catch((error) =>
    say(`could not hand it back (${error.message}); its lease will lapse`),
  )
}

async function doTask(cfg, work) {
  current = work
  say(
    `took #${work.issue} (${work.repo}) from ${work.start.remote ? 'its previous push' : work.start.sha.slice(0, 12)}`,
  )
  const beat = setInterval(() => {
    call(cfg, 'heartbeat').catch((error) =>
      say(`heartbeat failed: ${error.message}`),
    )
  }, Math.max(10, work.heartbeatSeconds) * 1000)
  try {
    let tree
    try {
      const clone = prepareClone(cfg, work)
      tree = prepareWorktree(clone, cfg, work)
    } catch (error) {
      await handBack(
        cfg,
        work,
        `could not check the task out: ${error.message}`,
      )
      return
    }
    const workdir = work.subdir ? join(tree, work.subdir) : tree
    const limitMs = Math.max(5, work.capMinutes - 15) * 60_000
    const ran = await runAgent(
      cfg,
      workdir,
      promptFor(work, workdir),
      work,
      limitMs,
    )
    commitLeftovers(tree, work.issue)
    const head = git(tree, 'rev-parse', 'HEAD')
    if (ran.code !== 0 && head === work.start.sha) {
      await handBack(
        cfg,
        work,
        `the agent exited ${ran.code}${ran.error ? ` (${ran.error})` : ''} and changed nothing`,
      )
      return
    }
    git(
      tree,
      'push',
      '--quiet',
      '--force',
      cfg.pushUrl,
      `HEAD:refs/heads/${work.branch}`,
    )
    const done = await call(cfg, 'complete', {
      conversationId: work.conversationId,
      remoteUrl: cfg.remote,
      branch: work.branch,
      headSha: head,
      said: ran.out.slice(-SAID_MAX),
    })
    say(
      `#${work.issue} handed back at ${head.slice(0, 12)}; the Queen's review will judge it${done.closed ? '' : ' (it was already closed)'}`,
    )
  } catch (error) {
    if (error.status === 422 || error.status === 409) {
      await handBack(
        cfg,
        work,
        `the swarm could not take the branch: ${error.message}`,
      )
    } else {
      say(`#${work.issue} failed: ${error.message}`)
    }
  } finally {
    clearInterval(beat)
    current = null
  }
}

async function main() {
  const cfg = config()
  const hello = await call(cfg, 'heartbeat')
  if (hello.protocol !== PROTOCOL) {
    fail(
      `the swarm speaks runner protocol ${hello.protocol}; this script speaks ${PROTOCOL}. Get the current queen-runner.mjs.`,
    )
  }
  say(
    `runner "${hello.runner.label}" on lane ${hello.runner.lane}: ${hello.note}`,
  )
  if (args.has('--check')) return

  let stopping = false
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130)
    stopping = true
    if (current) await handBack(cfg, current, 'the runner was stopped')
    process.exit(130)
  })

  for (;;) {
    const { work } = await call(cfg, 'claim').catch((error) => {
      say(`could not ask for work: ${error.message}`)
      return { work: null }
    })
    if (work) {
      await doTask(cfg, work)
      if (args.has('--once')) return
      continue
    }
    if (args.has('--once')) {
      say('nothing to take right now')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
    await call(cfg, 'heartbeat').catch(() => undefined)
  }
}

main().catch((error) => fail(error.message))
