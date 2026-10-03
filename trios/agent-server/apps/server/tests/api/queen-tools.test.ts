import { describe, expect, it } from 'bun:test'
import {
  briefFor,
  parseVerdictBlock,
  parseVerdictMissingTools,
  workerSystemPrompt,
} from '../../src/api/services/queen-tick'
import {
  indexFromCatalog,
  loadToolIndex,
  PURPOSE_MAX_CHARS,
  type ToolIndex,
  toolIndexSection,
  toolUse,
  toolUseSentence,
} from '../../src/api/services/queen-tools'

/**
 * Bees get an index of the tools that already exist, generated from the
 * site's tool catalog, and say `missing-tool: <what>` when the job they did
 * by hand will come up again. The Queen counts what each job used.
 */

const catalog = {
  contentSha256: 'abc',
  tools: [
    {
      id: 'trios-tri-anom',
      repo: 'gHashTag/BrowserOS',
      family: 'tri-cli',
      command: 'tri anom',
      fields: { WHEN_TO_USE: 'Read the anomaly list. More detail here.' },
    },
    {
      id: 'trios-tri-anomalies',
      repo: 'gHashTag/BrowserOS',
      family: 'tri-cli',
      command: 'tri anomalies',
      fields: { WHEN_TO_USE: 'Read the anomaly list. More detail here.' },
    },
    {
      id: 'trinity-tri-cast',
      repo: 'gHashTag/trinity',
      family: 'tri-cli',
      command: 'tri cast',
      fields: { ABOUT: 'Record a terminal \\u2014 and check it.' },
    },
    {
      id: 'off',
      repo: 'gHashTag/trinity',
      family: 'tri-cli',
      command: 'tri off',
      enabled: false,
      fields: { ABOUT: 'Disabled.' },
    },
    {
      id: 'elsewhere',
      repo: 'someone/else',
      family: 'tri-cli',
      command: 'x',
      fields: { ABOUT: 'Unknown program.' },
    },
    {
      id: 'needle',
      family: 'mcp',
      fields: { ABOUT: 'x'.repeat(200) },
    },
  ],
}

describe('indexFromCatalog builds one line per command', () => {
  const index = indexFromCatalog(catalog, 'f'.repeat(40))

  it('skips disabled cards and programs it does not know', () => {
    const names = index.tools.map((t) => t.name)
    expect(names).not.toContain('tri off')
    expect(names).not.toContain('x')
  })

  it('merges aliases that share a purpose and orders by program', () => {
    expect(index.tools.map((t) => [t.program, t.name])).toEqual([
      ['trios-tri', 'tri anom, tri anomalies'],
      ['trinity-tri', 'tri cast'],
      ['mcp', 'needle'],
    ])
    expect(Object.keys(index.programs)).toEqual([
      'trios-tri',
      'trinity-tri',
      'mcp',
    ])
  })

  it('keeps the first sentence, decodes escapes, cuts long purposes', () => {
    expect(index.tools[0]?.purpose).toBe('Read the anomaly list.')
    expect(index.tools[1]?.purpose).toBe('Record a terminal — and check it.')
    expect(index.tools[2]?.purpose.length).toBe(PURPOSE_MAX_CHARS)
    expect(index.tools[2]?.purpose.endsWith('...')).toBe(true)
  })

  it('records where it came from', () => {
    expect(index.source.commit).toBe('f'.repeat(40))
    expect(index.source.contentSha256).toBe('abc')
  })
})

describe('the brief section', () => {
  it('states the rule and lists the commands under their program', () => {
    const index = indexFromCatalog(catalog, '0123456789abcdef')
    const text = toolIndexSection(index).join('\n')
    expect(text).toContain('## Tools you already have')
    expect(text).toContain('missing-tool:')
    expect(text).toContain('at 0123456789ab (3 commands)')
    expect(text).toContain('- tri anom, tri anomalies - Read the anomaly list.')
  })

  it('still states the rule when no index shipped', () => {
    const text = toolIndexSection(null).join('\n')
    expect(text).toContain('## Tools you already have')
    expect(text).toContain('was not shipped')
  })

  it('reads the committed index, which carries no secret', () => {
    const index = loadToolIndex()
    expect(index).not.toBeNull()
    const raw = JSON.stringify(index)
    expect(raw).not.toMatch(
      /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_|PRIVATE KEY/,
    )
    expect(loadToolIndex('/nonexistent/index.json')).toBeNull()
  })
})

describe('the Queen counts what a job used', () => {
  const index: ToolIndex = indexFromCatalog(catalog, 'c'.repeat(40))

  it('counts calls per tool and the indexed commands run', () => {
    const use = toolUse(
      [
        'bash  tri cast check /workspace/casts/queen-1.cast',
        'bash  git status',
        'read  src/a.ts',
        'bash  cd x && tri anomalies --json',
      ],
      index,
    )
    expect(use.calls).toBe(4)
    expect(use.byTool).toEqual([
      ['bash', 3],
      ['read', 1],
    ])
    expect(use.indexed).toEqual(['tri cast', 'tri anomalies'])
  })

  it('matches by word, not by prefix', () => {
    expect(toolUse(['bash  tri castle'], index).indexed).toEqual([])
    expect(toolUse(null, index).calls).toBe(0)
  })

  it('says it in one sentence', () => {
    const use = toolUse(['bash  tri cast check a.cast'], index)
    expect(toolUseSentence(use, ['diff two casts'])).toBe(
      'Tools: 1 call(s) (bash 1); from the index: tri cast; missing-tool: diff two casts.',
    )
    expect(toolUseSentence(toolUse([], index), [])).toBe(
      'Tools: no tool call recorded; nothing from the index.',
    )
  })
})

describe('the verdict block carries missing-tool lines', () => {
  it('reads them without counting them as criteria or ending the block', () => {
    const said = [
      '## VERDICT',
      '- 1. A: met',
      'missing-tool: `diff two casts`',
      '- missing-tool: render a cast as text',
      '- 2. B: met',
    ].join('\n')
    expect(parseVerdictBlock(said)).toHaveLength(2)
    expect(parseVerdictMissingTools(said)).toEqual([
      'diff two casts',
      'render a cast as text',
    ])
  })

  it('keeps a criterion called missing-tool a criterion', () => {
    const said = '## VERDICT\n- missing-tool: met\n'
    expect(parseVerdictBlock(said)).toHaveLength(1)
    expect(parseVerdictMissingTools(said)).toEqual([])
  })
})

describe('the brief and the system prompt both carry the rule', () => {
  it('puts the index before Finishing and echoes the rule', () => {
    const brief = briefFor(
      12,
      'gHashTag/trios',
      ['agent-server/apps/server/src/api/services/queen-tools.ts'],
      '## Success Criteria\n- It indexes.\n',
      ['It indexes.'],
      'stated',
    )
    const at = brief.indexOf('## Tools you already have')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(brief.indexOf('## Finishing'))
    const prompt = workerSystemPrompt(12, 'gHashTag/trios', '/w', [])
    expect(prompt).toContain('missing-tool: <what>')
    expect(prompt).toContain('Tools you already have')
  })
})
