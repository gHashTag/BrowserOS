import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Pool } from 'pg'
import {
  type CriterionRun,
  commandSafety,
  criteriaWitness,
  isSafeCommand,
  measureCriteria,
  measurementLines,
  normaliseCriterionCommand,
  parseCriterionChecks,
  runCriterionChecks,
} from '../../src/api/services/queen-criteria-run'
import type { WorkerProvider } from '../../src/api/services/queen-dispatch'
import {
  citesMeasurement,
  forgetReviewerLaneFailures,
  judgeReviewerText,
  type ReviewDeps,
  reviewerMessage,
} from '../../src/api/services/queen-reviewer'
import { reviewFinishedDispatches } from '../../src/api/services/queen-tick'
import { queendPathEnvVar, resolveQueendPath } from '../__helpers__/queend-path'

/**
 * The Queen runs an issue's own acceptance commands on the bee's commit.
 *
 * WHAT WAS MEASURED. In gHashTag/t27 nearly every criterion is a command and
 * the output it must print, and the adversarial reviewer has no tools: for
 * those it could only answer could-not-check, and a review that refuted
 * nothing escalated correct work to a person. These cases pin the parser
 * against the literal lines of six live issues, the filter against injection,
 * the runner against the count-after-a-failed-compiler hole, the measurement
 * against the bee's uncommitted leftovers, and the sweep's use of the result.
 *
 * WHAT IS REAL. bash, grep and git are real; `t27c` is the real compiler when
 * one is on PATH (`it.if(T27C)`), otherwise a fake script where the case says
 * so; `queend` is the real policy binary when built. The model and the
 * sweep's git are injected, as in queen-adversarial-review.
 */

const BIN = resolveQueendPath()
const QUEEND_ENV = queendPathEnvVar()
const present = existsSync(BIN)
const T27C = spawnSync('t27c', ['--version']).status === 0
const T27_MASTER = '/Users/playom/queen-patches/work/t27-master'

/**
 * The "## Acceptance criteria" sections of six gHashTag/t27 issues, as
 * `gh issue view <n> --repo gHashTag/t27 --json body -q .body` printed them on
 * 2026-09-17. Copied verbatim except one em dash in #4246 written as "--" to
 * keep this file ASCII.
 */
const ISSUE_SECTIONS: Record<number, string> = {
  4251: String.raw`
- 1. @t27c spec-status specs/tri/graph/prims_mst.t27@ prints @IMPLEMENTED@ (today: UNWRITTEN)
- 2. @t27c gen specs/tri/graph/prims_mst.t27 > /tmp/t27-gen.zig && grep -c 'not yet implemented' /tmp/t27-gen.zig@ prints @0@ (today: 1)
- 3. the name above still exists: @grep -cE '^[[:space:]]*(pub(\([^)]*\))?[[:space:]]+)?(extern[[:space:]]+)?fn[[:space:]]+(mst)[[:space:]]*[(<]' specs/tri/graph/prims_mst.t27@ prints @1@
- 4. @grep -cE '^[[:space:]]*test[[:space:]]+("|[A-Za-z_])' specs/tri/graph/prims_mst.t27@ prints at least @2@ (today: 1)
`,
  4259: String.raw`
- 1. @t27c gen specs/ml/transformer/feed_forward.t27 > /tmp/t27-gen.zig && grep -c 'not yet implemented' /tmp/t27-gen.zig@ prints @2@ (on arrival: 10)
- 2. @t27c spec-status specs/ml/transformer/feed_forward.t27@ does not print @NOPARSE@ - the file still parses
- 3. all 8 names above still exist: @grep -cE '^[[:space:]]*(pub(\([^)]*\))?[[:space:]]+)?(extern[[:space:]]+)?fn[[:space:]]+(init|get_intermediate_size|forward|backward|update|apply_activation|activation_backward|dropout)[[:space:]]*[(<]' specs/ml/transformer/feed_forward.t27@ prints @8@
`,
  4246: String.raw`
- 1. @grep -cE '^[[:space:]]*test[[:space:]]+("|[A-Za-z_])' specs/ternary/clocked_counter.t27@ prints at least @1@ (today: 0)
- 1b. @t27c gen specs/ternary/clocked_counter.t27 > /tmp/t27-gen.zig && grep -cE '^test "' /tmp/t27-gen.zig@ prints at least @1@ (today: 0) - the test must reach the generated Zig, not only the source
- 2. @python3 tools/check_assertionless_spec_tests.py@ prints a line beginning @ok:@ -- no file gained a test that cannot fail
- 3. all 1 function name(s) above still exist: @grep -cE '^[[:space:]]*(pub )?fn (on_clock)\(' specs/ternary/clocked_counter.t27@ prints @1@
`,
  3939: String.raw`
- 1. @/Users/playom/t27/target/release/t27c gen specs/vm/jit_semantics.t27 2>&1 | grep -c 'not yet implemented'@ prints @0@ (on arrival: 4)
- 2. with criterion 1 satisfied, @/Users/playom/t27/target/release/t27c parse specs/vm/jit_semantics.t27 2>&1 | grep -E '^(recovery-events|declarations-swallowed|lexer-discarded-chars):'@ reports 0, 0 and 0
- 3. with criterion 1 satisfied, all 4 names above still exist: @grep -cE '^\s*(pub )?fn (getOrCompile|jitBind|jitBundle|jitDotProduct)\(' specs/vm/jit_semantics.t27@ prints @4@
`,
  3974: String.raw`
- 1. @test -f specs/port/tools/jtag/read_user1.t27 && echo present@ prints @present@ (today the file does not exist)
- 2. @grep -cE '^\s*(pub )?fn (shift_ir|user1)\(' specs/port/tools/jtag/read_user1.t27@ prints @2@ - every function above is ported under its own name
- 3. @./target/release/t27c gen specs/port/tools/jtag/read_user1.t27 2>&1 | grep -c 'not yet implemented'@ prints @0@, and @./target/release/t27c gen specs/port/tools/jtag/read_user1.t27 | wc -l@ prints more than @10@ - an absent or empty file makes the grep print @0@ on its own, so both halves are required
- 4. with criterion 3 satisfied, @./target/release/t27c parse specs/port/tools/jtag/read_user1.t27 2>&1 | grep -E '^(recovery-events|declarations-swallowed|lexer-discarded-chars):'@ reports 0, 0 and 0
- 5. @grep -c '^\s*test "' specs/port/tools/jtag/read_user1.t27@ prints at least @2@
`,
  3880: String.raw`
- 1. @/Users/playom/t27/target/release/t27c gen specs/compiler/typechecker.t27 2>&1 | grep -c 'not yet implemented'@ prints @0@ (today: 1)
- 2. with criterion 1 satisfied, @/Users/playom/t27/target/release/t27c parse specs/compiler/typechecker.t27 2>&1 | grep -E '^(recovery-events|declarations-swallowed|lexer-discarded-chars):'@ reports 0, 0 and 0
- 3. with criterion 1 satisfied, all 1 name above still exist: @grep -cE '^\s*(pub )?fn (typecheck_module)\(' specs/compiler/typechecker.t27@ prints @1@
- 4. @grep -c '^\s*test "' specs/compiler/typechecker.t27@ prints at least @1@ (today: 0)
`,
}

