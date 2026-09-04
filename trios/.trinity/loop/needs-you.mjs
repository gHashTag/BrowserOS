#!/usr/bin/env node
// Read the escalations that are addressed to a person and reach none.
//
// THE THIRD VALVE, AND THE ONE A TIMER MUST NOT TOUCH. `sendBack` and `wait`
// were released by a clock in gHashTag/BrowserOS#108, because both are states
// whose input can never change. `escalate` is different on purpose: it means a
// PERSON is needed, and no timer is a person. So the repair is not to release
// it - it is to make sure the person actually hears.
//
// Today nobody does. `queen_report` is written by `queen-tick.ts` with a
// `needs_you` boolean and a headline that literally reads "N waiting on you",
// and `git grep -l queen_report` over the whole server source returns exactly
// two files: the tick that writes it, and the migration that declares the
// column. No route serves it. The message is composed, stored, and addressed
// to nobody.
//
// This is the reader. It is deliberately outside the server, the same way the
// lease was, because the proper fix is a route and that is a deploy.
//
// Usage:
//   node needs-you.mjs           # what is waiting, and since when
//   node needs-you.mjs --all     # including reports that need nobody

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const { shq } = L
const isMain = process.argv[1] && process.argv[1].endsWith('/needs-you.mjs')

const SVC = 'trios-agent-server'

/**
 * The railway invocation, with the project named EXPLICITLY.
 *
 * `railway ssh --service X` resolves the project from whatever directory it is
 * run in, by walking up until it finds a linked one. That works from a shell a
 * person is sitting in and does not work from a launchd timer: measured
 * 2026-09-04, every railway-calling step of the chain failed with
 * `Must provide project when setting service or environment`, while the
 * read-only steps passed - so the timer reported a mostly-healthy chain that
 * had pushed nothing, closed nothing and released nothing for hours, and the
 * swarm sat idle between the runs I happened to trigger by hand.
 *
 * Naming the project removes the dependency on where the process happens to be
 * standing. The id is public - it is in every build URL this repository has
 * ever printed - and carries no credential.
 */
export const RAILWAY = `railway ssh --project 564d9ebd-7aa8-44fe-93ec-e0b03c87158d --environment production`


function remote(js) {
  const one = js.replace(/\s*\n\s*/g, ' ').trim()
  const script = `cd /app/apps/server && bun -e ${shq(one)}`
  const out = execSync(`${RAILWAY} --service ${SVC} -- sh -c ${shq(script)}`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 280000,
  })
  return out.split('\n').filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l)).join('\n').trim()
}

// Constants inlined rather than passed as placeholders: the payload is quoted
// for the remote shell, and these values are written here, not taken from input.
//
// The timestamp column is `at`, not `created_at`. Guessed wrong once; the
// schema in pg-migrate.ts is the answer, and asking it took less time than the
// round trip that failed.
const REPORTS = `
const {Pool} = require('pg');
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query("select id, headline, needs_you, at, extract(epoch from (now() - at))/3600 as age_h from queen_report order by at desc limit 40")
 .then(r => { console.log(JSON.stringify(r.rows)); process.exit(0); })
 .catch(e => { console.log('ERR ' + e.message); process.exit(1); });
`

// THE CLOCK MUST BE ONE NOTHING TOUCHES.
// reviewFinishedDispatches re-reads every `wait` row each round and UPDATEs it
// in place, so `reviewed_at` on a wait row is never more than one tick old.
// Measured 2026-09-04: wait rows showed reviewed_at 0.03 h old against finishes
// 4.7 h old, while accept, escalate and sendBack rows carried honest values.
// A valve keyed on reviewed_at could therefore never fire for wait - it did not,
// for six hours, and cost a whole swarm outage (BrowserOS#109).
// finished_at is written once and never again. Used for every state, not only
// the broken one, because a measure whose correctness depends on which rows
// happen to be swept is a measure waiting to break.
const ESCALATIONS = `
const {Pool} = require('pg');
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query("select d.issue, d.review_note, d.send_backs, extract(epoch from (now() - d.finished_at))/3600 as age_h from queen_dispatch d where d.review_state = 'escalate' order by age_h desc")
 .then(r => { console.log(JSON.stringify(r.rows)); process.exit(0); })
 .catch(e => { console.log('ERR ' + e.message); process.exit(1); });
`

const parse = (raw) => {
  if (raw.startsWith('ERR')) throw new Error(raw)
  const i = raw.indexOf('[')
  if (i < 0) throw new Error(`unparseable answer: ${raw.slice(0, 120)}`)
  return JSON.parse(raw.slice(i))
}

if (isMain) {
  const reports = parse(remote(REPORTS))
  const escalations = parse(remote(ESCALATIONS))
  const wanted = reports.filter((r) => r.needs_you)

  console.log(`reports on record: ${reports.length}   of those addressed to a person: ${wanted.length}`)
  console.log(`escalated dispatches still waiting: ${escalations.length}\n`)

  if (escalations.length) {
    console.log('WAITING ON A PERSON')
    for (const e of escalations) {
      const days = (Number(e.age_h) / 24).toFixed(1)
      console.log(`  #${e.issue}  ${days} day(s)  attempts=${e.send_backs}`)
      const note = String(e.review_note || '').trim()
      console.log(`      ${note ? note.slice(0, 150) : '(no reason recorded - the escalation says only that it escalated)'}`)
    }
  } else {
    console.log('nothing is waiting on a person')
  }

  const show = process.argv.includes('--all') ? reports : wanted
  if (show.length) {
    console.log(`\nREPORTS${process.argv.includes('--all') ? '' : ' THAT ASKED FOR YOU'}`)
    for (const r of show.slice(0, 12)) {
      console.log(`  ${String(r.at).slice(5, 16)}  ${r.needs_you ? '!' : ' '} ${String(r.headline).slice(0, 70)}`)
    }
  }

  // The whole point, said out loud rather than left to be noticed.
  console.log(
    `\nNothing serves any of this. \`queen_report\` is written by queen-tick.ts and ` +
    `declared in pg-migrate.ts, and those are the only two files in the server that ` +
    `mention it. A headline reading "N waiting on you" is composed, stored, and ` +
    `addressed to nobody. This command is the reader; the route is still missing.`,
  )
  L.append({ kind: 'needs-you', reports: reports.length, addressed: wanted.length, escalations: escalations.length })
}
