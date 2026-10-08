/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A domain is an affinity, not a cap (gHashTag/t27 specs/queen/control.t27
 * section 5 and specs/queen/domains.t27, t27#7674), held to the specs' own
 * vectors.
 */

import { describe, expect, it } from 'bun:test'
import {
  P_CLONE,
  P_REUSE,
  P_WAIT,
  placement,
} from '../../src/api/services/queen-control-rules'
import {
  DOMAIN_QUEEN_OPS,
  DOMAIN_SPECS,
  DOMAIN_T27B,
  DOMAIN_T27C,
  domainOfPath,
  domainOfTask,
  PREFIXES_T27B,
  startsWithOneOf,
} from '../../src/api/services/queen-domains'

describe('placement mirrors control.t27 section 5', () => {
  // test a_domain_is_an_affinity_not_a_cap
  it('gives the fifth, sixteenth and sixty-ninth task of one domain a lane', () => {
    expect(placement(0, 4, 70)).toBe(P_CLONE)
    expect(placement(0, 16, 70)).toBe(P_CLONE)
    expect(placement(0, 69, 70)).toBe(P_CLONE)
    expect(placement(1, 0, 70)).toBe(P_REUSE)
    expect(placement(0, 70, 70)).toBe(P_WAIT)
    expect(placement(0, 71, 70)).toBe(P_WAIT)
  })

  // test a_clone_keeps_the_lineage_and_gets_its_own_lease
  it('reuses, then clones, then waits', () => {
    expect(placement(1, 3, 70)).toBe(P_REUSE)
    expect(placement(0, 3, 70)).toBe(P_CLONE)
    expect(placement(0, 70, 70)).toBe(P_WAIT)
  })
})

describe('domains.t27, mirrored', () => {
  // test a_task_takes_the_domain_of_its_first_path
  it('reads the domain from the path', () => {
    expect(domainOfPath('gen/c/queen/review_valve.c')).toBe(DOMAIN_T27C)
    expect(domainOfPath('bootstrap/src/codegen_c.rs')).toBe(DOMAIN_T27C)
    expect(domainOfPath('bootstrap/src/compiler.rs')).toBe(DOMAIN_T27B)
    expect(domainOfPath('cli/t27b/src/lower.rs')).toBe(DOMAIN_T27B)
    expect(domainOfPath('specs/tri/t27b/lencall.t27')).toBe(DOMAIN_T27B)
    expect(domainOfPath('specs/queen/control.t27')).toBe(DOMAIN_QUEEN_OPS)
    expect(domainOfPath('tools/queen/publish.py')).toBe(DOMAIN_QUEEN_OPS)
    expect(domainOfPath('specs/tri/sort/quick_sort.t27')).toBe(DOMAIN_SPECS)
    expect(domainOfPath('docs/now/x.md')).toBe(DOMAIN_SPECS)
  })

  // test a_prefix_must_fit_inside_the_path
  it('never matches a prefix the path cannot hold', () => {
    expect(domainOfPath('gen/c')).toBe(DOMAIN_SPECS)
    expect(domainOfPath('specs/queen/control.t27', 7)).toBe(DOMAIN_SPECS)
    expect(startsWithOneOf(PREFIXES_T27B, 'bootstrap/', 10)).toBe(true)
    expect(startsWithOneOf(PREFIXES_T27B, 'bootstrap', 9)).toBe(false)
  })

  it('takes a task by its first path, and an empty boundary as specs', () => {
    expect(domainOfTask(['cli/t27b/src/a.rs', 'specs/queen/x.t27'])).toBe(
      DOMAIN_T27B,
    )
    expect(domainOfTask([])).toBe(DOMAIN_SPECS)
  })
})
