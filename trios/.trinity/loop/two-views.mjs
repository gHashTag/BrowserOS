#!/usr/bin/env node
// Two views of one service, sampled at the same moment.
//
// WHY THIS EXISTS. On 2026-09-05 at 01:15:53 the chain recorded three steps
// failing with "Your application is not running or in a unexpected state" from
// `railway ssh`. Asked a minute later, `GET /health` answered
// `{"status":"ok"}`.
//
// Both are true statements about the same service, and neither is "the truth" -
// they answer different questions. HTTP asks whether the app can serve a
// request. The ssh gateway asks whether the platform will attach a shell to the
// deployment, which also depends on the deployment's state, the runtime, and
// whatever the gateway believes about it.
//
// The mistake available here is to pick one and call it health. A green health
// check has been read, in this project, as evidence the channel will connect. It
// is not. So both are sampled TOGETHER and the disagreement is recorded as its
// own fact, because a disagreement observed a minute apart is not evidence of
// anything - by then the world has moved.
//
// It records rather than concludes. Outages are intermittent and cannot be
// summoned; the instrument that catches the next one is worth more than a story
// about the last one.
//
// Usage:
//   node two-views.mjs            # one sample, printed
//   node two-views.mjs --record   # one sample, appended to the record
//   node two-views.mjs --report   # what the record says so far

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/two-views.mjs')
const RECORD = path.join(DIR, 'state', 'two-views.jsonl')
const HEALTH = process.env.TRIOS_HEALTH_URL || 'https://trios-agent-server-production.up.railway.app/health'

/**
 * The HTTP view: can the app serve a request?
 *
 * A non-200 and an unreachable host are different answers and both are kept.
 * "ok" here means the app answered and said so, nothing more.
 */
export function httpView(run) {
  // NO TEMP FILE, BECAUSE A FULL DISK WOULD HAVE READ AS A DEAD SERVICE.
  //
  // This wrote the body with `curl -o /tmp/two-views-body` and read it back.
  // When the volume filled - it sat at 125 MB free on 2026-09-06 and a
  // `mktemp -d` in this very session failed with ENOSPC - curl exits 23 on the
  // write, execSync throws, and the sample is recorded as `reachable: false`.
  // The instrument would have entered "the app is down" into a record whose
  // whole purpose is to say which view of the service is telling the truth,
  // and the cause would have been a disk on this laptop.
  //
  // The body comes back on stdout with the status code appended on its own
  // final line, so there is nothing to write and nothing to run out of.
  const fetchIt = run || ((url) => execSync(
    `curl -s -w '\\n%{http_code}' --max-time 20 ${JSON.stringify(url)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 },
  ))
  try {
    const raw = String(fetchIt(HEALTH) ?? '')
    const cut = raw.lastIndexOf('\n')
    const code = (cut === -1 ? raw : raw.slice(cut + 1)).trim()
    const body = cut === -1 ? '' : raw.slice(0, cut)
    const ok = code === '200' && /"status"\s*:\s*"ok"/.test(body)
    return { reachable: true, code, ok, body: body.slice(0, 200) }
  } catch (e) {
    return { reachable: false, code: null, ok: false, error: String(e.message || '').slice(0, 200) }
  }
}

/**
 * The gateway view: will the platform attach a shell to the deployment?
 *
 * Deliberately a SINGLE attempt with no retry. The question is what the gateway
 * says right now, and a retry would answer a different question - whether it
 * says the same thing fifteen seconds later, which is what the chain's breaker
 * is for.
 */
export async function sshView(deps = {}) {
  const CH = deps.CH || await import(path.join(DIR, 'channel.mjs'))
  const before = CH.channelDown()
  try {
    // ignoreBreaker: this instrument's whole job is to ask, even when the chain
    // has already decided not to.
    // While we are attached, take the container's process pressure too.
    //
    // WHY HERE. On 2026-09-05 the service CRASHED with the deployment log full
    // of `EAGAIN: resource temporarily unavailable` on posix_spawn - the
    // container could not fork. A fresh container sits at 65 of 1000 pids with
    // zero zombies, so the exhaustion accumulates and the crash is the END of a
    // process nobody was watching. This probe already attaches every chain run;
    // asking two more questions while it is there costs nothing and turns a
    // sudden crash into a rising number.
    // READ /proc, NOT ps. THE CONTAINER HAS NO ps.
    //
    // The first version of this meter counted zombies with
    // `ps -eo stat | grep -c '^Z'`. `ps` is not installed in this image, so the
    // pipeline produced nothing and the count was 0 - which read as "no
    // zombies" for a full round while there were 37 of them.
    //
    // A check whose tool is absent reports health. That is the same defect this
    // project has found in a disk guard reading the wrong filesystem and in a
    // scheduled job reaching the wrong command, and here it was in the
    // instrument I had just built to watch for a crash.
    //
    // /proc always exists on Linux. Field 3 of /proc/<pid>/stat is the state
    // letter, and Z is a zombie.
    const probe = [
      'echo attached',
      'echo PIDS $(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo 0)/$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo 0)',
      'z=0; tot=0; for d in /proc/[0-9]*; do s=$(awk \'{print $3}\' "$d/stat" 2>/dev/null) || continue; tot=$((tot+1)); [ "$s" = "Z" ] && z=$((z+1)); done',
      'echo PROCS $tot ZOMBIES $z',
    ].join('; ')
    const out = CH.remote(probe, { attempts: 1, ignoreBreaker: true, onRetry: () => {} })
    const s = String(out)
    const pids = s.match(/PIDS (\d+)\/(\d+)/)
    const zomb = s.match(/ZOMBIES (\d+)/)
    const procs = s.match(/PROCS (\d+)/)
    return {
      attached: /attached/.test(s),
      kind: 'ok',
      detail: s.replace(/\s+/g, ' ').slice(0, 120),
      pids: pids ? { used: Number(pids[1]), max: Number(pids[2]) } : null,
      zombies: zomb ? Number(zomb[1]) : null,
      procs: procs ? Number(procs[1]) : null,
    }
  } catch (e) {
    const text = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`
    const k = CH.classifyFailure(text)
    return { attached: false, kind: k.kind, advice: k.advice, detail: text.replace(/\s+/g, ' ').slice(0, 200) }
  } finally {
    // Asking must not change the chain's verdict for this process.
    if (!before) CH.resetChannel()
  }
}

export async function sample(deps = {}) {
  const http = deps.http || httpView(deps.fetchIt)
  const ssh = deps.ssh || await sshView(deps)
  return {
    at: new Date().toISOString(),
    http,
    ssh,
    // The fact this file exists for: the two views disagreeing at one moment.
    disagree: http.ok !== ssh.attached,
  }
}

export function append(s, file = RECORD) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(s) + '\n')
  } catch { /* a sample that cannot be stored is still a sample */ }
}

