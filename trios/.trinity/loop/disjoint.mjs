#!/usr/bin/env node
// Filing N tasks does not give you N workers.
//
// THE MEASUREMENT THAT BUILT THIS, 2026-09-04. The swarm was raised from one bee
// to three, and the fourth slot would not fill. The tick's skip summary read
// `fileConflict: 3`. The cause was mine: of the four issues I had just filed,
// #1420 and #1421 both named
// `trios/agent-server/apps/server/src/api/services/queen-tick.ts` in their
// Boundary. Two bees may not write one file, so the second could never start
// while the first held it.
//
// Four issues, three usable. The backlog looked healthy and the scheduler was
// right to refuse.
//
// WHAT EVERY PARALLEL SYSTEM DOES ABOUT THIS.
//
//   Dependabot        GROUPS updates that would otherwise open conflicting PRs,
//                     rather than opening them and letting the merge fail.
//   Nx, Turborepo     a task graph keyed on file inputs; two tasks run in
//                     parallel only when their input sets are disjoint.
//   Kubernetes        pod anti-affinity: the SCHEDULER is told which things
//                     must not land together, at admission, not on collision.
//   Bazel             an action's inputs and outputs are declared, and the
//                     executor will not run two actions writing one output.
//
// The common shape: the conflict is a property of the WORK, so it is settled
// when the work is created, not when it is dispatched. The Queen's scheduler
// already refuses correctly - `fileConflict` is the right answer - but nothing
// upstream was choosing work that could actually run side by side.
//
// WHAT THIS IS NOT. It does not widen a boundary, merge two tasks, or let two
// bees touch one file. It only decides WHICH of the candidates already worth
// filing should be filed now, so a batch of N yields N startable tasks instead
// of one and a queue.
//
// Usage:
//   import { normalize, collides, disjointBatch } from './disjoint.mjs'
//   node disjoint.mjs        # show what the live swarm currently holds

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/disjoint.mjs')

/**
 * A boundary path reduced to its comparable form.
 *
 * Mirrors `QueenBoundaryPaths.normalize`, INCLUDING its deliberate silence
 * about a trailing slash: `rings/SR-00/` is left alone and the prefix test
 * below is what catches it. Backticks and surrounding punctuation are stripped
 * because a boundary is written in Markdown by hand.
 */
export function normalize(p) {
  return String(p ?? '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/^\.\//, '')
    .trim()
}

/**
 * Whether two paths conflict.
 *
 * COMPONENT-WISE, never as strings. `rings/SR-0` is a string prefix of
 * `rings/SR-00/X.swift` and is not a directory containing it - comparing raw
 * prefixes is how two bees were once told they collided when they did not, and
 * how two that DID collide were let through. A directory conflicts with
 * everything beneath it, in either direction, because a bee given a directory
 * may write any file in it.
 */
export function collides(a, b) {
  const x = normalize(a).replace(/\/+$/, '').split('/').filter(Boolean)
  const y = normalize(b).replace(/\/+$/, '').split('/').filter(Boolean)
  if (!x.length || !y.length) return false
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false
  return true
}

/** Whether any path in `a` conflicts with any path in `b`. */
export const setsCollide = (a, b) =>
  (a || []).some((p) => (b || []).some((q) => collides(p, q)))

/**
 * Choose as many candidates as will actually run side by side.
 *
 * Greedy, largest boundary first. A candidate whose boundary is wide blocks
 * more of the tree, so taking it early and letting narrow ones fill in around
 * it fits more work per round than the reverse - and taking them in the order
 * they happened to be measured, which is what the code did before, fits fewest.
 *
 * `held` is the set of paths live dispatches already own. A candidate that
 * collides with those is not filed at all: it would arrive as an issue the
 * scheduler must refuse, which looks to an operator exactly like a backlog that
 * is full and a swarm that is idle.
 *
 * Returns the chosen candidates AND the ones set aside with the reason, because
 * a selector that silently drops work is indistinguishable from one that is
 * broken.
 */
export function disjointBatch(candidates, held = [], limit = Infinity) {
  const ordered = [...candidates].sort(
    (a, b) => (b.paths?.length ?? 0) - (a.paths?.length ?? 0),
  )
  const taken = []
  const setAside = []
  const claimed = [...held]

  for (const c of ordered) {
    const paths = (c.paths || []).map(normalize).filter(Boolean)
    if (!paths.length) {
      setAside.push({ ...c, why: 'no boundary, so nothing can be reserved for it' })
      continue
    }
    if (taken.length >= limit) {
      setAside.push({ ...c, why: 'over the room left in this round' })
      continue
    }
    const clash = paths.find((p) => claimed.some((q) => collides(p, q)))
    if (clash) {
      setAside.push({ ...c, why: `its boundary ${clash} is already spoken for` })
      continue
    }
    taken.push(c)
    claimed.push(...paths)
  }
  return { taken, setAside }
}

if (isMain) {
  const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
  const js = `
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query("select issue, owned_paths from queen_dispatch where owned_paths is not null and jsonb_array_length(owned_paths) > 0 and review_state is distinct from 'accept' and dispatched_at > now() - interval '7 days'")
 .then(r=>{console.log(JSON.stringify(r.rows)); return p.end()})
 .catch(e=>{console.log(JSON.stringify({error:e.message})); process.exit(1)})
`
  const raw = SE.remote(js)
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
  if (!line) {
    console.log('could not read what the swarm holds')
    process.exit(1)
  }
  const rows = JSON.parse(line)
  console.log('paths the swarm currently holds\n')
  const all = []
  for (const r of rows) {
    const ps = (r.owned_paths || []).map(normalize)
    all.push(...ps)
    console.log(`  #${String(r.issue).padEnd(6)} ${ps.join('  ')}`)
  }
  console.log(`\n${rows.length} dispatch(es) holding ${all.length} path(s)`)
  const dupes = all.filter((p, i) => all.findIndex((q) => collides(p, q)) !== i)
  if (dupes.length) {
    console.log(`\n${dupes.length} of them overlap another - two claims on one file:`)
    for (const d of new Set(dupes)) console.log(`  ${d}`)
  }
}
