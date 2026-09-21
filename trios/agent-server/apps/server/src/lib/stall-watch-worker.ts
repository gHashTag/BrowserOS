/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The watching half of lib/stall-watch.ts. Runs on its own thread, so it keeps
 * running while the main thread is stuck, and writes to fd 2 directly: a
 * console or pino call from here could route through the thread that is stuck.
 */

import fs from 'node:fs'
import { HEADER_INTS, LABEL_BYTES, RING, SLOT_INTS } from './stall-watch'

declare const self: Worker

const REPORT_AFTER_S = Number(process.env.TRIOS_STALL_REPORT_SECONDS ?? 15)
const REPEAT_EVERY_S = 30
const CHECK_EVERY_MS = 2000

const decoder = new TextDecoder()
const say = (line: string) => {
  try {
    fs.writeSync(2, `[stall] ${line}\n`)
  } catch {
    // Nowhere left to say it.
  }
}

self.onmessage = (event: MessageEvent<{ shared: SharedArrayBuffer }>) => {
  const ints = new Int32Array(event.data.shared)
  const bytes = new Uint8Array(event.data.shared)

  const recent = (now: number): string[] => {
    const next = Atomics.load(ints, 1)
    const lines: string[] = []
    for (let k = 1; k <= RING; k++) {
      const slot = (((next - k) % RING) + RING) % RING
      const base = HEADER_INTS + slot * SLOT_INTS
      const at = Atomics.load(ints, base)
      if (!at) continue
      const len = Math.min(Atomics.load(ints, base + 1), LABEL_BYTES)
      const label = decoder.decode(
        bytes.slice((base + 2) * 4, (base + 2) * 4 + len),
      )
      lines.push(`  ${now - at}s ago: ${label}`)
    }
    return lines
  }

  let stalledSince = 0
  let lastReport = 0
  let longest = 0

  setInterval(() => {
    const now = Math.floor(Date.now() / 1000)
    const beat = Atomics.load(ints, 0)
    const silent = now - beat
    if (silent >= REPORT_AFTER_S) {
      if (!stalledSince) stalledSince = beat
      if (now - lastReport >= REPEAT_EVERY_S) {
        lastReport = now
        say(
          `main thread has not turned its event loop for ${silent}s; the last things it did, newest first:\n${recent(now).join('\n')}`,
        )
      }
    } else if (stalledSince) {
      const length = now - stalledSince
      longest = Math.max(longest, length)
      say(
        `main thread turned again after ~${length}s (longest stall since boot: ${longest}s)`,
      )
      stalledSince = 0
      lastReport = 0
    }
  }, CHECK_EVERY_MS)
}
