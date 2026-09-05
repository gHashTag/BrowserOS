#!/usr/bin/env node
// Assemble everything a judge needs to decide whether a bee's work meets its
// criteria, for the issues no mechanical check can reach.
//
// WHY A JUDGE AT ALL. `verdict-audit` proves an identifier was DEFINED. It
// cannot say the definition does anything, and 25 of the night's briefs promise
// no identifier at all - for those, the swarm's own word is the only evidence
// that exists. The field settled this argument: Terminal-Bench stopped
// accepting self-reported results entirely and had a judge read every
// successful trajectory, after the number-one slots on two boards turned out to
// sit 13.5 and 2.5 points above the best independently re-run entry. METR
// measured the gap directly - an automated grader scores 24.2 points above the
// human merge decision, and models silently endorse 31.7% of their own
// behaviour-changing outputs.
//
// WHY THIS SPLIT. The tool assembles; the model judges. Keeping them apart is
// what makes the assembly testable at all, and it keeps the judgement an
// explicit act rather than something a script quietly performs. Nothing here
// decides anything.
//
// Usage:
//   node judge-packet.mjs 1351            # write one packet
//   node judge-packet.mjs --unauditable   # every open issue no check can reach

import fs from 'node:fs'
import * as CH from './channel.mjs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const { shq } = L
const isMain = process.argv[1] && process.argv[1].endsWith('/judge-packet.mjs')

// A CAP, because this step is the one that outgrew the cadence.
//
// It assembles one packet per unauditable dispatch, each needing a transcript
// query into the container. The corpus reached 31 and the step took 6.5
// minutes - inside an 18-minute chain run that held the loop lock while the
// swarm sat at zero, because every timer fire after it stood down.
//
// The packets are reproducible from the branch at any time, so assembling some
// now and the rest next round costs nothing. Assembling all of them while four
// workers wait costs the round.
const MAX_PACKETS = Number(process.env.JUDGE_MAX_PACKETS ?? 8)

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const BASE = 'origin/feat/queen-supervisor'
const OUT = path.join(DIR, 'packets')
// A diff a judge cannot read in full is a diff it will skim, and a skimmed
// judgement is the thing being replaced. Truncate loudly instead.
const MAX_DIFF = Number(process.env.JUDGE_MAX_DIFF ?? 120000)
// THE TAIL, NOT THE HEAD - and this cost a whole judging pass.
//
// The first version took `said.slice(0, MAX_SAID)` and labelled it "its own
// closing report". It is not: a bee's transcript runs 120k-200k characters and
// the first 40k are its PLANNING, cut mid-word before a single command runs. A
// judge given that could only answer UNVERIFIABLE, and did - 21 of 23 run
// criteria died on my slice rather than on the work. The attestation, the
// VERDICT block and any quoted run all sit at the END.
//
// Sixty thousand, because the observed verdict blocks and closing reports run
// to a few thousand and the reasoning immediately before them is what makes a
// claim checkable.
const MAX_SAID = Number(process.env.JUDGE_MAX_SAID ?? 60000)

const sh = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryShell = (c) => { try { return sh(c) } catch { return null } }

/**
 * The Success Criteria as a list, one entry per criterion.
 *
 * A criterion is often several lines - the bullet, then its continuation
 * indented under it. The first version kept only the bullet line, so a judge
 * was handed criteria cut mid-sentence and said so: one packet's criterion read
 * "Run, from .../server:" and then nothing, and all nine of another's were
 * truncated. Verdicts resting on half a sentence are verdicts about the packet,
 * not the work. Continuation lines are folded in.
 */