/**
 * A section as `QueenSpecQuality.bullets` stores it on the dispatch row: one
 * item per "- " line, with the dash removed. `@` stands for a backtick, which
 * a String.raw template cannot hold.
 */
function storedCriteria(issue: number): string[] {
  return ISSUE_SECTIONS[issue]
    .replaceAll('@', '`')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
}

describe('criteria become checks', () => {
  it('reads the literal lines the swarm writes', () => {
    expect(
      parseCriterionChecks(
        '1. `t27c spec-status specs/tri/graph/prims_mst.t27` prints `IMPLEMENTED` (today: UNWRITTEN)',
      ),
    ).toEqual([
      {
        cmd: 't27c spec-status specs/tri/graph/prims_mst.t27',
        op: 'equals',
        expected: 'IMPLEMENTED',
      },
    ])
    expect(
      parseCriterionChecks(
        "2. `t27c gen specs/tri/graph/prims_mst.t27 > /tmp/t27-gen.zig && grep -c 'not yet implemented' /tmp/t27-gen.zig` prints `0` (today: 1)",
      ),
    ).toEqual([
      {
        cmd: "t27c gen specs/tri/graph/prims_mst.t27 > /tmp/t27-gen.zig && grep -c 'not yet implemented' /tmp/t27-gen.zig",
        op: 'equals',
        expected: '0',
      },
    ])
    expect(
      parseCriterionChecks(
        "4. `grep -cE '^[[:space:]]*test[[:space:]]+(\"|[A-Za-z_])' specs/tri/graph/prims_mst.t27` prints at least `2` (today: 1)",
      ),
    ).toEqual([
      {
        cmd: "grep -cE '^[[:space:]]*test[[:space:]]+(\"|[A-Za-z_])' specs/tri/graph/prims_mst.t27",
        op: 'atLeast',
        expected: '2',
      },
    ])
    expect(
      parseCriterionChecks(
        '2. `t27c spec-status specs/depin/prove.t27` does not print `NOPARSE` - the file still parses',
      ),
    ).toEqual([
      {
        cmd: 't27c spec-status specs/depin/prove.t27',
        op: 'notContains',
        expected: 'NOPARSE',
      },
    ])
    expect(
      parseCriterionChecks(
        '1. `test -f specs/port/tools/x.t27 && echo present` prints `present` (today the file does not exist)',
      ),
    ).toEqual([
      {
        cmd: 'test -f specs/port/tools/x.t27 && echo present',
        op: 'equals',
        expected: 'present',
      },
    ])
  })

  it('reads every mechanical criterion of six live issues, and only those', () => {
    const counts = Object.fromEntries(
      Object.keys(ISSUE_SECTIONS).map((n) => [
        n,
        storedCriteria(Number(n)).map((c) => parseCriterionChecks(c).length),
      ]),
    )
    expect(counts).toEqual({
      '3880': [1, 0, 1, 1],
      '3939': [1, 0, 1],
      '3974': [1, 1, 2, 0, 1],
      '4246': [1, 1, 0, 1],
      '4251': [1, 1, 1, 1],
      '4259': [1, 1, 1],
    })
    // "prints more than `10`" is at least 11, and the laptop binary is t27c.
    const [grepHalf, wcHalf] = parseCriterionChecks(storedCriteria(3974)[2])
    expect(grepHalf).toEqual({
      cmd: "t27c gen specs/port/tools/jtag/read_user1.t27 2>&1 | grep -c 'not yet implemented'",
      op: 'equals',
      expected: '0',
    })
    expect(wcHalf).toEqual({
      cmd: 't27c gen specs/port/tools/jtag/read_user1.t27 | wc -l',
      op: 'atLeast',
      expected: '11',
    })
    expect(parseCriterionChecks(storedCriteria(3880)[0])[0].cmd).toBe(
      "t27c gen specs/compiler/typechecker.t27 2>&1 | grep -c 'not yet implemented'",
    )
    // The prose backtick after the check is not a second command.
    expect(parseCriterionChecks(storedCriteria(3974)[2])).toHaveLength(2)
  })

  it('accepts every command those issues state', () => {
    const commands = Object.keys(ISSUE_SECTIONS).flatMap((n) =>
      storedCriteria(Number(n)).flatMap((c) =>
        parseCriterionChecks(c).map((check) => check.cmd),
      ),
    )
    expect(commands.length).toBe(20)
    for (const cmd of commands) {
      expect({ cmd, ...commandSafety(cmd), t27cCalls: undefined }).toEqual({
        cmd,
        safe: true,
        reason: '',
        t27cCalls: undefined,
      })
    }
  })

  it("rewrites the operator's laptop paths to the container's", () => {
    expect(
      normaliseCriterionCommand(
        'cd /Users/playom/t27 && /Users/playom/t27/target/release/t27c gen specs/a.t27',
      ),
    ).toBe('t27c gen specs/a.t27')
    expect(
      normaliseCriterionCommand(
        './target/release/t27c gen specs/a.t27 | ./target/release/t27c x',
      ),
    ).toBe('t27c gen specs/a.t27 | t27c x')
    // Any other cd stays, and is then refused by the filter.
    expect(normaliseCriterionCommand('cd /etc && cat passwd')).toBe(
      'cd /etc && cat passwd',
    )
    expect(isSafeCommand('cd /etc && cat passwd')).toBe(false)
  })

  it('yields nothing for a criterion with no command and output', () => {
    expect(
      parseCriterionChecks('A unit test covers the scroll handler'),
    ).toEqual([])
    expect(
      parseCriterionChecks(
        '2. `python3 tools/check.py` prints a line beginning `ok:` -- no file',
      ),
    ).toEqual([])
    expect(
      parseCriterionChecks('`t27c gen a.t27 | wc -l` prints at least `many`'),
    ).toEqual([])
  })
})

