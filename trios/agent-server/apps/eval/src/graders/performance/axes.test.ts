import { describe, expect, it } from 'bun:test'
import { DEFAULT_AXES, PERFORMANCE_SYSTEM_PROMPT, buildUserPrompt } from './axes'
import type { AxisDefinition, PreComputedMetrics } from './types'

// Coverage note for User Story 2: all 3 exported symbols
// (DEFAULT_AXES, PERFORMANCE_SYSTEM_PROMPT, buildUserPrompt) are pure data and
// pure functions with no live dependency, so every one of them is exercised
// below. No export was left out for lack of a database, container or network.

describe('axesContract', () => {
  it('DEFAULT_AXES defines a complete, uniquely named set of weighted scoring axes', () => {
    // A weighted score needs weights that add up to a whole.
    const totalWeight = DEFAULT_AXES.reduce((sum, axis) => sum + axis.weight, 0)
    expect(totalWeight).toBeCloseTo(1, 10)

    // Every axis must be usable as a weighted label: a name, a sane weight,
    // and a description a model can score against.
    for (const axis of DEFAULT_AXES) {
      expect(axis.name.length).toBeGreaterThan(0)
      expect(axis.weight).toBeGreaterThan(0)
      expect(axis.weight).toBeLessThanOrEqual(1)
      expect(axis.description.length).toBeGreaterThan(0)
    }

    // Axis names must not collide, or per-axis scores could not be told apart.
    const names = DEFAULT_AXES.map((axis) => axis.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('PERFORMANCE_SYSTEM_PROMPT is a substitutable template that calibrates every default axis', () => {
    // The prompt is a template: the screenshot count must be substitutable
    // everywhere it appears, leaving a coherent reference to the last image.
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('{screenshot_count}')
    const filled = PERFORMANCE_SYSTEM_PROMPT.replaceAll('{screenshot_count}', '7')
    expect(filled).not.toContain('{screenshot_count}')
    expect(filled).toContain('7.png')

    // The evaluator can only score axes it has anchors for: every default
    // axis name must appear in the prompt's scoring guidance.
    for (const axis of DEFAULT_AXES) {
      expect(PERFORMANCE_SYSTEM_PROMPT).toContain(axis.name)
    }

    // The prompt must describe the data files the user prompt advertises.
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('messages.jsonl')
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('screenshots/')
  })

  it('buildUserPrompt renders the task, answer, metrics, axes and optional ground truth', () => {
    const metrics: PreComputedMetrics = {
      totalDurationMs: 123456,
      totalToolCalls: 42,
      errorCount: 2,
      errorRate: 0.05,
      screenshotCount: 9,
      uniqueToolNames: ['browser_click_element'],
      stepCount: 12,
      terminationReason: 'end_turn',
    }
    const axes: AxisDefinition[] = [
      {
        name: 'custom_axis',
        weight: 0.5,
        description: 'A bespoke axis used only by this suite.',
      },
    ]

    // With an answer, ground truth and custom axes: everything the caller
    // supplied must reach the evaluator.
    const full = buildUserPrompt(
      'Find the cheapest flight to Reykjavik',
      'Cheapest is $312 on Wow Air',
      metrics,
      axes,
      '$312',
    )
    expect(full).toContain('Find the cheapest flight to Reykjavik')
    expect(full).toContain('Cheapest is $312 on Wow Air')
    expect(full).toContain('$312')
    expect(full).toContain('Expected Answer')
    expect(full).toContain('custom_axis')
    expect(full).toContain('0.5')
    expect(full).toContain('A bespoke axis used only by this suite.')
    // The axes argument drives the block, not a baked-in default list
    // ('error_recovery' is a default axis and appears nowhere else).
    expect(full).not.toContain('error_recovery')
    // The screenshot count must flow into both the count and the file range.
    expect(full).toContain('9 screenshots')
    expect(full).toContain('1.png to 9.png')
    // Scalar metrics must be visible to the evaluator.
    expect(full).toContain('42')

    // Without an answer: the evaluator is told there is none.
    const noAnswer = buildUserPrompt('task', null, metrics, axes)
    expect(noAnswer).toContain('[No answer provided]')
    const blankAnswer = buildUserPrompt('task', '', metrics, axes)
    expect(blankAnswer).toContain('[No answer provided]')

    // Without ground truth: no expected-answer section may be invented.
    const noTruth = buildUserPrompt('task', 'an answer', metrics, DEFAULT_AXES)
    expect(noTruth).not.toContain('Expected Answer')
    // And the default axes reach the prompt when they are what was passed.
    expect(noTruth).toContain('task_completion')
  })
})