export function criteriaOf(body) {
  const section = (body.split('## Success Criteria')[1] || '').split('\n## ')[0]
  const out = []
  for (const raw of section.split('\n')) {
    if (/^\s*[-*]\s+\S/.test(raw)) { out.push(raw.trim().replace(/^[-*]\s+/, '')); continue }
    // A continuation belongs to the bullet above it: indented, or simply the
    // next non-empty line before the next bullet or fence.
    if (out.length && raw.trim() && !/^\s*(?:```|#)/.test(raw)) out[out.length - 1] += ' ' + raw.trim()
  }
  return out
}

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
// THE BARE NAME IS GONE. It was the fifth instrument caught measuring something
// other than what it claimed, and the most expensive of them.
//
// This file kept its own `railway` with no path, so under the launchd timers it
// resolved to the June-2025 4.5.4 that cannot attach - and `catch { return null }`
// turned that into "the bee said nothing".
//
// MEASURED: `transcriptOf(1351)` returns 79568 characters with the 5.49.2
// client and NULL under `PATH=/usr/local/bin:...`. Same code, same service,
// same minute; the only variable is which binary the bare name found.
//
// THE COST: all 42 judge packets ever written carry
// "The bee said nothing that was recorded", and all 42 of those bees had a
// transcript - 4,476,899 characters of worker evidence between them. Forty-two
// accusations of silence against workers who had spoken.
//
// The channel is shared now, and the selftest scans every file in this
// directory rather than a list of two.

/**
 * What the bee actually said, from the transcript the Queen judged it on.
 *
 * Returns `{ said, reason }`. The reason is the point: a query that returned no
 * rows and a channel that could not be reached are the same `null` and opposite
 * facts, and rendering the second as the first is what wrote those 42 packets.
 */
export function transcriptOf(number) {
  // ASK FOR WHAT IS USED, NOT FOR EVERYTHING.
  //
  // The renderer shows `said.slice(-MAX_SAID)` - the tail - and the length. The
  // first version fetched the whole transcript through the ssh channel and then
  // threw most of it away. Nine of the 42 regenerated packets came back
  // `unreadable` because of it: #1373's transcript is 183,025 characters and the
  // answer never arrived intact, while the packet only ever needed the last few
  // thousand.
  //
  // `right()` and `length()` are computed in the database, so the wire carries
  // what the packet prints plus one integer. The length is kept separately
  // BECAUSE it is what tells a judge the middle was omitted - a tail with no
  // length reads as the whole thing.
  const js = `const {Pool} = require('pg'); const p = new Pool({connectionString: process.env.DATABASE_URL}); p.query("select length(s) as len, right(s, ${MAX_SAID + 1000}) as said from (select string_agg(t.text, '' order by t.seq) as s from queen_transcript t join queen_dispatch d on d.conversation_id = t.conversation_id where d.issue = ${number} and t.kind = 'say') q").then(r => { console.log('B64:' + Buffer.from(JSON.stringify(r.rows[0] || {})).toString('base64')); process.exit(0); }).catch(e => { console.log('ERR ' + e.message); process.exit(1); });`
  try {
    // BASE64 ON THE WIRE, because a transcript is full of newlines.
    //
    // The channel's output cleaning is line-based, and a 60 KB JSON string
    // carrying a worker's entire transcript does not survive it. Measured on
    // #1373 (183,025 characters): the raw form returns intact at a 5 KB tail
    // and `unreadable` at 17 KB and above, while the SAME query base64-encoded
    // returns len=183025 and a 60,000-character tail without trouble.
    //
    // That is nine of the 42 regenerated packets, and it would have looked like
    // a transcript problem rather than a transport one.
    const out = CH.remote(`cd /app/apps/server && bun -e ${shq(js)}`, { service: SVC, timeout: 200000 })
    const line = String(out).split('\n').map((l) => l.trim()).find((l) => l.startsWith('B64:'))
    if (!line) return { said: null, reason: 'unreadable' }
    const row = JSON.parse(Buffer.from(line.slice(4), 'base64').toString('utf8'))
    const said = row.said || null
    // `len` is the TRUE length; `said` is its tail. Keeping them apart is what
    // lets the packet say "the middle is omitted" honestly.
    return { said, len: Number(row.len) || (said ? said.length : 0), reason: said ? 'ok' : 'no-rows' }
  } catch (e) {
    // A channel that could not be reached says NOTHING about what the bee said.
    return { said: null, reason: 'unreachable', detail: String(e.message || '').slice(0, 160) }
  }
}

export function packet(number) {
  const body = tryShell(`gh issue view ${number} --repo ${REPO} --json body -q .body`)
  if (body === null) return { number, error: 'issue body unreadable' }

  const branch = `origin/queen-${number}`
  if (!tryShell(`git rev-parse --verify --quiet ${branch}`)) {
    return { number, error: 'no pushed branch - there is nothing to judge' }
  }

  const criteria = criteriaOf(body)
  if (!criteria.length) return { number, error: 'no Success Criteria bullets found' }


// THE FORK POINT, NOT THE CURRENT TIP.
//
// A branch is compared against where it FORKED, not against where the base has
// since moved to. Comparing against the tip reports everything merged into the
// base after the branch was cut as if the branch had DELETED it. Measured
// 2026-09-04 on queen-1351: against the tip, "3 files changed, 94 insertions,
// 234 deletions" - it looked as though the bee had removed a fix and its whole
// test file. Against the merge base: "1 file changed, 90 insertions", which is
// what the bee actually did. A judge handed the first version would have
// convicted an innocent worker.
  // THE BEE'S OWN WORDS, because 17 of 39 criteria in the first judged batch
  // asked for a run to be "quoted in the closing report" and NOT ONE PACKET
  // CARRIED A LINE OF RUN OUTPUT. Every "RED IS A FINDING" clause is exactly
  // the promise only the worker's word supports, and that word lives in
  // `queen_transcript`, not in the diff. A judge without it can only ever
  // answer UNVERIFIABLE, which is a verdict about the packet rather than the
  // work.
  const t = transcriptOf(number)
  const said = t.said

  const forkPoint = tryShell(`git merge-base ${BASE} ${branch}`) || BASE
  const stat = tryShell(`git diff --stat ${forkPoint}..${branch}`) || ''
  let diff = tryShell(`git diff ${forkPoint}..${branch}`) || ''
  let truncated = false
  if (diff.length > MAX_DIFF) { diff = diff.slice(0, MAX_DIFF); truncated = true }

  return {
    number,
    criteria,
    stat,
    diff,
    truncated,
    said,
    saidReason: t.reason,
    saidDetail: t.detail,
    saidChars: t.len || (said ? said.length : 0),
    saidTruncated: Boolean(said && (t.len || said.length) > MAX_SAID),
    title: tryShell(`gh issue view ${number} --repo ${REPO} --json title -q .title`),
  }
}

export function render(p) {
  return [
    `# Judge issue #${p.number}`,
    '',
    `## The task, as written`,
    '',
    p.title,
    '',
    '## The criteria, one per line',
    '',
    ...p.criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '## What the bee changed',
    '',
    '```',
    p.stat,
    '```',
    '',
    p.truncated
      ? `## The diff (TRUNCATED at ${MAX_DIFF} characters - say so in any verdict that depended on the missing part)`
      : '## The diff, in full',
    '',
    '```diff',
    p.diff,
    '```',
    '',
    p.said
      ? (p.saidTruncated
          ? `## The END of what the bee said - its closing report and VERDICT block\n\n` +
            `The transcript is ${p.saidChars} characters; the last ${MAX_SAID} are below. ` +
            `The middle is omitted, so a criterion whose evidence would sit there is ` +
            `UNVERIFIABLE by truncation, not by absence - say which if it matters.`
          : '## Everything the bee said, in full - its closing report and VERDICT block')
      : p.saidReason === 'ok' || p.saidReason === 'no-rows'
        ? '## The bee said nothing that was recorded, so every quoted-run criterion is UNVERIFIABLE by absence'
        : `## THE TRANSCRIPT COULD NOT BE FETCHED (${p.saidReason}) - this says nothing about the bee\n\n` +
          'Do not read this as silence. The judge has no evidence either way, and a\n' +
          'criterion is UNVERIFIABLE by a failure of this tool rather than by anything\n' +
          'the worker did or did not do.',
    '',
    p.said ? '```' : '',
    p.said ? p.said.slice(-MAX_SAID) : '',
    p.said ? '```' : '',
  ].join('\n')
}

if (isMain) {
  fs.mkdirSync(OUT, { recursive: true })
  let numbers = process.argv.slice(2).filter((a) => /^\d+$/.test(a))

  if (process.argv.includes('--unauditable')) {
    const open = (tryShell(`gh issue list --repo ${REPO} --state all --limit 200 --json number -q '[.[] | select(.number>=1347)] | .[].number'`) || '').split('\n').filter(Boolean)
    numbers = []
    for (const n of open) {
      const body = tryShell(`gh issue view ${n} --repo ${REPO} --json body -q .body`)
      if (!body) continue
      const crit = (body.split('## Success Criteria')[1] || '').split('\n')
      const mechanical = crit.some((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l)
        && /appears (nowhere|anywhere)|does not (exist|appear)/i.test(l)
        && /`[A-Za-z_][A-Za-z0-9_]{2,}`/.test(l))
      if (!mechanical) numbers.push(n)
    }
    // Newest first, then capped. A packet already on disk is not rebuilt, so
    // the cap advances through the backlog a batch at a time instead of
    // re-walking the same 31 transcripts every round.
    const already = new Set(
      fs.existsSync(OUT) ? fs.readdirSync(OUT).map((f) => f.replace('.md', '')) : [],
    )
    const fresh = numbers.filter((n) => !already.has(String(n)))
    const total = numbers.length
    numbers = (fresh.length ? fresh : numbers).slice(0, MAX_PACKETS)
    if (total > numbers.length) {
      console.log(`${total} unauditable, assembling ${numbers.length} this round (cap ${MAX_PACKETS}); the rest are reproducible from their branches at any time\n`)
    }
  }

  if (!numbers.length) { console.log('usage: judge-packet.mjs <issue> [...] | --unauditable'); process.exit(1) }

  let wrote = 0, skipped = 0
  for (const n of numbers) {
    const p = packet(n)
    if (p.error) { console.log(`.. #${n}  ${p.error}`); skipped++; continue }
    const file = path.join(OUT, `${n}.md`)
    fs.writeFileSync(file, render(p))
    console.log(`-> #${n}  ${p.criteria.length} criteria, ${p.diff.length} chars of diff${p.truncated ? ' (TRUNCATED)' : ''}  ${file}`)
    wrote++
  }
  console.log(`\npackets written ${wrote}   skipped ${skipped}   in ${OUT}`)
}
