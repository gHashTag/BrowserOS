/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * gHashTag/t27 specs/queen/jobs.t27 and control.t27 section 7, held to the
 * specs' own vectors; and the release job card, read by the compiler wasm.
 */

import { describe, expect, it } from 'bun:test'
import {
  afterLook,
  DO_LOOK,
  DO_NOTHING,
  DO_RUN,
  DO_SKIP,
  EFF_DONE,
  EFF_INTENT,
  EFF_NONE,
  EK_RELEASE,
  effectAction,
  effectCanBeLookedUp,
} from '../../src/api/services/queen-control-rules'
import { cargoVersion, loadJobCard } from '../../src/api/services/queen-jobs'
import {
  A_ADVANCE,
  A_FAIL,
  A_RETRY,
  A_STAY,
  E_REFUSE,
  E_REHEARSE,
  E_RUN,
  effectMayRun,
  isTerminal,
  J_CANCELLED,
  J_DONE,
  J_FAILED,
  J_RUNNING,
  jobCancelAllowed,
  jobMayStart,
  jobStateAfter,
  O_BLOCKED,
  O_FAIL,
  O_NOT_YET,
  O_PASS,
  SK_CHECK,
  SK_EFFECT,
  SK_WAIT,
  STEP_RUN_LIMIT,
  stepAction,
  stepAfter,
  WAIT_LIMIT_MINUTES,
} from '../../src/api/services/queen-jobs-rules'

describe('jobs.t27, mirrored', () => {
  // test a_release_walks_its_steps_to_done
  it('walks a release to done', () => {
    const a = stepAction(SK_CHECK, O_PASS, 1, 0)
    expect(a).toBe(A_ADVANCE)
    expect(jobStateAfter(a, 0, 7)).toBe(J_RUNNING)
    expect(stepAfter(a, 0)).toBe(1)
    const w = stepAction(SK_WAIT, O_NOT_YET, 1, 30)
    expect(w).toBe(A_STAY)
    expect(stepAfter(w, 4)).toBe(4)
    expect(jobStateAfter(w, 4, 7)).toBe(J_RUNNING)
    expect(jobStateAfter(A_ADVANCE, 6, 7)).toBe(J_DONE)
    expect(jobStateAfter(A_ADVANCE, 5, 7)).toBe(J_RUNNING)
  })

  // test no_person_is_waited_for
  it('waits no person', () => {
    expect(stepAction(SK_WAIT, O_NOT_YET, 1, WAIT_LIMIT_MINUTES - 1)).toBe(
      A_STAY,
    )
    expect(stepAction(SK_WAIT, O_NOT_YET, 1, WAIT_LIMIT_MINUTES)).toBe(A_FAIL)
    expect(stepAction(SK_EFFECT, O_BLOCKED, 1, WAIT_LIMIT_MINUTES - 1)).toBe(
      A_STAY,
    )
    expect(stepAction(SK_EFFECT, O_BLOCKED, 1, WAIT_LIMIT_MINUTES)).toBe(A_FAIL)
    expect(jobStateAfter(A_FAIL, 3, 7)).toBe(J_FAILED)
  })

  // test a_failure_is_retried_then_fails_the_job
  it('retries, then fails', () => {
    expect(stepAction(SK_CHECK, O_FAIL, 1, 0)).toBe(A_RETRY)
    expect(stepAction(SK_EFFECT, O_FAIL, 2, 0)).toBe(A_RETRY)
    expect(stepAction(SK_EFFECT, O_FAIL, STEP_RUN_LIMIT, 0)).toBe(A_FAIL)
    expect(stepAction(SK_CHECK, O_FAIL, STEP_RUN_LIMIT, 0)).toBe(A_FAIL)
    expect(stepAction(SK_WAIT, O_FAIL, 1, 0)).toBe(A_FAIL)
    expect(stepAction(SK_CHECK, O_NOT_YET, 1, 0)).toBe(A_FAIL)
    expect(stepAction(SK_EFFECT, O_NOT_YET, 1, 0)).toBe(A_FAIL)
    expect(stepAction(SK_CHECK, 9, 1, 0)).toBe(A_FAIL)
    expect(stepAfter(A_RETRY, 2)).toBe(2)
    expect(jobStateAfter(A_RETRY, 2, 7)).toBe(J_RUNNING)
  })

  // test an_irreversible_effect_needs_a_checked_pinned_subject
  it('runs an effect only at a checked, pinned subject, never in a rehearsal', () => {
    expect(effectMayRun(false, true, true)).toBe(E_RUN)
    expect(effectMayRun(false, false, true)).toBe(E_REFUSE)
    expect(effectMayRun(false, true, false)).toBe(E_REFUSE)
    expect(effectMayRun(true, true, true)).toBe(E_REHEARSE)
    expect(effectMayRun(true, false, true)).toBe(E_REFUSE)
    expect(effectMayRun(true, true, false)).toBe(E_REFUSE)
  })

  // tests a_cancel_stops_a_running_job_only and one_job_per_card_and_no_lane
  it('cancels a running job only, and runs one per card', () => {
    expect(jobCancelAllowed(J_RUNNING)).toBe(true)
    expect(jobCancelAllowed(J_DONE)).toBe(false)
    expect(jobCancelAllowed(J_FAILED)).toBe(false)
    expect(jobCancelAllowed(J_CANCELLED)).toBe(false)
    expect(isTerminal(J_CANCELLED)).toBe(true)
    expect(isTerminal(J_RUNNING)).toBe(false)
    expect(jobMayStart(0)).toBe(true)
    expect(jobMayStart(1)).toBe(false)
  })
})

