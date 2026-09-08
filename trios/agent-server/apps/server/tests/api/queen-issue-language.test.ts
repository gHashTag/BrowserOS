import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGhArgs,
  createQueenIssue,
  type GhInvocation,
  type GhRunner,
  main,
  parseCliArgs,
  usageText,
} from '../../../../scripts/queen-issue-create'
import {
  containsCyrillic,
  ENGLISH_ONLY_RULE,
  validateIssueLanguage,
} from '../../src/api/services/queen-issue-language'

/**
 * One rule, tested from two ends.
 *
 * The fixtures below are the six the issue names - plain English, Markdown
 * with paths, a mixed-Cyrillic title, a Cyrillic body, an empty title, and an
 * injected fake `gh` - plus the process-level checks that turn "the wrapper
 * validates first" from a claim into an observation.
 *
 * The Russian strings here are fixtures, not copy: they are the negatives the
 * policy exists to refuse. The product's own RU/EN dashboard resources are
 * never inputs to this policy and never appear in these tests, which is the
 * third user story in executable form: a task ABOUT localisation is judged by
 * the language it is written in, and nothing else is judged at all.
 */
describe('queen-issue-language: the pure validator', () => {
  it('accepts an ordinary English task', () => {
    const verdict = validateIssueLanguage(
      'Refuse Russian tasks before they reach GitHub',
      'Create the validator, the wrapper, and a pre-commit gate. Keep it small.',
    )
    expect(verdict.ok).toBe(true)
  })

  it('accepts Markdown, paths, commands, and identifiers', () => {
    const body = [
      '## Summary',
      'Rewrite the `task-queue` loop in `agent-server/apps/server/src/api/services/task-queue-service.ts`.',
      '',
      '## Steps',
      '1. Run `bun test apps/server/tests/api/queen-dispatch.test.ts` from `agent-server`.',
      '2. Relative paths like `../../scripts/queen-issue-create.ts` must survive.',
      '3. Identifiers: snake_case, PascalCase, kebab-case, UPPER_SNAKE.',
      '4. Links: https://github.com/gHashTag/trios/issues and gHashTag/trios#1291.',
      '5. Light diacritics and symbols stay fine: cafe, naivete, 3 * 4 = 12.',
    ].join('\n')
    const verdict = validateIssueLanguage(
      'feat(queue): shard the task-queue loop by repo',
      body,
    )
    expect(verdict.ok).toBe(true)
  })

  it('refuses a mixed English/Cyrillic title', () => {
    const verdict = validateIssueLanguage(
      'Fix queen dispatch: очередь переполняется при ретраях',
      'The dispatch loop retries three times before the queue drains.',
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.field).toBe('title')
      expect(verdict.reason).toBe(ENGLISH_ONLY_RULE)
    }
  })

  it('refuses a Cyrillic body under an English title', () => {
    const verdict = validateIssueLanguage(
      'Add a language gate for new tasks',
      'Задача не воспроизводится на стендe. Шаги: запустить, проверить.',
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.field).toBe('body')
      expect(verdict.reason).toBe(ENGLISH_ONLY_RULE)
    }
  })

  it('refuses an empty title', () => {
    expect(validateIssueLanguage('', 'An empty title is not a task.').ok).toBe(
      false,
    )
    // Whitespace is still empty; trimming is part of the contract.
    const verdict = validateIssueLanguage('   \t\n', 'body')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.field).toBe('title')
    }
  })

  it('allows an empty body but still type-checks it', () => {
    expect(validateIssueLanguage('Valid title', '').ok).toBe(true)
    const verdict = validateIssueLanguage('Valid title', undefined)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.field).toBe('body')
    }
  })

  it('catches Cyrillic in every block, including inherited combining marks', () => {
    // U+0410 capital A; U+0451 io; U+0500 supplement; U+1C80 extended-C;
    // U+2DE0 extended-A; U+A640 extended-B; U+0488 combining mark whose
    // script is Inherited, not Cyrillic - the reason the regex pairs the
    // script property with explicit ranges.
    for (const sample of [
      '\u0410',
      '\u0451',
      '\u0500',
      '\u1C80',
      '\u2DE0',
      '\uA640',
      'a\u0488',
      'queue \u043E\u0432\u0435\u0440\u0444\u043B\u043E\u0443',
    ]) {
      expect(containsCyrillic(sample)).toBe(true)
    }
    // The gate is about one script, not about taste: Latin diacritics, Greek,
    // and emoji all pass. If the day comes to widen the policy, this test is
    // the line that moves - deliberately, in the open.
    for (const innocent of [
      'plain',
      'Café',
      'naïve',
      '\u03B1\u03B2\u03B3',
      '\u{1F44D}',
    ]) {
      expect(containsCyrillic(innocent)).toBe(false)
    }
  })

  it('never echoes the submitted text, secrets included, in a refusal', () => {
    const secret = 'ghp_thisIsAFakeTokenForAssertions'
    const verdict = validateIssueLanguage(
      'English title about credentials',
      `Секретный токен: ${secret}`,
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).not.toContain(secret)
      expect(verdict.reason).not.toContain(
        '\u0421\u0435\u043A\u0440\u0435\u0442',
      )
    }
  })

  it('judges a task by its own language, not its topic', () => {
    // A task about the bilingual product is a normal English task. The RU/EN
    // dashboard resources themselves are not inputs to this policy; only the
    // text of the issue being created is.
    const verdict = validateIssueLanguage(
      'chore(i18n): keep the RU/EN dashboard resources in sync',
      'The Queen UI stays bilingual in Russian and English. Verify that the localisation tables and their existing UI checks still pass; the English-only rule applies to newly created task issues only.',
    )
    expect(verdict.ok).toBe(true)
  })
})

