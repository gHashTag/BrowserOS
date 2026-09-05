#!/usr/bin/env node
// The one way into the container, with the retry it always needed.
//
// WHY THIS IS A MODULE AND NOT FOUR COPIES.
//
// `reap`, `lease`, `push-work` and `close-done` all reach the worker container
// through `railway ssh`, and each carried its own six-line copy of the call.
// None of them retried. Asked of the whole ledger on 2026-09-05 - for the first
// time, because every run only ever reported itself:
//
//     reap        45 of 63 runs failed   71%
//     lease       43 of 63              68%
//     push-work   46 of 70              66%
//     close-done  32 of 70              46%
//
// Those are the four steps that FREE the swarm. They had been failing about
// two-thirds of the time for weeks, and the reason was invisible because a
// single failure looks like bad luck and only the record shows it is the system.
//
// One of them - push-work - was given a retry an hour before this file existed,
// after a dropped connection left three accepted pieces of work invisible for a
// round. Copying that fix into three more files would have been L2 all over
// again: a rule transcribed four times is four rules that agree until someone
// edits one. This is that rule, once.
//
// WHAT IT RETRIES AND WHAT IT DOES NOT. A channel failure says nothing about the
// question that was asked - the connection dropped, nobody answered. A non-zero
// exit from the COMMAND is an answer: `git push` exits non-zero when any ref is
// rejected, and a partly-rejected push is a normal outcome its caller already
// knows how to describe. Retrying an answer would be as wrong as crashing on a
// dropped connection.

import { execSync } from 'node:child_process'
import fs from 'node:fs'

export const PROJECT = process.env.TRIOS_RAILWAY_PROJECT || '564d9ebd-7aa8-44fe-93ec-e0b03c87158d'

/**
 * THE BINARY IS NAMED, BECAUSE THE LOOP AND I WERE RUNNING DIFFERENT PROGRAMS.
 *
 * This said `railway`, bare. Both launchd plists run `/bin/zsh -lc`, and the
 * login profile puts /usr/local/bin ahead of the nvm bin:
 *
 *   /bin/zsh -lc 'command -v railway'   /usr/local/bin/railway   4.5.4 (Jun 2025)
 *   my interactive shell                nvm's railway            5.49.2
 *
 * Only one of them can have produced the refusals in the record.
 * `LC_ALL=C grep -ac "Expected welcome message"` is 1 in 4.5.4 and 0 in
 * 5.49.2 - and that string wraps EVERY app-down failure in
 * state/two-views.jsonl and ledger.jsonl.
 *
 * So the "gateway works 39% of the time" was wrong in a way that mattered: the
 * gateway was not being asked. Every launchd sample was refused by a client
 * that cannot attach; every attach in the whole record came from a hand run
 * with the newer binary. Three rounds of step-failure rates, a retry policy, a
 * breaker and a budget were all built on top of a PATH.
 *
 * Named the way PROJECT and SERVICE already are, so a machine with a different
 * layout can say so without editing this file.
 */
/**
 * CHOSEN BY CAPABILITY, NOT BY PATH.
 *
 * The first fix pinned `$HOME/.nvm/versions/node/v22.22.0/bin/railway`. An
 * adversarial reader of that change found the hazard immediately: an nvm version
 * bump moves that directory and the loop loses its only working client, having
 * hardcoded a version number nobody will remember to update.
 *
 * So the candidates are searched and the first one that reports a major version
 * of 5 or more wins. 4.5.4 - the June-2025 build that cannot attach and that
 * `/etc/zprofile`'s path_helper puts first for every scheduled job - is rejected
 * BY ITS VERSION rather than by its location, which is the property that
 * actually matters.
 *
 * If nothing qualifies it falls back to the bare name and says so. A loop that
 * silently picks a client which cannot attach is exactly what cost this project
 * three rounds of measuring the wrong thing.
 */
