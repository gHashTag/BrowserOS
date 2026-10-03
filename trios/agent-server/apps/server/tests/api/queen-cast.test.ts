import { afterAll, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CastReport,
  castPathFor,
  castSentence,
  castStatus,
  checkCast,
  parseCast,
  readBeeCast,
  recordCast,
  secretValues,
  serializeCast,
} from '../../src/api/services/queen-cast'
import {
  briefFor,
  parseVerdictBlock,
  parseVerdictCast,
  workerSystemPrompt,
} from '../../src/api/services/queen-tick'

/**
 * Every bee job ends with a terminal recording of the commands that prove it
 * (`tri cast` format: asciicast v2 with an `x` event carrying each command's
 * exit code). The recorder runs in the bee's container; the review reads the
 * file back and SAYS what it found - a warning, never a send-back.
 *
 * The rules mirror `tri cast check` (termgif.py) so a bee's cast passes on
 * the owner's Mac exactly when it passes here: exit codes present and all 0,
 * no home path, no secret.
 */

const dir = mkdtempSync(join(tmpdir(), 'queen-cast-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A fixed clock, so a recording made in a test is reproducible. */
function clock(): () => number {
  let t = 0
  return () => {
    t += 0.01
    return t
  }
}

describe('recordCast writes a cast tri cast check accepts', () => {
  it('records output, one exit code per command, and passes the check', async () => {
    const path = join(dir, 'pass', 'queen-1.cast')
    const env = { ...process.env, HOME: '/home/nobody-here' }
    const result = await recordCast(path, ['echo hello', 'echo oops >&2'], {
      title: 'pass',
      cwd: dir,
      env,
      now: clock(),
    })
    expect(result.codes).toEqual(['0', '0'])
    const text = readFileSync(path, 'utf8')
    const parsed = parseCast(text)
    expect(parsed?.header.version).toBe(2)
    expect(parsed?.header.width).toBe(104)
    expect(parsed?.header.commands).toEqual(['echo hello', 'echo oops >&2'])
    const output = parsed?.events
      .filter((e) => e[1] === 'o')
      .map((e) => e[2])
      .join('')
    expect(output).toContain('hello\r\n')
    // stderr is merged into the same stream, as a terminal would show it.
    expect(output).toContain('oops\r\n')
    const check = checkCast(text, { homes: ['/home/nobody-here'] })
    expect(check.ok).toBe(true)
    expect(check.problems).toEqual([])
  })

  it('records a failing command as a non-zero exit, and the check fails', async () => {
    const path = join(dir, 'fail.cast')
    const result = await recordCast(path, ['true', 'exit 3'], {
      cwd: dir,
      now: clock(),
    })
    expect(result.codes).toEqual(['0', '3'])
    const check = checkCast(readFileSync(path, 'utf8'))
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toContain('exit codes')
  })

  it('scrubs the home directory to ~ in output and in the header', async () => {
    const home = join(dir, 'home-of-bee')
    const path = join(dir, 'home.cast')
    await recordCast(path, [`echo ${home}/work`], {
      cwd: dir,
      env: { ...process.env, HOME: home },
      now: clock(),
    })
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(home)
    expect(text).toContain('~/work')
    expect(checkCast(text, { homes: [home] }).homeHits).toBe(0)
  })

  it('stops a command at the timeout with exit code 124', async () => {
    const path = join(dir, 'timeout.cast')
    const result = await recordCast(path, ['sleep 5'], {
      cwd: dir,
      timeoutS: 0.3,
      now: clock(),
    })
    expect(result.codes).toEqual(['124'])
  })
})

/** A minimal cast, built by hand, for the check's failure cases. */
function cast(
  output: string,
  codes: string[],
  timestamp = 1_800_000_000,
): string {
  const events: [number, string, string][] = [[0.1, 'o', output]]
  for (const code of codes) events.push([0.2, 'x', code])
  return serializeCast(
    {
      version: 2,
      width: 104,
      height: 30,
      timestamp,
      title: 't',
      commands: codes.map((_, i) => `cmd ${i}`),
      redacted: ['home directory shown as ~'],
    },
    events,
  )
}

describe('checkCast says what is wrong', () => {
  it('rejects text that is not a recording', () => {
    const check = checkCast('not json at all\n')
    expect(check.ok).toBe(false)
    expect(check.problems).toEqual(['not an asciicast v2 recording'])
  })

  it('rejects a recording with no exit codes', () => {
    const check = checkCast(cast('hi\r\n', []))
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toContain('no exit codes')
  })

  it('counts a home path that was not scrubbed', () => {
    const check = checkCast(cast('/home/bee/x and /home/bee/y\r\n', ['0']), {
      homes: ['/home/bee'],
    })
    expect(check.ok).toBe(false)
    expect(check.homeHits).toBe(2)
  })

  it('finds a token by its shape and a secret by its value', () => {
    const token = `ghp_${'a'.repeat(36)}`
    expect(checkCast(cast(`${token}\r\n`, ['0'])).secretHits).toBe(1)
    const secrets = secretValues({
      GITHUB_TOKEN: 'abcdefghijklmnop',
      PATH: '/usr/bin:/bin:/usr/local/bin',
      SHORT_KEY: 'tiny',
    })
    expect(secrets).toEqual(['abcdefghijklmnop'])
    const check = checkCast(cast('value=abcdefghijklmnop\r\n', ['0']), {
      secrets,
    })
    expect(check.ok).toBe(false)
    expect(check.secretHits).toBe(1)
  })

  it('reads a recording older than the dispatch as an earlier attempt', () => {
    const check = checkCast(cast('ok\r\n', ['0'], 1_000), { notBefore: 2_000 })
    expect(check.ok).toBe(false)
    expect(check.problems.join(' ')).toContain('before this attempt')
  })
})

describe('the review reads the cast and warns', () => {
  it('keeps the cast on the workspace volume, outside every worktree', () => {
    expect(castPathFor(7, { WORKSPACE_DIR: '/data/ws' })).toBe(
      '/data/ws/casts/queen-7.cast',
    )
    expect(castPathFor(7, {})).toBe('/workspace/casts/queen-7.cast')
  })

  it('reports a missing cast, never throwing', () => {
    const report = readBeeCast(99, null, { WORKSPACE_DIR: join(dir, 'none') })
    expect(report.kind).toBe('missing')
    expect(castStatus(report)).toBe('missing')
    expect(castSentence(report, null)).toContain('no recording')
    expect(castSentence(report, '/x.cast')).toContain('named /x.cast')
  })

  it('reads a clean cast as ok, and a stale one as fail', () => {
    const ws = join(dir, 'ws')
    const path = castPathFor(5, { WORKSPACE_DIR: ws })
    rmSync(join(ws, 'casts'), { recursive: true, force: true })
    mkdirSync(join(ws, 'casts'), { recursive: true })
    writeFileSync(path, cast('ok\r\n', ['0', '0'], 1_800_000_000))
    const env = { WORKSPACE_DIR: ws }
    const fresh = readBeeCast(5, new Date(1_799_999_000 * 1000), env)
    expect(castStatus(fresh)).toBe('ok')
    expect(castSentence(fresh, path)).toBe(
      `Cast: ${path} records 2 command(s), all exited 0, home scrubbed, no secret found.`,
    )
    const stale = readBeeCast(5, '2027-06-01T00:00:00Z', env)
    expect(castStatus(stale)).toBe('fail')
    expect(castSentence(stale, null)).toContain('before this attempt')
  })

  it('says when the bee named a different path from the one read', () => {
    const report: CastReport = {
      kind: 'checked',
      path: '/workspace/casts/queen-1.cast',
      check: checkCast(cast('ok\r\n', ['0'])),
    }
    expect(castSentence(report, '/tmp/mine.cast')).toContain(
      'the verdict names /tmp/mine.cast',
    )
  })
})

describe('the verdict block carries a cast line', () => {
  const said = [
    'Done.',
    '',
    '## VERDICT',
    '- 1. The parser reads it: met',
    '- 2. The test passes: met',
    'cast: /workspace/casts/queen-12.cast',
  ].join('\n')

  it('reads the cast path from the block', () => {
    expect(parseVerdictCast(said)).toBe('/workspace/casts/queen-12.cast')
    expect(parseVerdictCast('## VERDICT\n- 1. x: met\n')).toBeNull()
  })

  it('does not count the cast line as a criterion, nor stop at it', () => {
    const withCastFirst = [
      '## VERDICT',
      '- 1. A: met',
      '- cast: `/workspace/casts/queen-12.cast`',
      '- 2. B: unmet',
    ].join('\n')
    expect(parseVerdictBlock(said)).toHaveLength(2)
    expect(parseVerdictBlock(withCastFirst)).toHaveLength(2)
    expect(parseVerdictCast(withCastFirst)).toBe(
      '/workspace/casts/queen-12.cast',
    )
  })

  it('keeps a criterion literally called cast a criterion', () => {
    const lines = parseVerdictBlock('## VERDICT\n- cast: met\n')
    expect(lines).toHaveLength(1)
    expect(parseVerdictCast('## VERDICT\n- cast: met\n')).toBeNull()
  })
})

describe('the brief and the system prompt both ask for the cast', () => {
  const brief = briefFor(
    12,
    'gHashTag/trios',
    ['agent-server/apps/server/src/api/services/queen-cast.ts'],
    '## Success Criteria\n- It records.\n',
    ['It records.'],
    'stated',
  )
  const path = castPathFor(12)

  it('tells the bee to record as the last step and where', () => {
    expect(brief).toContain('## Recording your work')
    expect(brief).toContain(`record ${path} --`)
  })

  it('puts the cast line in the VERDICT template', () => {
    const verdict = brief.slice(brief.lastIndexOf('## VERDICT'))
    expect(verdict).toContain(`cast: ${path}`)
  })

  it('echoes the rule in the system prompt', () => {
    const prompt = workerSystemPrompt(12, 'gHashTag/trios', '/w', [])
    expect(prompt).toContain(`cast: ${path}`)
    expect(prompt).toContain('the review checks that recording')
  })
})
