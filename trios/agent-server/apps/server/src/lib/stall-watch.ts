/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * STALL WATCH: say where the main thread stopped, and let the entrypoint tell a
 * hung server from a busy one.
 *
 * Measured 2026-09-21 14:44: the server spun one core at 100% for twelve
 * minutes (cpu 973 s -> 1512 s), answered nothing, and was ended by the
 * entrypoint's liveness loop with no record of WHERE it spun. The log could not
 * say: pino writes asynchronously, so the lines logged just before the spin sat
 * in a buffer the blocked thread never flushed.
 *
 * So two things live outside the main thread's event loop:
 *
 * 1. Breadcrumbs. Every log line (and a few hand-placed marks in the hot paths)
 *    is written into a SharedArrayBuffer ring as it happens - no I/O, no
 *    event-loop turn needed. A Worker thread reads the ring, and when the main
 *    thread's heartbeat stops it writes the last activities straight to fd 2,
 *    which it can do while the main thread is stuck.
 *
 * 2. A heartbeat file. The main thread touches it every few seconds from a
 *    timer, which only fires when the event loop turns. A server busy with
 *    twenty bees still turns it, slowly; a spinning one does not turn it at
 *    all. docker-entrypoint.sh ends the server when the file goes stale for
 *    LIVENESS_STALL seconds - minutes sooner than the twelve missed /health
 *    probes it needed before, which could not tell busy from dead.
 */

import fs from 'node:fs'

export const HEARTBEAT_FILE =
  process.env.TRIOS_LOOP_HEARTBEAT_FILE ?? '/tmp/trios-loop-heartbeat'

// Layout of the shared buffer, in Int32 slots:
//   [0] main-thread heartbeat, epoch seconds
//   [1] index of the next ring slot to write
//   then RING slots, each: [time, byteLength, ...LABEL_BYTES/4 ints]
export const RING = 12
export const LABEL_BYTES = 240
export const SLOT_INTS = 2 + LABEL_BYTES / 4
export const HEADER_INTS = 2
const TOTAL_INTS = HEADER_INTS + RING * SLOT_INTS

let ints: Int32Array | null = null
let bytes: Uint8Array | null = null
const encoder = new TextEncoder()

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Record what the main thread is doing. Cheap: a few stores, no I/O. */
export function markActivity(label: string): void {
  if (!ints || !bytes) return
  const slot = Atomics.add(ints, 1, 1) % RING
  const base = HEADER_INTS + slot * SLOT_INTS
  const view = bytes.subarray((base + 2) * 4, (base + 2) * 4 + LABEL_BYTES)
  const { written } = encoder.encodeInto(label, view)
  Atomics.store(ints, base + 1, written ?? 0)
  Atomics.store(ints, base, nowSeconds())
}

/** Start the heartbeat and the watching thread. Safe to call once. */
export function startStallWatch(): void {
  if (ints || process.env.TRIOS_STALL_WATCH === '0') return
  const shared = new SharedArrayBuffer(TOTAL_INTS * 4)
  ints = new Int32Array(shared)
  bytes = new Uint8Array(shared)
  Atomics.store(ints, 0, nowSeconds())

  try {
    fs.writeFileSync(HEARTBEAT_FILE, `${process.pid}\n`)
  } catch {
    // No heartbeat file: the entrypoint falls back to /health probes alone.
  }
  let lastTouch = 0
  const beat = setInterval(() => {
    const now = nowSeconds()
    if (ints) Atomics.store(ints, 0, now)
    if (now - lastTouch >= 5) {
      lastTouch = now
      try {
        fs.utimesSync(HEARTBEAT_FILE, now, now)
      } catch {
        // Missing file only weakens the entrypoint's check; never fatal.
      }
    }
  }, 1000)
  beat.unref?.()

  const worker = new Worker(new URL('./stall-watch-worker.ts', import.meta.url))
  worker.postMessage({ shared, pid: process.pid })
  // Bun's Worker has unref(); the DOM typing this project compiles against
  // does not declare it. Unref'd, the watcher never keeps the process alive.
  ;(worker as Worker & { unref?: () => void }).unref?.()
}
