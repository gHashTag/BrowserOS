import type { HarnessAgent } from '@/entrypoints/app/agents/agent-harness-types'

/**
 * Order for the /home Recent agents grid.
 *
 * 1. Active turn first — agents mid-turn float to the top so the
 *    Resume affordance is the first thing the user sees on /home.
 * 2. The protected gateway-side `main` agent stays pinned-to-top in
 *    the never-used group on a fresh install (mirrors the rail).
 * 3. Recency (`lastUsedAt` desc).
 * 4. `id` tiebreaker for stability so the grid doesn't reshuffle on
 *    every 5-second poll.
 *
 * Pin is NOT a sort key. The home grid is action-oriented and trusts
 * recency + active-turn to surface the right agent; pinning is an
 * organisation tool that lives on the rail at /agents.
 */
export function orderHomeAgents(agents: HarnessAgent[]): HarnessAgent[] {
  return [...agents].sort((a, b) => {
    const aActive = a.activeTurnId != null
    const bActive = b.activeTurnId != null
    if (aActive !== bActive) return aActive ? -1 : 1

    // Recency wins outright. Never-used agents (`lastUsedAt == null`)
    // both fall to the same `-Infinity` bucket and the seed/id rules
    // below decide their order — but a used agent always beats any
    // never-used agent regardless of id.
    const aValue = a.lastUsedAt ?? Number.NEGATIVE_INFINITY
    const bValue = b.lastUsedAt ?? Number.NEGATIVE_INFINITY
    if (aValue !== bValue) return bValue - aValue

    // Inside the never-used (or exact-tie) group: pin the gateway
    // `main` seed to the top of the group on a fresh install, then
    // fall back to id-stable order so the grid doesn't reshuffle on
    // every poll.
    const aSeed = a.id === 'main' && a.lastUsedAt == null
    const bSeed = b.id === 'main' && b.lastUsedAt == null
    if (aSeed !== bSeed) return aSeed ? -1 : 1

    return a.id.localeCompare(b.id)
  })
}
