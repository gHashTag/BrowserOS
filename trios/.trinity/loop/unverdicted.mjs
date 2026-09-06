#!/usr/bin/env node
// A finished dispatch whose worker never wrote a verdict block waits for ever.
//
// WHAT THIS FOUND. Sixteen dispatches sit in `wait`, and every review note says
// the same thing: "0 of 4 criteria judged so far", "0 of 5". Not three of five -
// ZERO. The review parsed no verdict at all.
//
// Measured 2026-09-06 against the transcripts themselves: five of five readable
// ones contain no `## VERDICT` anywhere, and the two longest end mid-sentence -
// 222,468 characters ending "Add temporary debu", 225,283 ending "For a test:
// `test(agent): pin the". The workers stopped before concluding.
//
// It is NOT a single budget cliff: the lengths run 95,066 to 225,283, a 58%
// spread. So this reports the fact rather than the theory - a dispatch that
// finished, has a transcript, and carries no block is one the review can never
// judge, whatever stopped the worker.
//
// WHY NOTHING ELSE CATCHES IT. `wait` is deliberately the one valve a timer must
// not touch, and rightly: `needs-you`, `lease` and `unpark` all say so, because
// a wait can be a review that has not run yet. But a wait whose TRANSCRIPT
// exists and has no block will never become anything else, and that is a
// different fact from "the review has not run".
//
// THE THIRD BRANCH KEEPS THIS HONEST. If a transcript DOES carry a block and
// the review still counted zero, the fault is in the parser, not the worker -
// and that is a sharper finding than this file's own thesis. It is reported
// separately and loudly rather than folded into the count.
//
// Usage:
//   node unverdicted.mjs            # what waits, and why it will keep waiting
//   node unverdicted.mjs --limit 8  # fewer transcripts, for a quick pass

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/unverdicted.mjs')

/**
 * Sort one waiting dispatch into the only three answers there are.
 *
 * `unknown` is a real answer and the important one: a transcript that could not
 * be fetched says nothing about the worker, and counting it as "no block" would
 * be the accusation this directory has already made once - forty-two bees
 * charged with a silence that was the query failing.
 */
export function classify(issue, transcript) {
  if (!transcript || transcript.reason === 'unreachable' || transcript.reason === 'unreadable') {
    return { issue, kind: 'unknown', len: 0, why: 'the transcript could not be fetched - this says nothing about the worker' }
  }
  const said = transcript.said || ''
  const len = transcript.len ?? said.length
  if (transcript.reason === 'no-rows' || len === 0) {
    return { issue, kind: 'no-transcript', len: 0, why: 'no transcript rows at all - the worker may never have spoken' }
  }
  if (said.includes('## VERDICT')) {
    return { issue, kind: 'PARSER', len, why: 'the transcript DOES carry a verdict block and the review counted none - the fault is the parser, not the worker' }
  }
  return { issue, kind: 'no-block', len, why: 'a transcript with no verdict block anywhere - the review can never judge this' }
}

export function render(rows) {
  const by = { PARSER: [], 'no-block': [], 'no-transcript': [], unknown: [] }
  for (const r of rows) by[r.kind].push(r)
  const out = [`${rows.length} waiting dispatch(es) examined`, '']
  if (by.PARSER.length) {
    out.push(`!! ${by.PARSER.length} carry a verdict block the review did not read - THIS IS A PARSER FAULT:`)
    for (const r of by.PARSER) out.push(`   #${r.issue}  ${r.len} chars`)
    out.push('')
  }
  out.push(`${by['no-block'].length} finished with a transcript and no verdict block - the review can never judge them:`)
  for (const r of by['no-block']) out.push(`   #${r.issue}  ${r.len} chars`)
  if (by['no-transcript'].length) out.push(`${by['no-transcript'].length} have no transcript rows: ${by['no-transcript'].map((r) => `#${r.issue}`).join(' ')}`)
  if (by.unknown.length) out.push(`${by.unknown.length} could not be fetched, so they are NOT accused: ${by.unknown.map((r) => `#${r.issue}`).join(' ')}`)
  const lens = by['no-block'].map((r) => r.len).sort((a, b) => a - b)
  if (lens.length > 1) {
    const spread = Math.round((100 * (lens[lens.length - 1] - lens[0])) / lens[lens.length - 1])
    out.push('')
    out.push(`lengths run ${lens[0]} to ${lens[lens.length - 1]}, a ${spread}% spread.`)
    out.push(spread > 25
      ? 'Too wide for a single budget cliff, so this reports the fact and not a theory about what stopped the worker.'
      : 'Tight enough to look like one limit - worth naming what that limit is before assuming it is not.')
  }
  return out.join('\n')
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const L = await import(path.join(DIR, 'loop.mjs'))
  const JP = await import(path.join(DIR, 'judge-packet.mjs'))

  const at = process.argv.indexOf('--limit')
  const limit = at >= 0 ? Number(process.argv[at + 1]) || 8 : 8

  const sql = `select issue from queen_dispatch where review_state = 'wait' order by finished_at desc limit ${limit}`
  const js = 'const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query(' +
    JSON.stringify(sql) + ').then(r => { console.log(JSON.stringify(r.rows.map(x => x.issue))); process.exit(0); })' +
    '.catch(e => { console.log("ERR " + e.message); process.exit(1); });'
  let issues = null
  try {
    const out = String(CH.remote(`cd /app/apps/server && bun -e ${L.shq(js)}`, { attempts: 2 }))
    const i = out.indexOf('[')
    if (i >= 0) issues = JSON.parse(out.slice(i))
  } catch { issues = null }
  if (!issues) {
    console.log('the board could not be read - NOTHING was examined. An unreachable board is not an empty one.')
    process.exit(3)
  }
  if (!issues.length) {
    console.log('no dispatch is waiting - nothing to examine')
    process.exit(0)
  }

  const rows = issues.map((n) => classify(n, JP.transcriptOf(String(n))))
  console.log(render(rows))
  const parser = rows.filter((r) => r.kind === 'PARSER').length
  const stuck = rows.filter((r) => r.kind === 'no-block').length
  console.log(`\n${rows.length} examined, ${stuck} will never be judged, ${parser} are a parser fault`)
  process.exit(parser ? 2 : 0)
}
