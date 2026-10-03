#!/usr/bin/env node
// A landed bee's recording, handed to `tri cast ship` - as a DRY RUN, and only
// when asked.
//
// WHERE THE RECORDING IS. Every bee job now ends with a terminal recording of
// the commands that prove it (agent-server queen-cast.ts), written to
// /workspace/casts/queen-N.cast on the worker container's volume. The review
// on the container reads it and says in its note whether it passed. The Mac
// cannot see that volume; this file fetches the one recording through the same
// channel every other loop step uses, checks it with `tri cast check`, and,
// only if that is clean, runs `tri cast ship` on it.
//
// WHY A DRY RUN. `tri cast ship` without --confirm renders every local file
// (scrubbed cast, GIF, MP4, archive page, drafts) and sends nothing. Publishing
// a recording is the owner's call, taken by a tap on the admin-DM draft, never
// by a loop. This step never passes --confirm and never passes --repo.
//
// WHY OPT-IN. Rendering a GIF and an MP4 takes real time on a laptop that is
// already the bottleneck, and a landing run should not get slower because a
// new feature exists. TRI_CAST_SHIP=1 turns it on; anything else leaves it off.
//
// Usage:
//   TRI_CAST_SHIP=1 node cast-ship.mjs <issue> [--title T] [--desc D]

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/cast-ship.mjs')

/** The opt-in. Off unless the variable is exactly "1". */
export const shipEnabled = (env = process.env) => env.TRI_CAST_SHIP === '1'

/** Where the container keeps an issue's recording - the path castPathFor() writes. */
export const remoteCastPath = (issue, workspace = process.env.TRIOS_REMOTE_WORKSPACE || '/workspace') =>
  `${workspace}/casts/queen-${Number(issue)}.cast`

/**
 * The remote side. HEX, NOT THE FILE ITSELF: `channel.clean()` drops every line
 * that mentions "Existing" or "Migrate" (railway's connection chatter), and a
 * recording of a migration would lose exactly those lines. Hex digits cannot
 * spell either word. The markers let the answer be found among the chatter.
 */
export const fetchScript = (file) =>
  `f='${file}'; if [ -f "$f" ]; then echo CAST-BEGIN; od -An -v -tx1 "$f" | tr -d ' \\n'; echo; echo CAST-END; else echo CAST-MISSING; fi`

/** Decode the remote answer: the bytes, 'missing', or null when it is not an answer. */
export function decodeFetch(out) {
  const text = String(out ?? '')
  const missing = /^CAST-MISSING$/m.test(text)
  if (missing) return 'missing'
  const m = text.match(/CAST-BEGIN\s*\n([0-9a-f]*)\s*\nCAST-END/)
  const answered = m !== null && m[1].length % 2 === 0
  return answered ? Buffer.from(m[1], 'hex') : null
}

/** Fetch through the container channel, with a buffer a recording fits in. */
async function fetchFromContainer(file) {
  const C = await import(path.join(DIR, 'channel.mjs'))
  const r = C.tryRemote(fetchScript(file), {
    attempts: 2,
    run: (cmd, o) => execSync(cmd, { ...o, maxBuffer: 64 * 1024 * 1024 }),
  })
  const reached = r.ok
  if (!reached) return { error: `${r.kind || 'channel'}: ${String(r.error || '').split('\n')[0]}` }
  return { out: r.out }
}

/** Run a local command and keep its exit code and the tail of what it said. */
function runLocal(argv, timeoutMs) {
  try {
    const out = execSync(argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' '), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout || ''}${e.stderr || ''}${e.message || ''}` }
  }
}

const lastLine = (s) => String(s ?? '').trim().split('\n').filter(Boolean).pop() || ''

/**
 * Fetch, check, and dry-run ship one issue's recording. Never throws; returns
 * `{ issue, result, why }` where result is one of
 *   off       TRI_CAST_SHIP is not 1, nothing was done
 *   unreached the container could not be asked
 *   missing   the bee left no recording
 *   unclean   `tri cast check` refused it - nothing was rendered
 *   failed    `tri cast ship` stopped at a step
 *   drafted   every local file made, nothing sent (the owner confirms)
 */
export async function shipCast(issue, { title, desc, env = process.env, fetch = fetchFromContainer, run = runLocal, dir } = {}) {
  const on = shipEnabled(env)
  if (!on) return { issue, result: 'off', why: 'TRI_CAST_SHIP is not 1' }
  const got = await fetch(remoteCastPath(issue))
  const unreached = Boolean(got.error)
  if (unreached) return { issue, result: 'unreached', why: got.error }
  const bytes = decodeFetch(got.out)
  const noAnswer = bytes === null
  if (noAnswer) return { issue, result: 'unreached', why: 'the container answered without the recording markers' }
  const absent = bytes === 'missing'
  if (absent) return { issue, result: 'missing', why: `no ${remoteCastPath(issue)} on the container` }

  const where = dir || path.join(os.tmpdir(), 'queen-casts')
  fs.mkdirSync(where, { recursive: true })
  const local = path.join(where, `queen-${Number(issue)}.cast`)
  fs.writeFileSync(local, bytes)

  const tri = env.TRI_BIN || 'tri'
  const check = run([tri, 'cast', 'check', local], 60_000)
  const clean = check.code === 0
  if (!clean) return { issue, result: 'unclean', why: lastLine(check.out), cast: local }

  // NO --confirm, NO --repo: every local file, nothing sent, nothing committed.
  const id = `queen-${Number(issue)}`
  const ship = run([tri, 'cast', 'ship', local, id,
    '--title', String(title || `Queen bee work for #${issue}`),
    '--desc', String(desc || `The commands a Queen bee ran to prove its work on #${issue}.`)], 15 * 60_000)
  const shipped = ship.code === 0
  if (!shipped) return { issue, result: 'failed', why: lastLine(ship.out), cast: local }
  return { issue, result: 'drafted', why: lastLine(ship.out), cast: local }
}

/** One line for the landing log. */
export const shipLine = (r) => `  cast  #${r.issue} ${r.result}${r.why ? ` - ${r.why}` : ''}`

if (isMain) {
  const args = process.argv.slice(2)
  const issue = Number(args[0])
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const usable = Number.isInteger(issue) && issue > 0
  if (!usable) {
    console.error('usage: TRI_CAST_SHIP=1 node cast-ship.mjs <issue> [--title T] [--desc D]')
    process.exit(2)
  }
  const r = await shipCast(issue, { title: flag('--title'), desc: flag('--desc') })
  console.log(shipLine(r))
  const bad = !['off', 'drafted', 'missing'].includes(r.result)
  process.exit(bad ? 1 : 0)
}