function pickRailway() {
  if (process.env.TRIOS_RAILWAY_BIN) return process.env.TRIOS_RAILWAY_BIN
  const home = process.env.HOME || ''
  const candidates = []
  try {
    const nvm = `${home}/.nvm/versions/node`
    for (const v of fs.readdirSync(nvm).sort().reverse()) candidates.push(`${nvm}/${v}/bin/railway`)
  } catch { /* no nvm on this machine */ }
  candidates.push('/opt/homebrew/bin/railway', '/usr/local/bin/railway')
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue
      const v = execSync(`${JSON.stringify(c)} --version`, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
      const major = Number((String(v).match(/(\d+)\./) || [])[1])
      if (Number.isFinite(major) && major >= 5) return c
    } catch { /* try the next one */ }
  }
  console.error('  no railway client of version 5 or later was found - falling back to the bare name, which may be one that cannot attach')
  return 'railway'
}

export const RAILWAY_BIN = pickRailway()
export const RAILWAY = `${RAILWAY_BIN} ssh --project ${PROJECT} --environment production`
export const SERVICE = process.env.TRIOS_RAILWAY_SERVICE || 'trios-agent-server'

/** Quote a string for /bin/sh. execSync passes through the LOCAL shell. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** railway prints connection chatter on the same stream as the answer. */
export const clean = (out) =>
  String(out ?? '')
    .split('\n')
    .filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l))
    .join('\n')
    .trim()

/**
 * WHAT KIND OF FAILURE IS THIS? The first version asked a yes/no question and
 * got the answer wrong for every failure that actually happens.
 *
 * I saw ONE failure by hand - `Operation timed out (os error 60)` - and wrote a
 * classifier from it, while holding a ledger with 174 recorded failures I had
 * not looked at. When the evidence field started recording reasons an hour
 * later, the three that arrived were:
 *
 *   "Your application is not running or in a unexpected state"     x2
 *   "Expected welcome message, received: ServerMessage {error}"    x2
 *   "failed to load system trust settings: I/O error"              x1
 *
 * NONE of them matched. The retry I had just built and shipped never fired for
 * any real failure in this system. Generalising from one observation while the
 * record sits unread is the defect this whole directory exists to catch, and I
 * committed it in the tool meant to fix it.
 *
 * They are also three DIFFERENT problems, and one retry policy cannot be right
 * for all of them:
 *
 *   app-down   railway refuses because the service is not in a state it will
 *              attach to. A 15-second retry is optimistic; the app may be
 *              restarting. Worth retrying, with a longer wait, and worth saying
 *              plainly - because `/health` can answer ok while the ssh gateway
 *              refuses, which is two views of one service disagreeing.
 *   local      the railway CLI on THIS machine could not read the system trust
 *              store. Nothing about the container is wrong and retrying the
 *              same call changes nothing. Chasing the container for this would
 *              waste a night.
 *   transport  the connection dropped. Retry soon; it usually comes straight
 *              back.
 *   unknown    say so verbatim and do not retry. An unrecognised failure that
 *              is quietly treated as "not retryable" and an unrecognised
 *              failure that is quietly retried are both worse than one printed.
 */