describe('control.t27 section 7, mirrored, for a release', () => {
  // test a_release_is_looked_up_by_its_tag_and_never_published_twice
  it('looks a release up before publishing it again', () => {
    expect(effectCanBeLookedUp(EK_RELEASE)).toBe(true)
    expect(effectAction(EFF_NONE, EK_RELEASE, 0, 8, 8)).toBe(DO_RUN)
    expect(effectAction(EFF_INTENT, EK_RELEASE, 1, 8, 8)).toBe(DO_LOOK)
    expect(effectAction(EFF_DONE, EK_RELEASE, 1, 8, 8)).toBe(DO_SKIP)
    expect(afterLook(true, 3)).toBe(DO_SKIP)
    expect(afterLook(false, 1)).toBe(DO_RUN)
    expect(effectAction(EFF_NONE, EK_RELEASE, 0, 8, 7)).toBe(DO_NOTHING)
  })
})

describe('the release card, read by the compiler wasm', () => {
  it('names five steps, checks before the publish', async () => {
    const card = await loadJobCard('release-t27c')
    expect(card.stepKind).toEqual([0, 0, 2, 1, 1])
    expect(card.stepWhat).toEqual([
      'version-truth',
      'tag-absent',
      'github-release',
      'release-workflow',
      'crate-published',
    ])
    expect(card.params).toEqual(['version'])
    expect(card.publishStep).toBe(2)
    expect(card.crate).toBe('t27c')
    expect(card.tagPrefix).toBe('t27c-v')
  })

  it('refuses a card it does not know', async () => {
    await expect(loadJobCard('release-anything')).rejects.toThrow()
  })

  it('reads the version the way release.yml does', () => {
    expect(cargoVersion('[package]\nname = "t27c"\nversion = "0.5.0"\n')).toBe(
      '0.5.0',
    )
    expect(cargoVersion('[package]\nname = "t27c"\n')).toBeNull()
  })
})

describe('a job is asked for in an issue', () => {
  const body = (mode?: string) =>
    [
      'Release t27c 0.6.0 through the swarm.',
      '',
      '## Job',
      '',
      'card: release-t27c',
      'version: 0.6.0',
      ...(mode ? [`mode: ${mode}`] : []),
      '',
      '## Notes',
      'version: 9.9.9',
    ].join('\n')

  it('reads the card and the version, and rehearses unless told to publish', async () => {
    const { jobRequestOf } = await import('../../src/api/services/queen-jobs')
    const asked = { body: body(), labels: ['queen-job'], author: 'gHashTag' }
    expect(jobRequestOf(asked, 'gHashTag')).toEqual({
      card: 'release-t27c',
      params: { version: '0.6.0' },
      rehearsal: true,
    })
    expect(
      jobRequestOf({ ...asked, body: body('publish') }, 'gHashTag')?.rehearsal,
    ).toBe(false)
    expect(
      jobRequestOf({ ...asked, body: body('Publish') }, 'gHashTag')?.rehearsal,
    ).toBe(true)
  })

  it('ignores an unlabelled issue, a stranger, and an unknown card', async () => {
    const { jobRequestOf } = await import('../../src/api/services/queen-jobs')
    const asked = { body: body(), labels: ['queen-job'], author: 'gHashTag' }
    expect(jobRequestOf({ ...asked, labels: [] }, 'gHashTag')).toBeNull()
    expect(jobRequestOf({ ...asked, author: 'someone' }, 'gHashTag')).toBeNull()
    expect(jobRequestOf({ ...asked, author: undefined }, 'gHashTag')).toBeNull()
    expect(
      jobRequestOf(
        { ...asked, body: body().replace('release-t27c', 'drop-db') },
        'gHashTag',
      ),
    ).toBeNull()
    expect(
      jobRequestOf({ ...asked, body: 'card: release-t27c' }, 'gHashTag'),
    ).toBeNull()
  })
})
