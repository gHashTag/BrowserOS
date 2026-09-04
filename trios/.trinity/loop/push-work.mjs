#!/usr/bin/env node
// Push bee branches that carry work and are not yet on the remote.
//
// WHY THE WORKER CANNOT DO THIS ITSELF. `remote.origin.url` in the container is
// plain HTTPS with no credential, so `git push` fails with "could not read
// Username". A `GH_TOKEN` IS present in the environment, and a dry-run push
// configured with it succeeds - the gap is one `url.insteadOf` line. It is left
// unwired on purpose: the field's answer to this is not to hand the worker a
// token but to split the two halves, so the agent emits a bundle and a
// privileged step pushes it (githubnext/gh-aw "safe outputs"). Until that split
// exists, this script is the privileged step, run from outside.
//
// Measured 2026-09-04: 100 branches carrying 1321 changed files had never
// reached the remote, and 56 dispatches were marked accepted on work nobody
// could see.
//
// WHAT IT REFUSES TO DO.
//   - Force-push. A branch whose remote history differs is reported and left
//     alone; two such branches existed and overwriting them would have
//     destroyed whatever put them there.
//   - Push a branch with no commits ahead of the base.
//
// Usage:
//   node push-work.mjs           # report
//   node push-work.mjs --push    # act

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
const isMain = process.argv[1] && process.argv[1].endsWith('/push-work.mjs')


const SVC = 'trios-agent-server'
const BATCH = Number(process.env.PUSH_BATCH ?? 12)

function remote(script, timeout = 280000) {
  const out = execSync(`railway ssh --service ${SVC} -- sh -c ${shq(script)}`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
  })
  return out.split('\n').filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l)).join('\n').trim()
}

// Every git call into the container needs `-c safe.directory=*`: the repo is
// owned by another uid, and without it `git branch --list` returns an EMPTY
// list rather than an error - a count of zero would look like "nothing to do".
const G = 'git -c safe.directory=* -C /workspace/BrowserOS'

// ONE LINE, DELIBERATELY. `JSON.stringify` turns a real newline into a literal
// backslash-n, and inside the double quotes of `sh -c "..."` that is two
// characters, not a line break. A multi-line script therefore arrives at the
// remote shell as a single line and dies with "Syntax error: then unexpected".
// Separate with semicolons instead. The same bug was sitting unexercised in
// reap.mjs, whose multi-line branch had never been run.
const SURVEY = [
  // No `git fetch`: it takes minutes on this repository inside the container,
  // and `ls-remote` already answers the only question here - which heads exist
  // on the remote right now.
  `base=$(${G} rev-parse feat/queen-supervisor)`,
  `${G} ls-remote --heads origin 2>/dev/null | sed 's|.*refs/heads/||' | grep '^queen-' | sort > /workspace/.remote-heads`,
  `for b in $(${G} branch --list 'queen-*' | sed 's/^[* +]*//'); do n=$(${G} rev-list --count $base..$b 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then if grep -qx "$b" /workspace/.remote-heads; then echo "ONREMOTE $b"; else echo "MISSING $b $n"; fi; fi; done`,
  `rm -f /workspace/.remote-heads`,
].join('; ')

if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
const survey = remote(SURVEY)

const missing = survey.split('\n').filter((l) => l.startsWith('MISSING ')).map((l) => l.split(/\s+/)[1])
const onRemote = survey.split('\n').filter((l) => l.startsWith('ONREMOTE ')).length

console.log(`branches with work: ${missing.length + onRemote}   already on the remote: ${onRemote}   not pushed: ${missing.length}`)
missing.forEach((b) => console.log(`  -> ${b}`))

if (!missing.length) process.exit(0)
if (!process.argv.includes('--push')) { console.log('\nreport only. re-run with --push to act.'); process.exit(0) }

L.append({ kind: 'push-work', note: `pushing ${missing.length} branches`, branches: missing })

let pushed = 0
const rejected = []
for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH)
  const out = remote(`${G} -c "url.https://x-access-token:$GH_TOKEN@github.com/.insteadOf=https://github.com/" push origin ${batch.join(' ')} 2>&1`)
  const created = (out.match(/new branch/g) || []).length
  pushed += created
  for (const line of out.split('\n')) {
    if (/rejected|error:/.test(line)) rejected.push(line.trim().slice(0, 100))
  }
}
console.log(`\npushed ${pushed}`)
if (rejected.length) {
  console.log('refused, and deliberately not forced:')
  rejected.slice(0, 8).forEach((r) => console.log(`  ${r}`))
}
L.append({ kind: 'push-work-result', pushed, rejected: rejected.length })
}
