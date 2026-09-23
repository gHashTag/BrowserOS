/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Route-guard gate — gHashTag/trios#1382.
 *
 * This test deliberately builds no application of its own and re-declares no
 * guard list. It imports the classifier from trios/tools/route-guard-audit.mjs
 * and runs it over the real text of src/api/server.ts, so the rule exists in
 * exactly one place (FR-009). The behavioural middleware test lives in
 * auth-routes.test.ts, outside this issue's boundary, and is untouched.
 */

import { describe, expect, it } from 'bun:test'

import {
  auditServer,
  classifyMounts,
  DEFAULT_ALLOWLIST,
  readServerSource,
  unguardedMounts,
} from '../../../../../../tools/route-guard-audit.mjs'

const source = readServerSource()
const report = auditServer(source, DEFAULT_ALLOWLIST)

// Regression pin for the --no-allowlist run: exactly these seven mounts carry
// no guard today, each for a reason the comments beside the mount give.
// RE-MEASURED 2026-09-13: /api/inngest joined. It is not a shell - it is the
// Queen's scheduler endpoint - and it is unguarded on purpose: Inngest signs
// every request with the signing key and inngest/hono refuses the rest, so the
// signature is the guard, and a trusted-origin check would only refuse Inngest.
// RE-MEASURED 2026-09-17: /queen/hq joined. `createQueenHqRoute` had been
// written and mounted nowhere, so the one page offering "wake her now"
// answered 404 for its whole life; mounting it is what put it on this list. A
// shell on the same terms as the dashboard - no state and no token in the
// HTML - which is the only reason a page is allowed to answer a stranger.
const EXPECTED_UNGUARDED_WITHOUT_ALLOWLIST = [
  '/api/inngest',
  '/health',
  '/queen/dashboard',
  '/queen/feed',
  '/queen/hq',
  '/queen/kanban',
  '/queen/roadmap',
  '/queen/tree',
]

