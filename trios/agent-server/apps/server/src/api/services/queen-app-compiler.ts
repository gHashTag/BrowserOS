/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * What the t27 compiler says about one changed .t27 file, for the t27-bees
 * review (gHashTag/t27 specs/queen/app.t27, compiler_verdict, t27#7704).
 *
 * It runs the native t27c on the image, the same binary the witness runs:
 * - `parse` exits 0, or names the first error;
 * - `parse-complete` reports how many tokens the parser discarded to go on;
 * - `typecheck` passes.
 * The verdict is the card's (compiler_verdict). This file only measures.
 *
 * WHY NOT THE VENDORED WASM. The wasm compiler beside the cards is older than
 * t27c. Measured 2026-10-08, it reports 13 typecheck errors on app.t27, which
 * t27c accepts with 0. A judge that is wrong about valid files is noise posted
 * as fact.
 *
 * WHAT IT NEVER DOES. It never generates, builds or runs anything. The text is
 * written to a scratch directory, and t27c reads it in a process whose
 * environment is PATH alone, so even a compiler bug finds no credential in
 * reach. A pass says the file is well formed, not that it is right: the
 * typechecker passes `return y;` with no `y`, and the review says so.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V_BROKEN } from './queen-app.gen'
import { compilerVerdict } from './queen-app-logic'

export interface CompilerCheck {
  path: string
  verdict: number
  parses: boolean
  typechecks: boolean
  errors: number
  discarded: number
  /** The first error line the compiler printed, or ''. */
  first: string
}

/** null means NOT MEASURED (no t27c on this image): never read as a pass. */
export type CheckT27 = (
  path: string,
  text: string,
) => Promise<CompilerCheck | null>

export const COMPILER_TIMEOUT_MS = 15_000
const OUTPUT_CAP = 64 * 1024

function t27c(): string {
  return process.env.T27C_BIN || 't27c'
}

/** One t27c run: exit code (null when it could not start) and its capped output. */
function run(
  args: string[],
  cwd: string,
  keepStdout: boolean,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const take = (chunk: Buffer) => {
      if (out.length < OUTPUT_CAP)
        out += chunk.toString('utf8').slice(0, OUTPUT_CAP - out.length)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(t27c(), args, {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
        stdio: ['ignore', keepStdout ? 'pipe' : 'ignore', 'pipe'],
      })
    } catch {
      resolve({ code: null, out: '' })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), COMPILER_TIMEOUT_MS)
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, out })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
  })
}

const firstError = (out: string): string =>
  (out.split('\n').find((l) => /error/i.test(l)) ?? '')
    .replace(/^\s*Error:\s*/, '')
    // It quotes the file at times: no ping and no HTML comment may ride along.
    .replace(/<!--|-->/g, '')
    .replace(/@/g, '@\u200b')
    .trim()
    .slice(0, 240)

/** Measure one file with the native t27c. */
export const checkT27WithNativeCompiler: CheckT27 = async (path, text) => {
  const dir = await mkdtemp(join(tmpdir(), 't27-bees-'))
  try {
    const specs = join(dir, 'specs', 'one')
    await mkdir(specs, { recursive: true })
    const name = `${(path.split('/').pop() ?? 'file').replace(/[^\w.-]/g, '_').replace(/\.t27$/, '')}.t27`
    const file = join(specs, name)
    await writeFile(file, text)

    const parse = await run(['parse', file], dir, false)
    if (parse.code === null) return null
    const complete = await run(
      ['parse-complete', '--specs-dir', join(dir, 'specs')],
      dir,
      true,
    )
    const typecheck = await run(['typecheck', file], dir, true)

    const parses = parse.code === 0
    const discardMatch = complete.out.match(/DISCARD\s+\d+\s+\((\d+)\s+token/)
    const truncateMatch = complete.out.match(/TRUNCATE\s+(\d+)/)
    const discarded =
      Number(discardMatch?.[1] ?? 0) +
      (Number(truncateMatch?.[1] ?? 0) > 0 ? 1 : 0)
    const typechecks =
      typecheck.code === 0 && /Typecheck OK/.test(typecheck.out)
    const counted = Number(typecheck.out.match(/(\d+) errors?/)?.[1] ?? 0)
    const errors = parses && typechecks ? counted : Math.max(1, counted)
    return {
      path,
      verdict: compilerVerdict(parses && typechecks, errors, discarded),
      parses,
      typechecks,
      errors,
      discarded,
      first: parses
        ? typechecks
          ? ''
          : firstError(typecheck.out)
        : firstError(parse.out),
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** One line of the review per checked file. */
export function compilerLine(check: CompilerCheck): string {
  const name = `\`${check.path}\``
  if (check.verdict !== V_BROKEN) return `- ${name}: parses and typechecks.`
  if (!check.parses)
    return `- ${name}: **does not parse**${check.first ? `: \`${check.first.replace(/`/g, "'")}\`` : '.'}`
  if (!check.typechecks)
    return `- ${name}: **does not typecheck**${check.first ? `: \`${check.first.replace(/`/g, "'")}\`` : '.'}`
  return `- ${name}: **the parser discarded ${check.discarded} token(s)** to read it; the typecheck that passed is not a pass.`
}
