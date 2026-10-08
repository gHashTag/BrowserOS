/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * What the t27 compiler says about a changed .t27 file (gHashTag/t27
 * specs/queen/app.t27 compiler_verdict and is_t27_path, t27#7704). With a t27c
 * on PATH or in T27C_BIN the fixtures are measured; without one the check must
 * answer "not measured" (null), never a pass.
 */

import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { V_BROKEN, V_CLEAN } from '../../src/api/services/queen-app.gen'
import {
  checkT27WithNativeCompiler,
  compilerLine,
} from '../../src/api/services/queen-app-compiler'
import {
  compilerVerdict,
  isT27Path,
} from '../../src/api/services/queen-app-logic'

const haveT27c =
  spawnSync(process.env.T27C_BIN || 't27c', ['--version']).status === 0

describe('the card decides, from what the compiler measured', () => {
  it('the_compiler_is_the_judge_of_a_t27_file', () => {
    expect(compilerVerdict(true, 0, 0)).toBe(V_CLEAN)
    expect(compilerVerdict(false, 0, 0)).toBe(V_BROKEN)
    expect(compilerVerdict(true, 2, 0)).toBe(V_BROKEN)
    expect(compilerVerdict(true, 0, 3)).toBe(V_BROKEN)
  })
  it('only_a_t27_file_goes_to_the_compiler', () => {
    expect(isT27Path('specs/queen/app.t27')).toBe(true)
    expect(isT27Path('a.t27')).toBe(true)
    expect(isT27Path('.t27')).toBe(true)
    expect(isT27Path('t27')).toBe(false)
    expect(isT27Path('specs/queen/app.t27.md')).toBe(false)
    expect(isT27Path('specs/queen/app.t28')).toBe(false)
    expect(isT27Path('specs/queen/appxt27')).toBe(false)
    expect(isT27Path('README.md')).toBe(false)
  })
})

describe('the native t27c measures a file', () => {
  it.if(haveT27c)('passes a well-formed spec', async () => {
    const good =
      'module M;\npub const A : u8 = 1;\npub fn f(x: u8) -> u8 { return x + A; }\ntest t { assert f(1) == 2; }\n'
    const r = await checkT27WithNativeCompiler('specs/m.t27', good)
    expect(r).toMatchObject({
      verdict: V_CLEAN,
      parses: true,
      typechecks: true,
      discarded: 0,
    })
    expect(compilerLine(r!)).toBe('- `specs/m.t27`: parses and typechecks.')
  })
  it.if(haveT27c)(
    'names the first parse error of a broken one, at its line',
    async () => {
      const r = await checkT27WithNativeCompiler(
        'specs/broken.t27',
        'module M;\npub fn f(x: u8) -> u8 { return x + ; }\n',
      )
      expect(r?.verdict).toBe(V_BROKEN)
      expect(r?.parses).toBe(false)
      expect(r?.first).toContain('line 2')
      expect(compilerLine(r!)).toContain('**does not parse**')
    },
  )
  it.if(haveT27c)('refuses English prose dressed as a .t27 file', async () => {
    const r = await checkT27WithNativeCompiler(
      'specs/cat.t27',
      'the cat sat on the mat\n',
    )
    expect(r?.verdict).toBe(V_BROKEN)
  })
  it.if(haveT27c)(
    'says a pass is well formed, not right: an unresolved name still passes',
    async () => {
      // Measured 2026-10-08, and the review's wording depends on it.
      const r = await checkT27WithNativeCompiler(
        'specs/undef.t27',
        'module M;\npub fn f(x: u8) -> u8 { return y; }\n',
      )
      expect(r?.verdict).toBe(V_CLEAN)
    },
  )
  it.if(!haveT27c)('answers not measured when there is no t27c', async () => {
    expect(await checkT27WithNativeCompiler('specs/m.t27', 'module M;\n')).toBe(
      null,
    )
  })
})

describe('a compiler line is safe to post', () => {
  it('cannot ping and cannot break out of its code span', () => {
    const line = compilerLine({
      path: 'specs/x.t27',
      verdict: V_BROKEN,
      parses: false,
      typechecks: false,
      errors: 1,
      discarded: 0,
      first: 'parse error near `@​alice`',
    })
    expect(line).not.toMatch(/`@alice/)
    expect(line.split('`').length % 2).toBe(1)
  })
})
