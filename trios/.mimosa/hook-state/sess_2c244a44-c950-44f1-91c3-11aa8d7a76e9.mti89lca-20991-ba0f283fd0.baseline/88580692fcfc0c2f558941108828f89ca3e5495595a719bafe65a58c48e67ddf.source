import { describe, expect, it } from 'bun:test'
import {
  extractCladoThinking,
  formatCladoHistory,
  getCladoActionSignature,
  parseCladoActions,
} from '../../src/agents/orchestrated/backends/clado/clado-actions'
import type { CladoActionResponse } from '../../src/agents/orchestrated/backends/clado/types'

describe('Clado action parsing', () => {
  it('merges the structured response with the first raw answer block', () => {
    const prediction: CladoActionResponse = {
      action: 'click',
      x: 800,
      raw_response:
        '<answer>{"action":"click","x":100,"y":200}</answer><answer>{"action":"press_key","key":"Enter"}</answer>',
    }

    expect(parseCladoActions(prediction)).toEqual([
      { action: 'click', x: 800, y: 200 },
      { action: 'press_key', key: 'Enter' },
    ])
  })

  it('returns no action for malformed or missing action payloads', () => {
    expect(
      parseCladoActions({
        action: null,
        raw_response: '<answer>{"x":100}</answer><answer>bad json</answer>',
      }),
    ).toEqual([])
  })

  it('deduplicates repeated raw actions after the primary action', () => {
    const prediction: CladoActionResponse = {
      raw_response: [
        '<answer>{"action":"click","x":100,"y":200}</answer>',
        '<answer>{"action":"click","x":100,"y":200}</answer>',
        '<answer>{"action":"type","text":"hello"}</answer>',
      ].join(''),
    }

    expect(parseCladoActions(prediction)).toEqual([
      { action: 'click', x: 100, y: 200 },
      { action: 'type', text: 'hello' },
    ])
  })

  it('extracts compact thinking text from raw model output', () => {
    expect(
      extractCladoThinking(
        '<thinking> first\\n thought </thinking><thinking>second thought</thinking>',
      ),
    ).toBe('first\\n thought second thought')
  })

  it('formats history and signatures using the existing trajectory shape', () => {
    const actions = [
      { action: 'click', x: 100, y: 200 },
      { action: 'type', text: "can't" },
      { action: 'scroll', direction: 'down', amount: 500 },
    ]

    expect(formatCladoHistory(actions)).toBe(
      "click(100, 200) -> type('can\\'t') -> scroll(down)",
    )
    expect(getCladoActionSignature(actions[0])).toBe('click:100:200')
  })
})
