/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A t27 card compiled to wasm, called from here: `t27c gen-c` of the card,
 * then `zig cc --target=wasm32-wasi -Oz -DNDEBUG -mexec-model=reactor` with one
 * `--export` per function (the command and the hashes are in specs/PIN).
 *
 * A card imports nothing, so it can reach no file, clock or network. It is the
 * decision and nothing else; this file only carries bytes in and numbers out.
 * Text goes in through the module's own memory, written past the end of the
 * memory the module was built with, so nothing the generated code uses is
 * overwritten.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SPECS_ROOT } from '../../inngest/spec-catalog'

type Fn = (...args: number[]) => number

export interface CardWasm {
  /** Call an exported function with numbers (bools as 0/1). */
  call(name: string, ...args: number[]): number
  /** Write texts into scratch memory; returns each one's address and length. */
  put(...texts: string[]): Array<{ at: number; len: number }>
  /** Room for an output buffer of `bytes` after the last put; returns its address. */
  room(bytes: number): number
  /** Read bytes the card wrote. */
  read(at: number, len: number): string
}

const cache = new Map<string, CardWasm>()

export function loadCardWasm(
  file: string,
  root: string = DEFAULT_SPECS_ROOT,
): CardWasm {
  const key = `${root}:${file}`
  const hit = cache.get(key)
  if (hit) return hit
  const module = new WebAssembly.Module(readFileSync(join(root, file)))
  const imports = WebAssembly.Module.imports(module)
  if (imports.length > 0)
    throw new Error(
      `${file} imports ${imports.length} names; a card must import nothing`,
    )
  const x = new WebAssembly.Instance(module, {}).exports as Record<
    string,
    unknown
  >
  ;(x._initialize as (() => void) | undefined)?.()
  const memory = x.memory as WebAssembly.Memory
  const base = memory.buffer.byteLength
  let cursor = base

  const ensure = (end: number) => {
    const have = memory.buffer.byteLength
    if (end > have) memory.grow(Math.ceil((end - have) / 65_536))
  }

  const card: CardWasm = {
    call(name, ...args) {
      const fn = x[name] as Fn | undefined
      if (typeof fn !== 'function')
        throw new Error(`${file} exports no ${name}`)
      return fn(...args)
    },
    put(...texts) {
      cursor = base
      return texts.map((text) => {
        const bytes = new TextEncoder().encode(text)
        ensure(cursor + bytes.length + 1)
        new Uint8Array(memory.buffer, cursor, bytes.length).set(bytes)
        const at = cursor
        cursor += bytes.length + 1
        return { at, len: bytes.length }
      })
    },
    room(bytes) {
      ensure(cursor + bytes)
      const at = cursor
      cursor += bytes
      return at
    },
    read(at, len) {
      return new TextDecoder().decode(new Uint8Array(memory.buffer, at, len))
    },
  }
  cache.set(key, card)
  return card
}

export const flag = (b: boolean): number => (b ? 1 : 0)
export const u32 = (n: number): number =>
  Math.max(0, Math.min(0xffff_ffff, Math.floor(n))) >>> 0