describe('route-guard audit over src/api/server.ts', () => {
  it('sees the full route table', () => {
    // RE-MEASURED 2026-09-06, and one of these moved for a reason worth
    // recording. The table grew from 38 mounts to 40; `publicReadCount` went 5
    // to 6 when `/queen/public-agents` was added, which is deliberate - every
    // public-read entry is an explicit `publicReadCorsMiddleware()` call on a
    // path that says `public` in its own name.
    //
    // `guardedSubAppCount` went 13 to 14 because `/queen/needs-you` was NOT
    // guarded. Its mount carried a comment saying it sat behind the
    // trusted-origin catch-all; nothing did. Production answered 200 to a
    // request with a hostile Origin, returning outstanding escalations with
    // issue numbers, ages and worker-written reason text. This gate had been
    // reporting it since it landed, and was red on the branch the whole time.
    //
    // A pinned count is a restated list, and a restated list goes stale in
    // exactly two ways: something was added on purpose, or a hole opened. The
    // pin cannot tell them apart, so whoever updates it has to look - which is
    // the only reason this one was found.
    // RE-MEASURED 2026-09-13: 40 became 42 with the Queen's scheduler.
    // `/api/inngest` is the signed Inngest endpoint (allowlisted, reason in
    // tools/route-guard-audit.mjs); `/queen/scheduler` is the seventh
    // public-read, an explicit `publicReadCorsMiddleware()` on a projection
    // that names which env vars are set and never their values.
    // RE-MEASURED 2026-09-17: 42 became 44, and the pin had already gone stale
    // in the way its own note above predicts. One was added on purpose and
    // nobody re-measured: `/queen/rehearsal`, a guarded wrapper, took
    // `guardedSubAppCount` from 14 to 15 and left this gate red on the branch.
    // The other is `/queen/hq`, mounted here for the first time - an allowlisted
    // shell, so it moves neither the guarded nor the public-read count.
    // RE-MEASURED 2026-09-23: 44 became 45, and this time the pin went stale in
    // the first of its two ways. One mount was added on purpose -
    // `/queen/public-leaderboard`, an explicit `publicReadCorsMiddleware()` on
    // the lane scoreboard - and the audit puts it in `public-read`, which is
    // where a route named `public` belongs. Every other number here is
    // unchanged, which is the part worth stating: no guarded route quietly lost
    // its guard to make room for it.
    expect(report.totalMounts).toBe(45)
    expect(report.prefixGuardCount).toBe(18)
    expect(report.guardedSubAppCount).toBe(15)
    expect(report.publicReadCount).toBe(8)
  })

  it('reports zero unguarded mounts once the reasoned allowlist is applied', () => {
    expect(report.unguarded).toEqual([])
    expect(unguardedMounts(source, DEFAULT_ALLOWLIST)).toEqual([])
    expect(report.staleAllowlistEntries).toEqual([])
    expect(report.entriesMissingReason).toEqual([])
  })

  it('reports exactly the seven reasoned exceptions when the allowlist is dropped', () => {
    // The classifier reports mounts in file order; the assertion is on the
    // exact set, so both sides are sorted before comparing.
    expect([...unguardedMounts(source, [])].sort()).toEqual(
      [...EXPECTED_UNGUARDED_WITHOUT_ALLOWLIST].sort(),
    )
  })

  it('splits the twenty-two /queen mounts into 8 public-read, 8 wrapper-guarded and 6 allowlisted shells', () => {
    const queenMounts = classifyMounts(source).filter(
      (mount) => mount.path === '/queen' || mount.path.startsWith('/queen/'),
    )
    // RE-MEASURED 2026-09-06 with the counts above. Sixteen became eighteen,
    // and the split is the interesting part: the sixth public-read is
    // /queen/public-agents, deliberate and named; the seventh wrapper is
    // /queen/needs-you, which had been sitting in `unguarded` while its own
    // mount comment claimed it was behind the trusted-origin catch-all.
    // The five allowlisted shells are unchanged - a shell serves no data, which
    // is the only reason any of them is allowed to answer a stranger.
    // RE-MEASURED 2026-09-13: eighteen became nineteen; the seventh
    // public-read is /queen/scheduler (the Inngest projection, no secrets).
    // RE-MEASURED 2026-09-17: nineteen became twenty-one. The eighth wrapper is
    // /queen/rehearsal, added with the in-container bee and never counted here;
    // the sixth shell is /queen/hq, which until today was mounted nowhere.
    // RE-MEASURED 2026-09-23: twenty-one became twenty-two. The eighth
    // public-read is /queen/public-leaderboard - which lane a bee ran on and
    // what it earned, derived from the dispatches on every read. It carries no
    // issue title, no worker text and no credential: only a key's INDEX ever
    // reaches the database, so there is nothing here a stranger could read that
    // the board does not already show.
    expect(queenMounts.length).toBe(22)

    const counts: Record<string, number> = {
      'public-read': 0,
      'prefix-guard': 0,
      wrapper: 0,
      unguarded: 0,
    }
    for (const mount of queenMounts) {
      counts[mount.classification] += 1
    }
    // The four buckets must account for every mount with the exact expected
    // split; anything unaccounted for breaks one of these numbers.
    expect(counts).toEqual({
      'public-read': 8,
      'prefix-guard': 0,
      wrapper: 8,
      unguarded: 6,
    })

    // Every unguarded /queen mount must be one of the allowlisted shells.
    const allowedPaths = new Set(DEFAULT_ALLOWLIST.map((entry) => entry.path))
    for (const mount of queenMounts) {
      if (mount.classification !== 'unguarded') continue
      expect(allowedPaths.has(mount.path)).toBe(true)
    }
  })

  it('classifies /queen/registry as wrapper-guarded', () => {
    const registry = classifyMounts(source).find(
      (mount) => mount.path === '/queen/registry',
    )
    expect(registry?.classification).toBe('wrapper')
    expect(registry?.via).toBe('queenRegistryRoutes')
  })

  it('classifies /terminal as wrapper-guarded (the standalone mount after the builder chain)', () => {
    const terminal = classifyMounts(source).find(
      (mount) => mount.path === '/terminal',
    )
    expect(terminal?.classification).toBe('wrapper')
    expect(terminal?.via).toBe('terminalRoutes')
  })
})
