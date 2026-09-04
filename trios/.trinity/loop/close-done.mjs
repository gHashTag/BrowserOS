#!/usr/bin/env node
// Close issues whose work the Queen accepted, because she cannot close them
// herself.
//
// WHY THIS EXISTS. On `origin/feat/queen-supervisor` the whole tick touches the
// GitHub API exactly twice, at lines 170 and 499, and both are GET. There is no
// write path. So an accepted issue stays open forever, and every tick re-skips
// it under `completed` - 76 of 104 skips on 2026-09-04, until 70 were closed by
// hand. It regrew to 10 within four hours, which is why this is a script and
// not a memory.
//
// THE ORDER MATTERS. Push the branch before closing, so the closing comment can
// name work a reader can actually open. Closing first leaves a comment
// pointing at a branch that exists only inside a container.
//
// WHAT IT REFUSES TO DO.
//   - EPICs. Closing a parent hides unfinished children.
//   - Anything whose branch is not on the remote, or is empty. If the work
//     cannot be seen, the issue is not demonstrably done.
//   - Anything without an `accept` verdict. `sendBack`, `escalate` and `wait`
//     are unfinished, not finished.
//
// Usage:
//   node close-done.mjs             # report
//   node close-done.mjs --close     # act

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const { shq } = L

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/close-done.mjs')


const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const SVC = 'trios-agent-server'
const BASE = 'origin/feat/queen-supervisor'

const sh = (c, o = {}) => execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...o }).trim()
const tryShell = (c) => { try { return sh(c) } catch { return null } }

function remote(js) {
  const one = js.replace(/\s*\n\s*/g, ' ').trim()
  const script = `cd /app/apps/server && bun -e ${shq(one)}`
  const out = execSync(`railway ssh --service ${SVC} -- sh -c ${shq(script)}`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 280000,
  })
  return out.split('\n').filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l)).join('\n').trim()
}

// Constants are inlined rather than passed as `$1`. With `shq` the local shell
// no longer eats a placeholder, but a literal is simpler here and these values
// are written in this file, not taken from input.
const QUERY = `
const {Pool} = require('pg');
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query("select i.number, i.title, d.branch from queen_issues i join queen_dispatch d on d.issue = i.number where i.state = 'open' and d.review_state = 'accept' order by i.number")
 .then(r => { console.log(JSON.stringify(r.rows)); process.exit(0); })
 .catch(e => { console.log('ERR ' + e.message); process.exit(1); });
`

if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
const raw = remote(QUERY)
if (raw.startsWith('ERR')) { console.error(raw); process.exit(1) }
const rows = JSON.parse(raw.slice(raw.indexOf('[')))

tryShell(`git fetch origin '+refs/heads/queen-*:refs/remotes/origin/queen-*'`)

const plan = []
for (const r of rows) {
  const n = r.number
  const title = String(r.title || '')
  if (/^EPIC/i.test(title)) { plan.push({ n, skip: 'EPIC - closing a parent would hide unfinished children' }); continue }
  const branch = `origin/${r.branch || `queen-${n}`}`
  const head = tryShell(`git rev-parse --verify --quiet ${branch}`)
  if (!head) { plan.push({ n, skip: 'branch is not on the remote - the work cannot be seen' }); continue }

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
  const forkPoint = tryShell(`git merge-base ${BASE} ${branch}`) || BASE
  const files = (tryShell(`git diff --name-only ${forkPoint}..${branch}`) || '').split('\n').filter(Boolean)
  if (!files.length) { plan.push({ n, skip: 'branch is empty' }); continue }
  const subject = tryShell(`git log -1 --format=%s ${branch}`) || ''
  plan.push({ n, branch: r.branch || `queen-${n}`, sha: head.slice(0, 9), files: files.length, subject, title })
}

const closable = plan.filter((p) => !p.skip)
for (const p of plan) {
  console.log(p.skip ? `.. #${p.n}  ${p.skip}` : `-> #${p.n}  ${p.sha}  ${p.files} file(s)  ${p.subject.slice(0, 56)}`)
}
console.log(`\nclosable ${closable.length}   skipped ${plan.length - closable.length}`)

if (!process.argv.includes('--close')) { console.log('\nreport only. re-run with --close to act.'); process.exit(0) }
if (!closable.length) process.exit(0)

L.append({ kind: 'close-done', note: `closing ${closable.length} accepted issues`, issues: closable.map((p) => p.n) })

let ok = 0, failed = 0
for (const p of closable) {
  const body = [
    'Closed after verifying the work exists.',
    '',
    `The Queen accepted this dispatch. The result is commit \`${p.sha}\` on branch \`${p.branch}\` - _${p.subject.replace(/`/g, '')}_ - ${p.files} file(s) changed, on \`gHashTag/BrowserOS\`.`,
    '',
    'It stayed open because the deployed supervisor cannot write to GitHub: `queen-tick.ts` makes exactly two `api.github.com` calls and both are GET. Until that write path exists, an accepted issue stays open and is re-skipped as `completed` on every tick, crowding out real candidates. Closed by `tri close-done`.',
  ].join('\n')
  try {
    sh(`gh issue close ${p.n} --repo ${REPO} --reason completed --comment ${JSON.stringify(body)}`)
    ok++
  } catch (e) { failed++; console.log(`  FAILED #${p.n}: ${String(e.message).slice(0, 80)}`) }
}
console.log(`\nclosed ${ok}   failed ${failed}`)
L.append({ kind: 'close-done-result', closed: ok, failed })
}
