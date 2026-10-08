/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The t27-bees app's decisions, run as code generated from their spec
 * (gHashTag/t27 specs/queen/app.t27, t27#7682 and t27#7695), not mirrored by
 * hand.
 *
 * `specs/queen/app.wasm` is that card compiled: `t27c gen-c`, then
 * `zig cc --target=wasm32-wasi -Oz -DNDEBUG -mexec-model=reactor` with one
 * `--export` per function below (the command and the hashes are in specs/PIN).
 * It imports nothing, so it can reach no file, clock or network: it is the
 * decision and nothing else. This file only carries bytes in and a number out.
 *
 * A string goes in through the module's own memory. Scratch space starts at
 * the end of the memory the module was built with, and grows when a text needs
 * more, so nothing the generated code uses is ever written over.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SPECS_ROOT } from '../../inngest/spec-catalog'

interface AppExports {
  memory: WebAssembly.Memory
  _initialize?: () => void
  app_reaction: (
    event: number,
    fromABot: number,
    served: number,
    paused: number,
    draft: number,
    reviewsLeft: number,
  ) => number
  free_reviews_left: (publicRepo: number, usedToday: number) => number
  review_depth: (changedLines: number) => number
  review_wanted: (alreadyReviewed: number, askedAgain: number) => number
  command_of: (text: number, len: number) => number
  app_event_of: (pair: number, len: number, onAPullRequest: number) => number
  compiler_verdict: (
    typecheckOk: number,
    errors: number,
    discarded: number,
  ) => number
  is_t27_path: (path: number, len: number) => number
}

export const APP_WASM_FILE = 'queen/app.wasm'

let loaded: { x: AppExports; scratch: number } | null = null

function app(root: string = DEFAULT_SPECS_ROOT): {
  x: AppExports
  scratch: number
} {
  if (loaded) return loaded
  const module = new WebAssembly.Module(readFileSync(join(root, APP_WASM_FILE)))
  const imports = WebAssembly.Module.imports(module)
  if (imports.length > 0)
    throw new Error(
      `${APP_WASM_FILE} imports ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}; the card must import nothing`,
    )
  const x = new WebAssembly.Instance(module, {})
    .exports as unknown as AppExports
  x._initialize?.()
  loaded = { x, scratch: x.memory.buffer.byteLength }
  return loaded
}

/** Load the card now, so a missing or wrong file fails the boot, not a webhook. */
export function loadAppCard(root?: string): void {
  app(root)
}

const u32 = (n: number): number =>
  Math.max(0, Math.min(0xffff_ffff, Math.floor(n))) >>> 0
const flag = (b: boolean): number => (b ? 1 : 0)

/** Copy `text` (UTF-8) into scratch memory; returns its address and length. */
function put(text: string): { at: number; len: number } {
  const { x, scratch } = app()
  const bytes = new TextEncoder().encode(text)
  const need = scratch + bytes.length
  const have = x.memory.buffer.byteLength
  if (need > have) x.memory.grow(Math.ceil((need - have) / 65_536))
  new Uint8Array(x.memory.buffer, scratch, bytes.length).set(bytes)
  return { at: scratch, len: bytes.length }
}

/** app_reaction: what the Queen does about one event (AR_*). */
export function appReaction(
  event: number,
  fromABot: boolean,
  served: boolean,
  paused: boolean,
  draft: boolean,
  reviewsLeft: number,
): number {
  return app().x.app_reaction(
    event,
    flag(fromABot),
    flag(served),
    flag(paused),
    flag(draft),
    u32(reviewsLeft),
  )
}

/** free_reviews_left: today's free reviews left for an installation. */
export function freeReviewsLeft(
  publicRepo: boolean,
  usedToday: number,
): number {
  return app().x.free_reviews_left(flag(publicRepo), u32(usedToday)) >>> 0
}

/** review_depth: DEPTH_FULL, or DEPTH_SUMMARY for a diff too big to read whole. */
export function reviewDepth(changedLines: number): number {
  return app().x.review_depth(u32(changedLines))
}

/** review_wanted: one review per head, unless a person asked again. */
export function reviewWanted(
  alreadyReviewedThisHead: boolean,
  askedAgain: boolean,
): boolean {
  return (
    app().x.review_wanted(flag(alreadyReviewedThisHead), flag(askedAgain)) !== 0
  )
}

/** command_of: the command after the first `@t27-bees` in a comment (C_*). */
export function commandOf(text: string): number {
  const { at, len } = put(text)
  return app().x.command_of(at, len)
}

/** app_event_of: the GE code of `<X-GitHub-Event>.<action>`. */
export function appEventOf(
  event: string,
  action: string,
  onAPullRequest: boolean,
): number {
  const { at, len } = put(`${event}.${action}`)
  return app().x.app_event_of(at, len, flag(onAPullRequest))
}

/** compiler_verdict: V_CLEAN, or V_BROKEN on a failed typecheck, an error or a discarded token. */
export function compilerVerdict(
  typecheckOk: boolean,
  errors: number,
  discarded: number,
): number {
  return app().x.compiler_verdict(
    flag(typecheckOk),
    u32(errors),
    u32(discarded),
  )
}

/** is_t27_path: is this path a t27 source, by its suffix? */
export function isT27Path(path: string): boolean {
  const { at, len } = put(path)
  return app().x.is_t27_path(at, len) !== 0
}