describe('queen-issue-create: the wrapper validates before GitHub', () => {
  /** A fake `gh` that records every invocation and always succeeds. */
  function fakeGh(): { runner: GhRunner; invocations: GhInvocation[] } {
    const invocations: GhInvocation[] = []
    return {
      invocations,
      runner: (invocation) => {
        invocations.push(invocation)
        return {
          status: 0,
          stdout: 'https://github.com/gHashTag/trios/issues/1292\n',
          stderr: '',
        }
      },
    }
  }

  it('records exactly 0 invocations of the fake gh when the task is refused', () => {
    const gh = fakeGh()
    const outcome = createQueenIssue(
      {
        title: 'Add rerun button to the board',
        body: 'Добавить кнопку перезапуска на доску задач.',
      },
      { gh: gh.runner },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.refused).toBe(true)
      expect(outcome.field).toBe('body')
    }
    // The number this file exists to pin. Refusal happens before any GitHub
    // command is built, spawned, or invoked.
    expect(gh.invocations.length).toBe(0)
  })

  it('invokes the fake gh exactly once, with the content unchanged', () => {
    const gh = fakeGh()
    const title = 'feat(queue): add the English-only preflight'
    const body =
      'Markdown, `paths/like/this.ts`, and `bun test` commands all pass through untouched.'
    const outcome = createQueenIssue(
      {
        title,
        body,
        repo: 'gHashTag/trios',
        labels: ['queen', 'task'],
        assignee: 'bee-1291',
      },
      { gh: gh.runner },
    )
    expect(outcome.ok).toBe(true)
    expect(gh.invocations.length).toBe(1)
    expect(gh.invocations[0].command).toBe('gh')
    expect(gh.invocations[0].args).toEqual([
      'issue',
      'create',
      '--title',
      title,
      '--body',
      body,
      '--repo',
      'gHashTag/trios',
      '--label',
      'queen',
      '--label',
      'task',
      '--assignee',
      'bee-1291',
    ])
  })

  it('reports a GitHub-side failure as its own outcome', () => {
    const failing: GhRunner = () => ({
      status: 128,
      stdout: '',
      stderr: 'gh: authentication failed',
    })
    const outcome = createQueenIssue(
      { title: 'Fine title', body: 'Fine body' },
      { gh: failing },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.refused).toBe(false)
    }
  })

  it('builds gh arguments without any rewriting of the content', () => {
    const title = 'It keeps "quotes", $hell, and | pipes; verbatim'
    const body = 'body --not-a-flag\nsecond line'
    expect(buildGhArgs({ title, body })).toEqual([
      'issue',
      'create',
      '--title',
      title,
      '--body',
      body,
    ])
  })
})