describe('the filter', () => {
  it.each([
    ['t27c gen specs/a.t27; rm -rf /'],
    ['t27c gen specs/a.t27 ; rm -rf .'],
    ['grep -c x $(cat specs/a.t27)'],
    ['grep -c "$(id)" specs/a.t27'],
    ['grep -c x `id`'],
    ['t27c gen specs/a.t27 > ~/.bashrc'],
    ['t27c gen specs/a.t27 > .bashrc'],
    ['cat ../../etc/passwd'],
    ['cat specs/../../../etc/passwd'],
    ['cat /etc/passwd'],
    ['env X=1 t27c gen specs/a.t27'],
    ['X=1 t27c gen specs/a.t27'],
    ['t27c gen specs/a.t27 || curl http://example.invalid'],
    ['curl http://example.invalid'],
    ['bash -c id'],
    ['grep -c x specs/a.t27 >> /tmp/t27-x'],
    ['grep -c x < specs/a.t27'],
    ['grep -c x specs/a.t27 1> /tmp/t27-x'],
    ['echo x > /tmp/t27-../../etc/x'],
    ['grep -c "$HOME" specs/a.t27'],
    ['grep -c x $HOME/specs'],
    ['t27c gen specs/a.t27 &'],
    ['grep -c x specs/a.t27\nrm -rf .'],
    ['grep -c x specs/*.t27'],
    ['grep -f/etc/passwd specs/a.t27'],
    ['grep --file=/etc/passwd specs/a.t27'],
    ['sort --compress-program=sh specs/a.t27'],
    ['wc --files0-from=list'],
    ['cat <(id)'],
    ['(cat specs/a.t27)'],
    ["grep -c 'unterminated specs/a.t27"],
    ['/usr/bin/grep -c x specs/a.t27'],
    ['grep -c x specs/a.t27 |'],
    [''],
  ])('refuses %p', (cmd) => {
    const verdict = commandSafety(cmd)
    expect(verdict.safe).toBe(false)
    expect(verdict.reason.length).toBeGreaterThan(0)
  })

  it('keeps single-quoted text literal and names the compiler calls', () => {
    const cmd =
      "t27c gen specs/a.t27 2>&1 | grep -c '$(not) `run`; || & < > ..' && t27c spec-status specs/b.t27"
    const verdict = commandSafety(cmd)
    expect(verdict.safe).toBe(true)
    expect(verdict.t27cCalls).toEqual([
      { sub: 'gen', file: 'specs/a.t27' },
      { sub: 'spec-status', file: 'specs/b.t27' },
    ])
  })

  it('never executes an unsafe command', async () => {
    const runs: string[][] = []
    const [check] = await runCriterionChecks(
      [
        {
          cmd: 'grep -c x specs/a.t27; touch pwned',
          op: 'equals',
          expected: '0',
        },
      ],
      {
        checkoutDir: tmpdir(),
        exec: async (request) => {
          runs.push(request.argv)
          return {
            code: 0,
            stdout: '0',
            stderr: '',
            timedOut: false,
            capped: false,
          }
        },
      },
    )
    expect(runs).toEqual([])
    expect(check.status).toBe('unrunnable')
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('unsafe command')
  })
})