export function classifyFailure(text) {
  const s = String(text || '')
  if (/not running or in a unexpected state|Expected welcome message|application is not running/i.test(s)) {
    return { kind: 'app-down', retry: true, waitMultiplier: 4, advice: 'railway will not attach to the service; /health may still answer ok - they are different views' }
  }
  if (/system trust settings|failed to load system trust|certificate store|keychain/i.test(s)) {
    return { kind: 'local', retry: false, advice: 'the railway CLI on THIS machine could not read the system trust store - nothing about the container is wrong' }
  }
  // THE REAL VOCABULARY, WHICH ONLY APPEARED ONCE THE CLIENT WORKED.
  //
  // Every failure this loop had ever recorded was wrapped in "Expected welcome
  // message" - a string that exists only in the June-2025 client that cannot
  // attach. With a working client the container's actual failures arrived, and
  // the classifier had never seen any of them:
  //
  //   "Connection to ssh.railway.com closed by remote host"   the container
  //     accepted the connection and then died or refused - measured on
  //     2026-09-05 while /health returned 502 and railway reported the service
  //     CRASHED, with the deployment log full of
  //     `EAGAIN: resource temporarily unavailable` on posix_spawn.
  //
  // It was classified `unknown` and therefore never retried, which is the
  // conservative default and the wrong answer for a service that comes back.
  if (/closed by remote host|Connection closed|channel .* closed|remote host/i.test(s)) {
    return { kind: 'app-down', retry: true, waitMultiplier: 4, advice: 'the container accepted the connection and then closed it - it may be crashing or out of process slots' }
  }
  if (/Operation timed out|os error 60|Connection reset|connection error|SendRequest|client error|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|502 Bad Gateway|503 Service|Temporary failure in name resolution|broken pipe/i.test(s)) {
    return { kind: 'transport', retry: true, waitMultiplier: 1, advice: 'the connection dropped; it usually comes straight back' }
  }
  return { kind: 'unknown', retry: false, advice: 'unrecognised - printed verbatim rather than guessed at' }
}

/** Kept for callers that only need the yes/no. */
export function isChannelFailure(text) {
  return classifyFailure(text).retry
}


// ------------------------------------------------------------ the breaker

// ONE OUTAGE IS ONE FACT, NOT FOUR FAILURES.
//
// Measured across 62 heal runs on 2026-09-05. When `reap` - the first remote
// step - succeeded, the three that follow failed 0%, 7% and 0% of the time.
// When `reap` failed, they failed 96%, 96% and 66%.
//
// They do not cause each other. They share a condition that holds for the whole
// run: the container is not attachable. `reap` is simply the first to find out.
//
// Two consequences, and both were costing something:
//
//   The chain kept asking. After the first step established the door was shut,
//   three more steps knocked - each up to three attempts with backoff - and the
//   run spent minutes learning the same thing four times.
//
//   And the RECORD was inflated fourfold. Every rate this project has quoted -
//   "reap 71%, lease 68%, push-work 66%" - is one outage counted once per step.
//   The honest quantity is that the channel was down in 47 of 62 runs.
//
// So the first process-wide verdict stands for the run. It is per-process on
// purpose: the next run must try again, because the outage is usually over.
let DOWN = null

export function channelDown() { return DOWN }
export function resetChannel() { DOWN = null }

/**
 * Run a script inside the container, retrying only a failing channel.
 *
 * Throws an error with `.channel = true` when the connection could not be made
 * at all, so a caller can tell "I looked and found nothing" from "I never
 * looked" - which are the same silence and completely different facts.
 */
