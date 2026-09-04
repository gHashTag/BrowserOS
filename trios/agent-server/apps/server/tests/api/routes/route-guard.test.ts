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
    expect(report.totalMounts).toBe(38)
    expect(report.prefixGuardCount).toBe(18)
    expect(report.guardedSubAppCount).toBe(13)
    expect(report.publicReadCount).toBe(5)
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