describe('the runner', () => {
  const savedPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = savedPath
  })

  function checkoutWithFakeCompiler(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'queen-criteria-run-'))
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'checkout', 'specs'), { recursive: true })
    writeFileSync(join(dir, 'checkout', 'specs', 'a.t27'), 'fn a() {}\n')
    writeFileSync(join(dir, 'bin', 't27c'), `#!/bin/sh\n${script}\n`)
    chmodSync(join(dir, 'bin', 't27c'), 0o755)
    process.env.PATH = `${join(dir, 'bin')}:/usr/bin:/bin`
    return dir
  }

  /**
   * THE HOLE. #3939's own criterion: when generation FAILS, the pipeline
   * counts the stubs in an error message and prints 0 - exactly the output
   * that means "done".
   */
  it('fails a count behind a compiler that failed, whatever it printed', async () => {
    const dir = checkoutWithFakeCompiler(
      'echo "error: expected } at 1:10"; exit 1',
    )
    const check = {
      cmd: "t27c gen specs/a.t27 2>&1 | grep -c 'not yet implemented'",
      op: 'equals' as const,
      expected: '0',
    }
    const [run] = await runCriterionChecks([check], {
      checkoutDir: join(dir, 'checkout'),
    })
    // The pipeline really did print the passing answer...
    expect(run.output).toBe('0')
    // ...and the check still fails, naming the compiler call.
    expect(run.status).toBe('failed')
    expect(run.reason).toContain('t27c gen specs/a.t27 failed')

    // The same command over a compiler that succeeds passes.
    const good = checkoutWithFakeCompiler('echo "pub fn a() void {}"; exit 0')
    const [passing] = await runCriterionChecks([check], {
      checkoutDir: join(good, 'checkout'),
    })
    expect(passing.status).toBe('passed')
  })

  it('does not call a missing compiler a failure of the work', async () => {
    const dir = checkoutWithFakeCompiler('exit 0')
    process.env.PATH = '/usr/bin:/bin'
    const [run] = await runCriterionChecks(
      [
        {
          cmd: "t27c gen specs/a.t27 2>&1 | grep -c 'not yet implemented'",
          op: 'equals',
          expected: '0',
        },
        { cmd: 't27c spec-status specs/a.t27', op: 'equals', expected: 'X' },
      ],
      { checkoutDir: join(dir, 'checkout') },
    )
    expect(run.status).toBe('unrunnable')
  })

  it('compares as the criterion says, with the scratch prefix made private', async () => {
    const dir = checkoutWithFakeCompiler(
      'printf "a\\nnot yet implemented\\nb\\n"; exit 0',
    )
    const scratch = join(dir, 'scratch')
    mkdirSync(scratch)
    const runs = await runCriterionChecks(
      [
        {
          cmd: "t27c gen specs/a.t27 > /tmp/t27-gen.zig && grep -c 'not yet implemented' /tmp/t27-gen.zig",
          op: 'equals',
          expected: '1',
        },
        { cmd: 't27c gen specs/a.t27 | wc -l', op: 'atLeast', expected: '4' },
        { cmd: 't27c gen specs/a.t27', op: 'notContains', expected: 'NOPARSE' },
        {
          cmd: 't27c gen specs/a.t27',
          op: 'notContains',
          expected: 'not yet',
        },
      ],
      { checkoutDir: join(dir, 'checkout'), scratchDir: scratch },
    )
    expect(runs.map((r) => r.status)).toEqual([
      'passed',
      'failed',
      'passed',
      'failed',
    ])
    // Written where the runner pointed it, not to the shared /tmp.
    expect(existsSync(join(scratch, 't27-gen.zig'))).toBe(true)
  })

  it('stops at the command budget', async () => {
    const dir = checkoutWithFakeCompiler('exit 0')
    const check = { cmd: 'echo 1', op: 'equals' as const, expected: '1' }
    const runs = await runCriterionChecks([check, check, check], {
      checkoutDir: join(dir, 'checkout'),
      budget: { commandsLeft: 2, deadline: Date.now() + 60_000 },
    })
    expect(runs.map((r) => r.status)).toEqual([
      'passed',
      'passed',
      'unrunnable',
    ])
  })
})

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
  return out.stdout.trim()
}