describe('queen-issue-create: the command line', () => {
  const script = join(
    import.meta.dir,
    '../../../../scripts/queen-issue-create.ts',
  )

  it('parses flags, defaults, and rejects misuse deterministically', () => {
    const ok = parseCliArgs([
      '--title',
      'T',
      '--body',
      'B',
      '--label',
      'a',
      '--label',
      'b',
    ])
    expect(ok).toEqual({
      kind: 'request',
      request: { title: 'T', body: 'B', labels: ['a', 'b'] },
    })

    const inline = parseCliArgs(['--title=T'])
    expect(inline).toEqual({
      kind: 'request',
      request: { title: 'T', body: '' },
    })

    expect(
      parseCliArgs(['--title', 'T', '--body', 'B', '--body-file', 'f.txt'])
        .kind,
    ).toBe('error')
    expect(parseCliArgs(['--title']).kind).toBe('error')
    expect(parseCliArgs([]).kind).toBe('error')
    expect(parseCliArgs(['--wat']).kind).toBe('error')
    expect(parseCliArgs(['--help']).kind).toBe('help')
    expect(parseCliArgs(['-h']).kind).toBe('help')

    const bodyFile = parseCliArgs(['--title', 'T', '--body-file', 'task.md'])
    expect(bodyFile).toEqual({
      kind: 'request',
      request: { title: 'T', body: '' },
      bodyFile: 'task.md',
    })
  })

  it('exits 0 from --help and documents the English-only rule', () => {
    expect(usageText()).toContain('English only')
    expect(usageText()).toContain('Cyrillic')
    const run = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('English only')
    expect(run.stdout).toContain('Cyrillic')
  })

  /** A stand-in `gh` binary that logs each invocation and fakes success. */
  function installFakeGh(dir: string, logPath: string): void {
    const shim = [
      '#!/bin/sh',
      'printf "invoked\\n" >> "$GH_FAKE_LOG"',
      'printf "https://github.com/gHashTag/trios/issues/9999\\n"',
      'exit 0',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'gh'), shim, { mode: 0o755 })
    chmodSync(join(dir, 'gh'), 0o755)
    void logPath
  }

  it('exits non-zero with 0 gh invocations when the CLI is fed a Russian task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queen-issue-create-'))
    const log = join(dir, 'invocations.log')
    installFakeGh(dir, log)
    try {
      const run = spawnSync(
        process.execPath,
        [
          script,
          '--title',
          'Проверка обёртки',
          '--body',
          'The wrapper must refuse this before gh runs.',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            GH_FAKE_LOG: log,
          },
        },
      )
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('English only')
      // The refusal names the rule but never the submitted text.
      expect(run.stderr).not.toContain('Проверка')
      // No invocation happened: the log file was never created.
      expect(existsSync(log)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 and prints the issue URL when the CLI is fed an English task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queen-issue-create-'))
    const log = join(dir, 'invocations.log')
    installFakeGh(dir, log)
    try {
      const run = spawnSync(
        process.execPath,
        [
          script,
          '--title',
          'English task through the wrapper',
          '--body',
          'It should pass.',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            GH_FAKE_LOG: log,
          },
        },
      )
      expect(run.status).toBe(0)
      expect(run.stdout).toContain(
        'https://github.com/gHashTag/trios/issues/9999',
      )
      expect(existsSync(log)).toBe(true)
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['invoked'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns distinct exit codes for usage errors and refusals', () => {
    expect(main(['--title', 'T', '--body', 'B', '--wat'])).not.toBe(0)
    expect(main(['--title', 'T', '--body', 'B', '--wat'])).not.toBe(1)
    expect(main(['--title', 'Т', '--body', 'B'])).toBe(1)
    const noop: GhRunner = () => ({ status: 0, stdout: 'url\n', stderr: '' })
    expect(main(['--title', 'T', '--body', 'B'], noop)).toBe(0)
  })
})