export function read(file = RECORD) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/**
 * What the record says, with its denominator.
 *
 * Four states, not two. "Both up" and "both down" are agreement; the other two
 * are the interesting ones, and they are different problems - HTTP down while
 * ssh attaches is not the same failure as ssh refusing a service that answers.
 */
export function summarise(rows) {
  const t = { n: rows.length, bothUp: 0, bothDown: 0, httpOnly: 0, sshOnly: 0, kinds: {} }
  for (const r of rows) {
    const h = r.http?.ok
    const s = r.ssh?.attached
    if (h && s) t.bothUp++
    else if (!h && !s) t.bothDown++
    else if (h && !s) t.httpOnly++
    else t.sshOnly++
    if (!s && r.ssh?.kind) t.kinds[r.ssh.kind] = (t.kinds[r.ssh.kind] || 0) + 1
  }
  return t
}

export function render(t) {
  if (!t.n) return '  no samples yet - this records the next disagreement rather than explaining the last one'
  const pct = (n) => `${Math.round((100 * n) / t.n)}%`
  return [
    `  ${t.n} sample(s)`,
    `    both up                    ${String(t.bothUp).padStart(4)}  ${pct(t.bothUp)}`,
    `    both down                  ${String(t.bothDown).padStart(4)}  ${pct(t.bothDown)}`,
    `    HTTP ok, ssh REFUSED       ${String(t.httpOnly).padStart(4)}  ${pct(t.httpOnly)}   <- a green health check is not evidence the channel will connect`,
    `    ssh attached, HTTP down    ${String(t.sshOnly).padStart(4)}  ${pct(t.sshOnly)}`,
    Object.keys(t.kinds).length ? `    ssh refusal kinds: ${Object.entries(t.kinds).map(([k, v]) => `${k}=${v}`).join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

if (isMain) {
  if (process.argv.includes('--report')) {
    const rows = read()
    console.log('two views of one service, sampled together\n')
    console.log(render(summarise(rows)))
    process.exit(0)
  }
  const s = await sample()
  console.log(`http ${s.http.ok ? 'ok' : `NOT ok (${s.http.code ?? 'unreachable'})`}   ` +
    `ssh ${s.ssh.attached ? 'attached' : `REFUSED (${s.ssh.kind})`}   ` +
    `${s.disagree ? 'THEY DISAGREE' : 'they agree'}`)
  if (!s.ssh.attached && s.ssh.detail) console.log(`  ssh said: ${s.ssh.detail.slice(0, 140)}`)
  if (process.argv.includes('--record')) append(s)
  // Exit 2 on a disagreement: it is the finding, not a failure of this tool.
  process.exit(s.disagree ? 2 : 0)
}