/** A repository laid out like the volume, with a bee branch and worktree. */
function beeRepository(issue: number, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'queen-criteria-repo-'))
  git(root, 'init', '-q', '-b', 'master')
  git(root, 'config', 'user.email', 'queen@example.invalid')
  git(root, 'config', 'user.name', 'queen')
  mkdirSync(join(root, 'specs'), { recursive: true })
  writeFileSync(join(root, 'specs', 'a.t27'), 'fn a() {}\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'base')
  const baseSha = git(root, 'rev-parse', 'HEAD')
  git(
    root,
    'worktree',
    'add',
    '-q',
    '-b',
    `queen-${issue}`,
    `.worktrees/queen-${issue}`,
  )
  const tree = join(root, '.worktrees', `queen-${issue}`)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, file)), { recursive: true })
    writeFileSync(join(tree, file), content)
  }
  git(tree, 'add', '.')
  git(tree, 'commit', '-q', '-m', 'bee')
  const headSha = git(tree, 'rev-parse', 'HEAD')
  return { root, tree, baseSha, headSha }
}

describe('measurement runs on the commit', () => {
  it('passes on the branch commit, fails on base, and ignores uncommitted edits', async () => {
    const issue = 9101
    const { root, tree, baseSha, headSha } = beeRepository(issue, {
      'specs/a.t27': 'fn a() {}\ntest "a" {}\n',
    })
    // What a killed turn leaves behind in the bee's own worktree: a second
    // test and a new file, never committed. Measured in the worktree they
    // would change both answers.
    writeFileSync(
      join(tree, 'specs', 'a.t27'),
      'fn a() {}\ntest "a" {}\ntest "b" {}\n',
    )
    writeFileSync(join(tree, 'specs', 'uncommitted.t27'), 'fn u() {}\n')
    const criteria = [
      '1. `grep -c "^test " specs/a.t27` prints `1` (today: 0)',
      '2. `test -f specs/uncommitted.t27 && echo present` prints `present`',
      '3. A person reads the spec and likes it',
    ]
    const tmpRoot = mkdtempSync(join(tmpdir(), 'queen-criteria-tmp-'))

    const onHead = await measureCriteria(issue, headSha, criteria, {
      repoRoot: root,
      tmpRoot,
    })
    expect(onHead.ok).toBe(true)
    if (!onHead.ok) return
    expect(onHead.criteria.map((c) => c.number)).toEqual([1, 2])
    expect(onHead.criteria[0].checks[0].status).toBe('passed')
    expect(onHead.criteria[1].checks[0].status).toBe('failed')

    const onBase = await measureCriteria(issue, baseSha, criteria, {
      repoRoot: root,
      tmpRoot,
    })
    expect(onBase.ok).toBe(true)
    if (!onBase.ok) return
    expect(onBase.criteria[0].checks[0].status).toBe('failed')
    expect(onBase.criteria[0].checks[0].reason).toContain('printed "0"')

    // Nothing left behind: no registered worktree, no temporary directory,
    // and the bee's leftovers untouched.
    const worktrees = git(root, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
    expect(worktrees).toHaveLength(2)
    expect(readdirSync(tmpRoot)).toEqual([])
    expect(readFileSync(join(tree, 'specs', 'a.t27'), 'utf8')).toContain(
      'test "b"',
    )
  })

  it('refuses a head that is not a commit id, and runs nothing for prose', async () => {
    const calls: string[][] = []
    const exec = async (request: { argv: string[] }) => {
      calls.push(request.argv)
      return { code: 0, stdout: '', stderr: '', timedOut: false, capped: false }
    }
    expect(
      await measureCriteria(1, 'a'.repeat(40), ['no commands here'], { exec }),
    ).toEqual({ ok: true, criteria: [] })
    expect(calls).toEqual([])
    const bad = await measureCriteria(
      1,
      'HEAD; rm -rf /',
      ['`echo 1` prints `1`'],
      {
        exec,
      },
    )
    expect(bad.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it.if(T27C && existsSync(join(T27_MASTER, 'specs/tri/graph/prims_mst.t27')))(
    "measures #4251's criteria with the real compiler",
    async () => {
      const issue = 4251
      const spec = readFileSync(
        join(T27_MASTER, 'specs/tri/graph/prims_mst.t27'),
        'utf8',
      )
      const { root, headSha } = beeRepository(issue, {
        'specs/tri/graph/prims_mst.t27': spec,
      })
      const criteria = [
        ...storedCriteria(4251),
        '5. `t27c spec-status specs/tri/graph/prims_mst.t27` does not print `NOPARSE` - the file still parses',
      ]
      const measured = await measureCriteria(issue, headSha, criteria, {
        repoRoot: root,
      })
      expect(measured.ok).toBe(true)
      if (!measured.ok) return
      const byNumber = new Map(measured.criteria.map((c) => [c.number, c]))
      // The file as master holds it: UNWRITTEN, one stub, one test.
      expect(byNumber.get(1)?.checks[0]).toMatchObject({
        status: 'failed',
        output: 'UNWRITTEN',
      })
      expect(byNumber.get(2)?.checks[0]).toMatchObject({
        status: 'failed',
        output: '1',
      })
      expect(byNumber.get(3)?.checks[0].status).toBe('passed')
      expect(byNumber.get(4)?.checks[0]).toMatchObject({
        status: 'failed',
        output: '1',
      })
      expect(byNumber.get(5)?.checks[0].status).toBe('passed')
      const lines = criteriaWitness(measured.criteria)
      expect(lines.filter((l) => l.met).map((l) => l.number)).toEqual([3, 5])
    },
  )
})

// ---------------------------------------------------------------------------
// The sweep.

const ISSUE = 7101
const SPEC = 'specs/a.t27'
const CRITERIA = [
  `1. \`t27c spec-status ${SPEC}\` prints \`IMPLEMENTED\` (today: UNWRITTEN)`,
  `2. \`grep -c '^test ' ${SPEC}\` prints at least \`1\` (today: 0)`,
]
const PATCH = [
  `diff --git a/${SPEC} b/${SPEC}`,
  '+fn a() i32 { return 1; }',
  '+test "a" { assert(a() == 1); }',
].join('\n')

const LANE: WorkerProvider = {
  provider: 'openai-compatible',
  model: 'other-model',
  baseUrl: 'https://n.example.invalid',
  apiKey: 'not-a-real-key',
  keyIndex: 10_000,
  poolNumber: 2,
  laneIndex: 0,
  laneCount: 1,
}

type Row = Record<string, unknown>

function finishedRow(over: Row = {}): Row {
  return {
    issue: ISSUE,
    conversation_id: '00000000-0000-0000-0000-000000001bbd',
    review_state: null,
    criteria: CRITERIA,
    criteria_source: 'stated',
    send_backs: 0,
    owned_paths: [],
    free_attempts: 0,
    key_index: 1,
    provider: 'zai',
    model: 'glm-5.3',
    reviewer_fingerprint: null,
    reviewer_text: null,
    reviewer_model: null,
    reviewer_provider: null,
    criteria_fingerprint: null,
    criteria_runs: null,
    said: '',
    ...over,
  }
}

/** The stateful one-row Postgres of queen-adversarial-review, plus the criteria cache. */
function sweepPool(row: Row) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (text.includes('FROM queen_dispatch d')) {
        const open = row.review_state == null || row.review_state === 'wait'
        return { rowCount: open ? 1 : 0, rows: open ? [row] : [] }
      }
      if (text.includes('SET criteria_fingerprint')) {
        row.criteria_fingerprint = params[1]
        // Read back as jsonb would be: parsed.
        row.criteria_runs = JSON.parse(String(params[2]))
      } else if (text.includes('SET reviewer_fingerprint')) {
        row.reviewer_fingerprint = params[1]
        row.reviewer_text = params[2]
        row.reviewer_model = params[3]
        row.reviewer_provider = params[4]
      } else if (text.includes('review_state = $2')) {
        row.review_state = params[1]
        row.review_note = params[2]
        if (params[1] === 'sendBack' && params[4] === true) {
          row.send_backs = Number(row.send_backs ?? 0) + 1
        }
        row.free_attempts = params[5]
        row.reviewer_misses = params[6]
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  const verdictUpdates = () =>
    queries.filter((q) => q.sql.includes('review_state = $2'))
  return { pool, queries, verdictUpdates }
}

const check = (
  cmd: string,
  status: 'passed' | 'failed' | 'unrunnable',
  output: string,
  over: Partial<CriterionRun['checks'][number]> = {},
): CriterionRun['checks'][number] => ({
  cmd,
  op: 'equals',
  expected: 'IMPLEMENTED',
  status,
  ok: status === 'passed',
  output,
  exitCode: 0,
  reason: status === 'passed' ? `printed "${output}"` : `printed "${output}"`,
  ...over,
})

function runsWith(first: 'passed' | 'failed', second: 'passed' | 'failed') {
  return [
    {
      number: 1,
      criterion: CRITERIA[0],
      checks: [
        check(
          `t27c spec-status ${SPEC}`,
          first,
          first === 'passed' ? 'IMPLEMENTED' : 'PARTIAL',
          first === 'passed'
            ? {}
            : { reason: 'expected "IMPLEMENTED", printed "PARTIAL"' },
        ),
      ],
    },
    {
      number: 2,
      criterion: CRITERIA[1],
      checks: [
        check(
          `grep -c '^test ' ${SPEC}`,
          second,
          second === 'passed' ? '1' : '0',
          {
            op: 'atLeast',
            expected: '1',
            ...(second === 'passed'
              ? {}
              : { reason: 'expected at least 1, printed "0"' }),
          },
        ),
      ],
    },
  ] satisfies CriterionRun[]
}

function fakes(
  over: Partial<ReviewDeps> & { answer?: string; runs?: CriterionRun[] } = {},
) {
  const calls: Array<{ message: string }> = []
  const measured: Array<{ issue: number; head: string; criteria: string[] }> =
    []
  const deps: Partial<ReviewDeps> = {
    committedFilesResult: async () => ({ ok: true, files: [SPEC] }),
    branchHeadSha: async () => 'c'.repeat(40),
    mergeBaseSha: async () => 'd'.repeat(40),
    branchPatch: async () => PATCH,
    worktreeDirtCount: async () => null,
    witness: async () => ({ kind: 'witnessed', t27c: 'fake', specs: [] }),
    laneCandidates: () => [LANE],
    reviewsPerRound: () => 3,
    measureCriteria: async (issue, head, criteria) => {
      measured.push({ issue, head, criteria })
      return { ok: true, criteria: over.runs ?? runsWith('passed', 'passed') }
    },
    llm: async (_lane, _system, message) => {
      calls.push({ message })
      return {
        ok: true,
        text:
          over.answer ??
          ['## VERDICT', '- 1. M1: met', '- 2. M2: met'].join('\n'),
      }
    },
    ...over,
  }
  return { deps, calls, measured }
}

const saved: Record<string, string | undefined> = {}
const ENV = [QUEEND_ENV, 'WORKSPACE_DIR', 'TRIOS_REPO_REF', 'TRIOS_GITHUB_REPO']

beforeEach(() => {
  forgetReviewerLaneFailures()
  for (const key of ENV) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env[QUEEND_ENV] = BIN
  process.env.WORKSPACE_DIR = join(tmpdir(), 'queen-criteria-no-such-workspace')
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('the sweep weighs what the Queen measured', () => {
  it('measures the dispatch criteria at the branch head, once per head', async () => {
    const row = finishedRow()
    const { pool } = sweepPool(row)
    const { deps, measured } = fakes()
    await reviewFinishedDispatches(pool, deps)
    expect(measured).toEqual([
      { issue: ISSUE, head: 'c'.repeat(40), criteria: CRITERIA },
    ])
    expect(row.criteria_fingerprint).toEqual(expect.any(String))

    // A wait row re-read over an unchanged head runs nothing.
    row.review_state = 'wait'
    await reviewFinishedDispatches(pool, deps)
    expect(measured).toHaveLength(1)

    // A moved head is new work, measured again.
    row.review_state = 'wait'
    await reviewFinishedDispatches(pool, {
      ...deps,
      branchHeadSha: async () => 'e'.repeat(40),
    })
    expect(measured).toHaveLength(2)
  })

  it('runs nothing for criteria that state no command', async () => {
    const { pool } = sweepPool(
      finishedRow({ criteria: ['The spec reads well', 'A person likes it'] }),
    )
    const { deps, measured } = fakes({
      answer: ['## VERDICT', `- 1. ${SPEC}:1: met`, `- 2. ${SPEC}:2: met`].join(
        '\n',
      ),
    })
    await reviewFinishedDispatches(pool, deps)
    expect(measured).toEqual([])
  })

  it('shows the reviewer every measurement inside the fence, citable by number', async () => {
    const { pool } = sweepPool(finishedRow())
    const { deps, calls } = fakes({ runs: runsWith('passed', 'failed') })
    await reviewFinishedDispatches(pool, deps)
    expect(calls).toHaveLength(1)
    const fence = calls[0].message.match(
      /BEGIN UNTRUSTED MEASUREMENTS (\w+)\n([\s\S]*?)\nEND UNTRUSTED MEASUREMENTS \1/,
    )
    expect(fence).not.toBeNull()
    const inside = fence?.[2] ?? ''
    expect(inside).toContain(
      `[M1] criterion 1 passed: \`t27c spec-status ${SPEC}\` must print "IMPLEMENTED"; printed "IMPLEMENTED"`,
    )
    expect(inside).toContain(
      `[M2] criterion 2 FAILED: \`grep -c '^test ' ${SPEC}\` must print at least 1; printed "0"`,
    )
    expect(calls[0].message).toContain('cite it as Mn')
  })

  it.if(present)(
    'spends send_backs on a mechanical failure, whatever the reviewer said',
    async () => {
      const row = finishedRow()
      const { pool, verdictUpdates } = sweepPool(row)
      const { deps } = fakes({
        runs: runsWith('failed', 'passed'),
        answer: [
          '## VERDICT',
          `- 1. ${SPEC}:1 defines a: met`,
          '- 2. M2: met',
        ].join('\n'),
      })
      const reviewed = await reviewFinishedDispatches(pool, deps)
      expect(reviewed.acted).toEqual([`#${ISSUE}:sendBack`])
      expect(verdictUpdates()[0].params[4]).toBe(true)
      expect(row.send_backs).toBe(1)
      expect(String(row.review_note)).toContain(
        'criterion 1 measured on the commit FAILED',
      )
    },
  )

  it.if(present)(
    'spends send_backs on a mechanical failure with no reviewer at all',
    async () => {
      const row = finishedRow()
      const { pool, verdictUpdates } = sweepPool(row)
      const { deps } = fakes({
        runs: runsWith('failed', 'passed'),
        laneCandidates: () => [],
      })
      const reviewed = await reviewFinishedDispatches(pool, deps)
      expect(reviewed.acted).toEqual([`#${ISSUE}:sendBack`])
      expect(verdictUpdates()[0].params[4]).toBe(true)
    },
  )

  it('never accepts on measurements alone', async () => {
    const said = [
      '## VERDICT',
      `- 1. ${CRITERIA[0]}: met`,
      `- 2. ${CRITERIA[1]}: met`,
    ].join('\n')
    for (const bee of ['', said]) {
      const { pool } = sweepPool(finishedRow({ said: bee }))
      const { deps } = fakes({ laneCandidates: () => [] })
      const reviewed = await reviewFinishedDispatches(pool, deps)
      expect(reviewed.acted).toEqual([`#${ISSUE}:wait`])
    }
  })

  it.if(present)(
    'does not escalate a criterion the machine established as beyond the patch',
    async () => {
      const answer = [
        '## VERDICT',
        `- 1. ${SPEC}:1 defines a and M1 printed IMPLEMENTED: met`,
        '- 2. needs a test run to know: could-not-check',
      ].join('\n')
      const measuredRow = finishedRow()
      const measured = sweepPool(measuredRow)
      expect(
        (await reviewFinishedDispatches(measured.pool, fakes({ answer }).deps))
          .acted,
      ).toEqual([`#${ISSUE}:accept`])
      expect(measured.verdictUpdates()[0].params[4]).toBe(false)

      // The control: the same answer with criterion 2 unmeasured escalates.
      const unmeasured = sweepPool(finishedRow())
      const runs = runsWith('passed', 'passed').slice(0, 1)
      expect(
        (
          await reviewFinishedDispatches(
            unmeasured.pool,
            fakes({ answer, runs }).deps,
          )
        ).acted,
      ).toEqual([`#${ISSUE}:escalate`])
    },
  )

  it.if(present)(
    'lets a reviewer refutation beat a passing measurement',
    async () => {
      const row = finishedRow()
      const { pool, verdictUpdates } = sweepPool(row)
      const { deps } = fakes({
        answer: [
          '## VERDICT',
          '- 1. M1: met',
          `- 2. ${SPEC}:3 the only test asserts a constant, not a(): unmet`,
        ].join('\n'),
      })
      const reviewed = await reviewFinishedDispatches(pool, deps)
      expect(reviewed.acted).toEqual([`#${ISSUE}:sendBack`])
      expect(verdictUpdates()[0].params[4]).toBe(true)
      expect(String(row.review_note)).toContain('asserts a constant')
    },
  )
})

describe('the reviewer may cite a measurement', () => {
  it('accepts Mn for criterion n only when that measurement passed', () => {
    const text = [
      '## VERDICT',
      '- 1. [M1] printed IMPLEMENTED: met',
      '- 2. see M1: met',
      '- 3. measurement 3 printed 0: met',
    ].join('\n')
    const judged = judgeReviewerText(text, 3, [], [], [1, 3])
    expect(judged.answers.get(1)?.verdict).toBe('met')
    // M1 is not evidence for criterion 2.
    expect(judged.answers.get(2)?.verdict).toBe('could-not-check')
    expect(judged.answers.get(3)?.verdict).toBe('met')
    // Without a passing measurement nothing changes.
    expect(judgeReviewerText(text, 3, [], []).answers.get(1)?.verdict).toBe(
      'could-not-check',
    )
    expect(citesMeasurement('M12 printed 1', 1, [1])).toBe(false)
    expect(citesMeasurement('SHM1 x', 1, [1])).toBe(false)
  })

  it('puts measurement lines inside the fence of a message built directly', () => {
    const lines = measurementLines(runsWith('passed', 'passed'))
    const message = reviewerMessage({
      repo: 'gHashTag/t27',
      issue: ISSUE,
      criteria: CRITERIA,
      files: [SPEC],
      patch: PATCH,
      machine: [],
      measurements: lines,
      base: 'origin/master',
    })
    expect(message).not.toContain('(none were taken for this change)')
    const begin = message.indexOf('BEGIN UNTRUSTED MEASUREMENTS')
    const end = message.indexOf('END UNTRUSTED MEASUREMENTS')
    for (const line of lines) {
      const at = message.indexOf(line)
      expect(at).toBeGreaterThan(begin)
      expect(at).toBeLessThan(end)
    }
  })
})
