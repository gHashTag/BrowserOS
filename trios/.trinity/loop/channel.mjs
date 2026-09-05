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

export const PROJECT = process.env.TRIOS_RAILWAY_PROJECT || '564d9ebd-7aa8-44fe-93ec-e0b03c87158d'
export const RAILWAY = `railway ssh --project ${PROJECT} --environment production`
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
 * Is this the connection failing, rather than the command answering?
 *
 * Kept deliberately narrow. Every pattern here is something the transport says
 * when it could not deliver the question; nothing here is something a program
 * says about the question itself.
 */
export function isChannelFailure(text) {
  return /Operation timed out|os error 60|Connection reset|connection error|SendRequest|client error|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|502 Bad Gateway|503 Service|Temporary failure in name resolution|broken pipe/i
    .test(String(text || ''))
}

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
    onRetry = (msg) => console.error(`  ${msg}`),
    sleep = (s) => execSync(`sleep ${s}`),
    run = (cmd, o) => execSync(cmd, o),
  } = opts

  let last = ''
  for (let i = 0; i < attempts; i++) {
    try {
      return clean(run(`${RAILWAY} --service ${service} -- sh -c ${shq(script)}`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
      }))
    } catch (e) {
      last = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`
      // An answer, not a failure of the channel. Hand it back untouched.
      if (!isChannelFailure(last)) throw e
      if (i < attempts - 1) {
        const why = (last.match(/os error \d+|Operation timed out|Connection reset|SendRequest|broken pipe/i) || ['dropped'])[0]
        onRetry(`channel to the container failed (${why}) - retrying in ${(i + 1) * 15}s`)
        sleep((i + 1) * 15)
      }
    }
  }
  const err = new Error(`could not reach the container after ${attempts} attempts: ${clean(last).slice(0, 200)}`)
  err.channel = true
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
    return { ok: false, out: clean(`${e.stdout || ''}\n${e.stderr || ''}`), channel: Boolean(e.channel), error: e.message }
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
