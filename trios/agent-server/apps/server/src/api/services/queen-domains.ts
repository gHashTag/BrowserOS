/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Which agent domain a task belongs to (gHashTag/t27 specs/queen/domains.t27,
 * placed by specs/queen/control.t27 section 5: a domain is an affinity, not a
 * cap - owner, 2026-10-08, t27#7674).
 *
 * SOURCE. The codes and the prefix lists come from `queen-domains.gen.js`, the
 * verbatim output of `t27c gen-js` on that card. `gen-js` lowers declarations,
 * not bodies, so the two functions below mirror the spec functions of the same
 * name line for line; queen-domains.test.ts holds them to the spec's own
 * vectors. If they differ, the spec is right.
 */
import {
  DOMAIN_QUEEN_OPS,
  DOMAIN_SPECS,
  DOMAIN_T27B,
  DOMAIN_T27C,
  LIST_END,
  LIST_SEP,
  PREFIXES_QUEEN_OPS,
  PREFIXES_T27B,
  PREFIXES_T27C,
} from './queen-domains.gen'

export * from './queen-domains.gen'

/** starts_with_one_of: does path[0..len] start with one entry of `list`? */
export function startsWithOneOf(
  list: string,
  path: string,
  len: number,
): boolean {
  let i = 0
  while (list.charCodeAt(i) !== LIST_END) {
    let k = 0
    let ok = true
    while (list.charCodeAt(i) !== LIST_SEP && list.charCodeAt(i) !== LIST_END) {
      if (k >= len) {
        ok = false
      } else if (path.charCodeAt(k) !== list.charCodeAt(i)) {
        ok = false
      }
      k += 1
      i += 1
    }
    if (ok) return true
    if (list.charCodeAt(i) === LIST_SEP) i += 1
  }
  return false
}

/** domain_of_path: the domain of one path; unnamed paths are spec work. */
export function domainOfPath(path: string, len = path.length): number {
  if (startsWithOneOf(PREFIXES_T27C, path, len)) return DOMAIN_T27C
  if (startsWithOneOf(PREFIXES_T27B, path, len)) return DOMAIN_T27B
  if (startsWithOneOf(PREFIXES_QUEEN_OPS, path, len)) return DOMAIN_QUEEN_OPS
  return DOMAIN_SPECS
}

/** A task's domain is the domain of the first path its boundary declares. */
export function domainOfTask(paths: readonly string[]): number {
  const first = paths[0]
  return typeof first === 'string' ? domainOfPath(first) : DOMAIN_SPECS
}
