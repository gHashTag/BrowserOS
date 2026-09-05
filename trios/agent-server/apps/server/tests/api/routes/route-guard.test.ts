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
  DEFAULT_ALLOWLIST,
  auditServer,
  classifyMounts,
  readServerSource,
  unguardedMounts,
} from '../../../../../../tools/route-guard-audit.mjs'

const source = readServerSource()
const report = auditServer(source, DEFAULT_ALLOWLIST)

// Regression pin for the --no-allowlist run: exactly these six mounts carry
// no guard today, each for a reason the comments beside the mount give.
const EXPECTED_UNGUARDED_WITHOUT_ALLOWLIST = [
  '/health',
  '/queen/dashboard',
  '/queen/feed',
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
    expect(report.totalMounts).toBe(40)
    expect(report.prefixGuardCount).toBe(18)
    expect(report.guardedSubAppCount).toBe(14)
    expect(report.publicReadCount).toBe(6)
  })

  it('reports zero unguarded mounts once the reasoned allowlist is applied', () => {
    expect(report.unguarded).toEqual([])
    expect(unguardedMounts(source, DEFAULT_ALLOWLIST)).toEqual([])
    expect(report.staleAllowlistEntries).toEqual([])
    expect(report.entriesMissingReason).toEqual([])
  })

  it('reports exactly the six reasoned exceptions when the allowlist is dropped', () => {
    // The classifier reports mounts in file order; the assertion is on the
    // exact set, so both sides are sorted before comparing.
    expect([...unguardedMounts(source, [])].sort()).toEqual(
      [...EXPECTED_UNGUARDED_WITHOUT_ALLOWLIST].sort(),
    )
  })

  it('splits the sixteen /queen mounts into 5 public-read, 6 wrapper-guarded and 5 allowlisted shells', () => {
    const queenMounts = classifyMounts(source).filter(
      (mount) => mount.path === '/queen' || mount.path.startsWith('/queen/'),
    )
    expect(queenMounts.length).toBe(16)

    const counts: Record<string, number> = {
      'public-read': 0,
      'prefix-guard': 0,
      wrapper: 0,
      unguarded: 0,
    }
    for (const mount of queenMounts) {
      counts[mount.classification] += 1
    }
    // The four buckets must account for all sixteen mounts with the exact
    // expected split; anything unaccounted for breaks one of these numbers.
    expect(counts).toEqual({
      'public-read': 5,
      'prefix-guard': 0,
      wrapper: 6,
      unguarded: 5,
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
