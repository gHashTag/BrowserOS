/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A model call on a lane no bee is using, for the Queen's side jobs: shaping
 * issues and the t27-bees review.
 *
 * WHY. Measured 2026-10-08: the shaper's first real calls all ended "the
 * operation timed out". It always took the first review lane and ignored the
 * keys running bees hold, and a z.ai key carries two concurrent requests. So
 * the call queued behind the bees until its 120 s ceiling. The round's own
 * reviewer never had this problem, because it passes runningKeys first. This
 * does the same:
 * - it never asks for a lane a running bee holds;
 * - it skips a lane in its half-hour backoff;
 * - it honours the reviewer pins (TRIOS_QUEEN_REVIEW_POOL / _MODEL) through
 *   chooseReviewerLane;
 * - on "not now" it tries up to MAX_LANES lanes, each one once.
 */

import type { Pool } from 'pg'
import type { AppLlm } from './queen-app'
import { reviewLaneCandidates, type WorkerProvider } from './queen-dispatch'
import {
  chooseReviewerLane,
  defaultReviewerLlm,
  reviewerLaneBackedOff,
  reviewerLaneKey,
} from './queen-reviewer'
import { runningKeys } from './queen-tick'

export const MAX_LANES = 3

export interface FreeLaneDeps {
  candidates?: (taken: number[]) => WorkerProvider[]
  call?: typeof defaultReviewerLlm
  taken?: (pool: Pool) => Promise<number[]>
}

export function freeLaneLlm(
  pool: Pool | null,
  deps: FreeLaneDeps = {},
): AppLlm {
  const candidates =
    deps.candidates ?? ((taken: number[]) => reviewLaneCandidates(taken))
  const call = deps.call ?? defaultReviewerLlm
  return async (system, message) => {
    const taken = pool ? await (deps.taken ?? runningKeys)(pool) : []
    const tried = new Set<string>()
    let last = 'no reviewer lane is free'
    for (let i = 0; i < MAX_LANES; i += 1) {
      const choice = chooseReviewerLane(
        candidates(taken)
          .filter((lane) => !reviewerLaneBackedOff(lane))
          .filter((lane) => !tried.has(reviewerLaneKey(lane))),
        {},
      )
      if (!choice) break
      const lane = choice.lane
      tried.add(reviewerLaneKey(lane))
      const answer = await call(lane, system, message)
      if (answer.ok)
        return {
          ok: true,
          text: answer.text,
          model: `${lane.provider}/${lane.model}`,
        }
      last = answer.error
      if (!answer.transient) return answer
    }
    return { ok: false, error: last, transient: true }
  }
}
