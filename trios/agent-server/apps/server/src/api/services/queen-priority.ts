/**
 * The order the Queen takes open issues in.
 *
 * SOURCE. gHashTag/t27 `specs/queen/priority.t27` (PR gHashTag/t27#6367,
 * commit c44c7aea32a50abe3b73cb65368a0c9403091698, blob fbbf548c). The
 * vocabulary - levels, label lists, aging, the critical cap, the why codes -
 * is NOT restated here: it is imported from `queen-priority.gen.js`, the
 * verbatim output of `t27c gen-js specs/queen/priority.t27` (t27c 0.4.0).
 * Change the spec and regenerate; never edit the generated file.
 *
 * `t27c gen-js` lowers declarations, not bodies, so the five functions below
 * are written by hand. Each one mirrors the spec function of the same name
 * line for line; if they differ, the spec is right. The rank itself mirrors
 * `rank()` in t27 `scripts/tri_loop/queue.py` (`tri queue`), so the order
 * that command prints is the order this supervisor takes.
 */
import {
  AGING_DAYS,
  CRITICAL_CAP,
  CRITICAL_LABELS,
  HIGH_LABELS,
  LEVEL_CRITICAL,
  LEVEL_HIGH,
  LEVEL_NORMAL,
  LOW_LABELS,
  MAX_AGING_STEPS,
  NORMAL_LABELS,
  WHY_AGED,
  WHY_BLOCKED,
  WHY_CAPPED,
  WHY_LABEL,
  WHY_LISTING,
} from './queen-priority.gen'

export const LEVEL_NAMES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const
export const WHY_NAMES = [
  'listing',
  'label',
  'aged',
  'capped',
  'blocked',
] as const

/** spec: capped_level */
export function cappedLevel(base: number, criticalsBefore: number): number {
  if (base === LEVEL_CRITICAL) {
    if (criticalsBefore >= CRITICAL_CAP) {
      return LEVEL_HIGH
    }
  }
  return base
}

/** spec: effective_level */
export function effectiveLevel(
  level: number,
  labelled: boolean,
  ageDays: number,
): number {
  if (labelled === false) {
    return level
  }
  if (level <= LEVEL_HIGH) {
    return level
  }
  let steps = Math.floor(ageDays / AGING_DAYS)
  if (steps > MAX_AGING_STEPS) {
    steps = MAX_AGING_STEPS
  }
  const gap = level - LEVEL_HIGH
  if (steps >= gap) {
    return LEVEL_HIGH
  }
  return level - steps
}

/** spec: eligible */
export function eligible(openBlockers: number): boolean {
  return openBlockers === 0
}

/** spec: outranks */
export function outranks(
  effA: number,
  levelA: number,
  indexA: number,
  effB: number,
  levelB: number,
  indexB: number,
): boolean {
  if (effA < effB) return true
  if (effA > effB) return false
  if (levelA < levelB) return true
  if (levelA > levelB) return false
  return indexA < indexB
}

/** spec: why */
export function why(
  base: number,
  level: number,
  eff: number,
  labelled: boolean,
  openBlockers: number,
): number {
  if (openBlockers > 0) return WHY_BLOCKED
  if (level !== base) return WHY_CAPPED
  if (eff !== level) return WHY_AGED
  if (labelled) return WHY_LABEL
  return WHY_LISTING
}

/** label -> level, from the spec's lists. A label listed twice keeps the more urgent level. */
const VOCABULARY: ReadonlyMap<string, number> = (() => {
  const lists = [CRITICAL_LABELS, HIGH_LABELS, NORMAL_LABELS, LOW_LABELS]
  const out = new Map<string, number>()
  for (let level = lists.length - 1; level >= 0; level--) {
    for (const label of lists[level].split(',')) out.set(label, level)
  }
  return out
})()

/** The most urgent level among the labels; an issue with none of the spec's labels is NORMAL, unlabelled. */
export function baseLevel(labels: readonly string[]): {
  level: number
  labelled: boolean
} {
  const hits = labels
    .map((name) => VOCABULARY.get(name))
    .filter((level): level is number => level !== undefined)
  return hits.length > 0
    ? { level: Math.min(...hits), labelled: true }
    : { level: LEVEL_NORMAL, labelled: false }
}

/** What the rank reads from one open issue. */
export interface RankableIssue {
  number: number
  labels: readonly string[]
  /** ISO 8601, as GitHub sends `created_at`. */
  createdAt: string
  /** `issue_dependencies_summary.blocked_by`. */
  blockedBy: number
}

export interface RankedIssue<T extends RankableIssue = RankableIssue> {
  issue: T
  index: number
  ageDays: number
  base: number
  labelled: boolean
  level: number
  eff: number
  eligible: boolean
  why: (typeof WHY_NAMES)[number]
}

const DAY_MS = 86_400_000

/**
 * Issues in GitHub's listing order -> every issue with its decision, in the
 * order the spec takes them (stable: equal ranks keep the listing order).
 * Blocked issues are kept in the result with `eligible: false`, so a caller can
 * say what it skipped; the Queen's candidates are the eligible ones.
 */
export function rankIssues<T extends RankableIssue>(
  issues: readonly T[],
  now: Date,
): RankedIssue<T>[] {
  let criticals = 0
  const rows = issues.map((issue, index) => {
    const { level: base, labelled } = baseLevel(issue.labels)
    const level = cappedLevel(base, criticals)
    if (base === LEVEL_CRITICAL) criticals += 1
    const created = Date.parse(issue.createdAt)
    const ageDays = Number.isFinite(created)
      ? Math.max(0, Math.floor((now.getTime() - created) / DAY_MS))
      : 0
    const eff = effectiveLevel(level, labelled, ageDays)
    const blockers = issue.blockedBy
    return {
      issue,
      index,
      ageDays,
      base,
      labelled,
      level,
      eff,
      eligible: eligible(blockers),
      why: WHY_NAMES[why(base, level, eff, labelled, blockers)],
    }
  })
  return rows.sort((a, b) => {
    if (outranks(a.eff, a.level, a.index, b.eff, b.level, b.index)) return -1
    if (outranks(b.eff, b.level, b.index, a.eff, a.level, a.index)) return 1
    return 0
  })
}

/** One line for the round's log: the top pick, its level, and why it is there. */
export function topPickLine(ranked: readonly RankedIssue[]): string {
  const top = ranked.find((r) => r.eligible)
  const skipped = ranked.length - ranked.filter((r) => r.eligible).length
  if (!top) {
    return `priority: no eligible issue (${skipped} blocked)`
  }
  return (
    `priority: top #${top.issue.number} ${LEVEL_NAMES[top.eff]} ` +
    `(base ${LEVEL_NAMES[top.base]}, why=${top.why}, listing ${top.index}, ` +
    `age ${top.ageDays}d); ${skipped} blocked skipped`
  )
}