export function remote(script, opts = {}) {
  const {
    service = SERVICE,
    timeout = 280000,
    attempts = 3,
    // A RETRY POLICY WITHOUT A TOTAL BUDGET ALWAYS OVERRUNS ITS CALLER.
    //
    // The app-down backoff waits 15s, then 30s, multiplied by four - so a full
    // three-attempt sequence sleeps 180 seconds before counting the attempts
    // themselves. `feed` fires every 300 seconds and caps a step at 300; on
    // 2026-09-05 its first two real runs both recorded
    // `share-modules: timed out`, which is the retry being patient inside a
    // caller that could not afford it.
    //
    // Attempts bound how many times to ask. Only a deadline bounds how long
    // that takes, and a caller on a clock needs the second one.
    deadlineMs = Number(process.env.CHANNEL_DEADLINE_MS || 0),
    now = () => Date.now(),
    onRetry = (msg) => console.error(`  ${msg}`),
    sleep = (s) => execSync(`sleep ${s}`),
    run = (cmd, o) => execSync(cmd, o),
  } = opts
  const startedAt = now()
  const outOfTime = (nextWaitS) => Boolean(deadlineMs) &&
    (now() - startedAt) + nextWaitS * 1000 >= deadlineMs

  // The door was already found shut in this process. Do not knock again.
  if (DOWN && !opts.ignoreBreaker) {
    const err = new Error(`the channel was already found down in this run (${DOWN.kind}): ${DOWN.advice}`)
    err.channel = true
    err.channelDown = true
    err.channelKind = DOWN.kind
    err.channelAdvice = DOWN.advice
    throw err
  }

  let last = ''
  let kind = { kind: 'unknown', advice: '' }
  for (let i = 0; i < attempts; i++) {
    try {
      return clean(run(`${RAILWAY} --service ${service} -- sh -c ${shq(script)}`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
      }))
    } catch (e) {
      last = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`
      kind = classifyFailure(last)
      // An answer, or something no retry can help. Hand it back untouched, with
      // the kind attached so the caller reports the right problem.
      if (!kind.retry) {
        e.channelKind = kind.kind
        e.channelAdvice = kind.advice
        throw e
      }
      if (i < attempts - 1) {
        const wait = (i + 1) * 15 * (kind.waitMultiplier || 1)
        if (outOfTime(wait)) {
          // Stopping here is not giving up: it is refusing to spend a caller's
          // whole budget on waiting, so the caller can report what happened
          // instead of being killed mid-sleep with nothing to say.
          onRetry(`${kind.kind}: out of time - a ${wait}s wait would pass the ${Math.round(deadlineMs / 1000)}s budget, stopping after ${i + 1} attempt(s)`)
          break
        }
        onRetry(`${kind.kind}: ${kind.advice} - retrying in ${wait}s`)
        sleep(wait)
      }
    }
  }
  // Exhausted. This is the run's verdict on the channel, and the steps that
  // follow inherit it rather than rediscovering it.
  DOWN = { kind: kind.kind, advice: kind.advice, at: new Date().toISOString() }
  const err = new Error(`could not reach the container after ${attempts} attempts (${kind.kind}): ${clean(last).slice(0, 200)}`)
  err.channel = true
  err.channelKind = kind.kind
  err.channelAdvice = kind.advice
  throw err
}

/**
 * The same call for a caller that would rather have null than an exception.
 *
 * `channel` is reported separately in the result so "nothing came back" and
 * "nothing could be asked" stay distinguishable, which is the distinction the
 * whole file exists for.
 */
export function tryRemote(script, opts = {}) {
  try {
    return { ok: true, out: remote(script, opts), channel: false }
  } catch (e) {
    return {
      ok: false,
      out: clean(`${e.stdout || ''}\n${e.stderr || ''}`),
      channel: Boolean(e.channel),
      kind: e.channelKind || classifyFailure(`${e.stdout || ''}${e.stderr || ''}${e.message || ''}`).kind,
      advice: e.channelAdvice || '',
      error: e.message,
    }
  }
}

// A LIBRARY, AND IT STILL ANSWERS WHEN RUN.
//
// The rule in this directory is that every tool carries an isMain guard, because
// a module that does work merely by being imported cannot be tested and cannot
// be reused. Nothing above this line runs at import time. Running the file
// directly probes the channel once and says what it found, which is the most
// useful thing it can do on its own and makes the guard honest rather than
// ceremonial.
const isMain = process.argv[1] && process.argv[1].endsWith('/channel.mjs')
if (isMain) {
  const t0 = Date.now()
  try {
    const out = remote('echo reachable', { attempts: 2 })
    console.log(`the container answered in ${Date.now() - t0} ms: ${out}`)
    process.exit(0)
  } catch (e) {
    console.log(e.channel
      ? `the channel is down: ${e.message}`
      : `the channel is up and the command failed, which is a different fact: ${e.message}`)
    process.exit(e.channel ? 3 : 1)
  }
}
