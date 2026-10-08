/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHEN A TASK'S FILES STOP SHUTTING OTHER BEES OUT (gHashTag/t27
 * specs/queen/holds.t27, t27#7838).
 *
 * Measured 2026-10-08 15:24Z: 32 of 70 lanes busy and the round said "nothing
 * to choose". 125 of the 135 blocked issues were shut out only by finished
 * work waiting in review - 105 of them by bootstrap/src/compiler.rs - because
 * a finished task held its files for up to 48 hours while the Queen reviewed
 * 23 tasks an hour against 47 finished.
 *
 * The card's holds_files decides, as generated wasm; this file only says which
 * stage a dispatch row is in. A row that no longer holds is handed to queend
 * with no owned paths, so it still claims its own issue (that is its state)
 * but no longer conflicts with anybody's files.
 */

import { loadCardWasm, u32 } from './queen-card-wasm'
import {
  HS_AWAITING,
  HS_DONE,
  HS_ESCALATED,
  HS_SEND_BACK,
  HS_WORKING,
} from './queen-holds.gen'
import { OBSOLETE_STATE } from './queen-review-valve.gen'

export const HOLDS_CARD = 'queen/holds.wasm'

export const holdsFiles = (stage: number, minutes: number): boolean =>
  loadCardWasm(HOLDS_CARD).call('holds_files', stage, u32(minutes)) !== 0

/** The verdicts that end a task: an accepted, failed or closed one holds nothing. */
const DECIDED = new Set([
  'accept',
  'failed',
  'cancelled',
  OBSOLETE_STATE,
  'stale-contract',
])

/** A dispatch row's stage, for its files. */
export function holdStage(finished: boolean, reviewState: unknown): number {
  if (!finished) return HS_WORKING
  const verdict = String(reviewState ?? '')
  if (verdict === 'sendBack') return HS_SEND_BACK
  if (verdict === 'escalate') return HS_ESCALATED
  if (DECIDED.has(verdict)) return HS_DONE
  return HS_AWAITING
}

/**
 * The paths a dispatch row still holds against other bees: all of them while
 * the card says it holds, none after. `finishedAt` is the clock - written once
 * when the bee stops - never the verdict's time, which a wait re-writes every
 * round.
 */
export function heldPaths(
  row: { finished_at?: unknown; review_state?: unknown; owned_paths?: unknown },
  now: number = Date.now(),
): string[] {
  const owned = Array.isArray(row.owned_paths)
    ? (row.owned_paths as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      )
    : []
  const finished = row.finished_at != null
  const minutes = finished
    ? Math.max(
        0,
        (now - new Date(row.finished_at as string | Date).getTime()) / 60_000,
      )
    : 0
  return holdsFiles(holdStage(finished, row.review_state), minutes) ? owned : []
}
