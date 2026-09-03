#!/usr/bin/env node
/**
 * Input release gate for gHashTag/trios#1380.
 *
 * pressCombo (keyboard.ts) and dispatchDrag (mouse.ts) hold renderer state
 * across several CDP round trips: a key or mouse button stays down from its
 * press dispatch until a later release dispatch completes. If any dispatch in
 * the sequence rejects (CDP request timeout, connection lost, ...), every key
 * or button whose press was already delivered must still be released, and the
 * original error must still reach the caller.
 *
 * This gate drives the REAL exported functions against an in-memory CDP
 * session whose Nth dispatch rejects, sweeps every failure index (indices
 * past the function's real dispatch count never fire and act as no-failure
 * controls), and counts input left held: keyDown without keyUp, mousePressed
 * without mouseReleased. It does not grep the source for keywords; the
 * functions themselves are executed.
 *
 * Usage:
 *   node trios/tools/input-release-gate.mjs             run the gate
 *   node trios/tools/input-release-gate.mjs --selftest  prove the detector can go red
 *
 * Plain node only. No dependencies, no compiled artifacts, and no writes:
 * the gate never modifies a file, and --selftest drives in-memory stubs
 * exclusively (a previous self-test in this repository truncated a shipped
 * source file; this one cannot, by construction).
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KEYBOARD_URL = pathToFileURL(
  path.join(
    HERE,
    '..',
    'agent-server',
    'apps',
    'server',
    'src',
    'browser',
    'keyboard.ts',
  ),
).href
const MOUSE_URL = pathToFileURL(
  path.join(
    HERE,
    '..',
    'agent-server',
    'apps',
    'server',
    'src',
    'browser',
    'mouse.ts',
  ),
).href

const RUNTIME = process.versions.bun
  ? `node ${process.version} (bun ${process.versions.bun} providing the node CLI)`
  : `node ${process.version}`

// ---------------------------------------------------------------------------
// In-memory CDP session
// ---------------------------------------------------------------------------

function cdpTimeout(method, id) {
  const err = new Error(`CDP request timeout: ${method} (id=${id})`)
  err.code = 'CDP_TIMEOUT'
  return err
}

/**
 * A session whose failAt-th dispatch call rejects, the way backends/cdp.ts
 * does: the command was sent and no reply came back. Calls are recorded only
 * when they resolve - a rejected dispatch leaves no proof of delivery on this
 * side, exactly like the real backend.
 */
function makeSession({ failAt = Number.POSITIVE_INFINITY } = {}) {
  let calls = 0
  const keyEvents = []
  const mouseEvents = []
  const session = {
    Input: {
      async dispatchKeyEvent(params) {
        calls += 1
        if (calls === failAt) throw cdpTimeout('Input.dispatchKeyEvent', calls)
        keyEvents.push({ ...params })
      },
      async dispatchMouseEvent(params) {
        calls += 1
        if (calls === failAt) throw cdpTimeout('Input.dispatchMouseEvent', calls)
        mouseEvents.push({ ...params })
      },
    },
  }
  return { session, keyEvents, mouseEvents, callCount: () => calls }
}

// ---------------------------------------------------------------------------
// Leak detection
// ---------------------------------------------------------------------------

/** Keys with more delivered keyDowns than delivered keyUps. */
function heldKeys(keyEvents) {
  const counts = new Map()
  for (const event of keyEvents) {
    if (event.type === 'keyDown')
      counts.set(event.key, (counts.get(event.key) ?? 0) + 1)
    else if (event.type === 'keyUp')
      counts.set(event.key, (counts.get(event.key) ?? 0) - 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 0).map(([key]) => key)
}

/** Buttons with more delivered presses than delivered releases. */
function heldButtons(mouseEvents) {
  const counts = new Map()
  for (const event of mouseEvents) {
    if (event.type === 'mousePressed')
      counts.set(event.button, (counts.get(event.button) ?? 0) + 1)
    else if (event.type === 'mouseReleased')
      counts.set(event.button, (counts.get(event.button) ?? 0) - 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 0).map(([button]) => button)
}

// The original CDP error must survive any cleanup: a release that throws
// would displace it and the caller would lose the real failure.
const ORIGINAL_ERROR =
  /^CDP request timeout: Input\.dispatch(Key|Mouse)Event \(id=\d+\)$/

/**
 * Sweep failure indices 1..sweepTo for one dispatching function, one fresh
 * session per index. Indices beyond the function's real dispatch count never
 * fire and act as no-failure controls. Reports leaks (input left held) and
 * contract problems (swallowed original error, spurious rejection/resolve).
 */
async function sweep({ label, kind, run, sweepTo }) {
  const leaks = []
  const problems = []
  for (let failAt = 1; failAt <= sweepTo; failAt++) {
    const { session, keyEvents, mouseEvents, callCount } = makeSession({
      failAt,
    })
    let error = null
    try {
      await run(session)
    } catch (err) {
      error = err
    }
    const failureFired = callCount() >= failAt
    if (failureFired && error === null) {
      problems.push(
        `failAt=${failAt}: ${label} resolved although a dispatch rejected`,
      )
    } else if (
      failureFired &&
      !ORIGINAL_ERROR.test(String(error?.message ?? error))
    ) {
      problems.push(
        `failAt=${failAt}: ${label} rejected with a foreign error (the release path must not displace the original CDP error): ` +
          String(error?.message ?? error),
      )
    } else if (!failureFired && error !== null) {
      problems.push(
        `failAt=${failAt}: ${label} rejected although no dispatch failed: ` +
          String(error?.message ?? error),
      )
    }
    const held = kind === 'key' ? heldKeys(keyEvents) : heldButtons(mouseEvents)
    if (held.length > 0) {
      leaks.push({ failAt, held })
      console.log(
        kind === 'key'
          ? `LEAK ${label} failAt=${failAt} left held: ${held.join(',')}`
          : `LEAK ${label} failAt=${failAt} left button held: ${held.join(',')}`,
      )
    }
  }
  return { leaks, problems }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const failures = []
function check(name, pass, detail = '') {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures.push(name)
}

async function outcome(run) {
  try {
    await run()
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

// bun's node CLI (like bundlers and tsc) resolves the repo-style
// extensionless `./keyboard` import inside mouse.ts natively. A stock V8
// node cannot, so if the first load fails, register a resolve hook that
// retries bare relative specifiers with `.ts` appended, then try once more
// before declaring the modules unloadable.
const RESOLVE_HOOK_SRC = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\\.ts$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`

async function loadModules() {
  try {
    return {
      keyboard: await import(KEYBOARD_URL),
      mouse: await import(MOUSE_URL),
    }
  } catch (firstError) {
    try {
      const { register } = await import('node:module')
      register(
        `data:text/javascript,${encodeURIComponent(RESOLVE_HOOK_SRC)}`,
        import.meta.url,
      )
    } catch {
      throw firstError
    }
    return {
      keyboard: await import(KEYBOARD_URL),
      mouse: await import(MOUSE_URL),
    }
  }
}

// ---------------------------------------------------------------------------
// Main gate
// ---------------------------------------------------------------------------

const COMBO = 'Control+Shift+p'
const PRESS_COMBO_SWEEP_TO = 8 // 6 dispatches on the happy path + 2 no-failure controls
const DRAG_SWEEP_TO = 7 // 4 dispatches on the happy path + 3 no-failure controls

async function main() {
  console.log(`input-release-gate: ${RUNTIME}`)

  let keyboard
  let mouse
  try {
    ;({ keyboard, mouse } = await loadModules())
  } catch (err) {
    console.error('input-release-gate: cannot load the TypeScript input modules.')
    console.error(`runtime: ${RUNTIME}`)
    console.error(`reason: ${err && err.stack ? err.stack : String(err)}`)
    console.error('No check ran, so no pass is printed.')
    process.exit(2)
  }
  if (typeof keyboard.pressCombo !== 'function') {
    console.error('input-release-gate: keyboard.ts loaded but exports no pressCombo function.')
    console.error(`runtime: ${RUNTIME}`)
    console.error('No check ran, so no pass is printed.')
    process.exit(2)
  }
  if (typeof mouse.dispatchDrag !== 'function') {
    console.error('input-release-gate: mouse.ts loaded but exports no dispatchDrag function.')
    console.error(`runtime: ${RUNTIME}`)
    console.error('No check ran, so no pass is printed.')
    process.exit(2)
  }
  console.log(`loaded ${fileURLToPath(KEYBOARD_URL)}`)
  console.log(`loaded ${fileURLToPath(MOUSE_URL)}`)

  // Named check: validation still happens before any dispatch, so an invalid
  // combo rejects with "Unknown key:" even for a session with no Input
  // domain - not with the TypeError a try opened before validation would
  // produce when the cleanup path touched session.Input.
  {
    let pass = false
    let detail = ''
    try {
      await keyboard.pressCombo({}, 'center')
      detail = 'resolved instead of rejecting'
    } catch (err) {
      const message = String(err?.message ?? err)
      if (err instanceof TypeError) {
        detail = `rejected with a TypeError instead of "Unknown key:": ${message}`
      } else if (!message.startsWith('Unknown key:')) {
        detail = `rejected with an unexpected message: ${message}`
      } else {
        pass = true
        detail = `rejected with: ${message.slice(0, 40)}...`
      }
    }
    check(
      'pressCombo({}, "center") rejects with "Unknown key:" and not with a TypeError',
      pass,
      detail,
    )
  }

  // Named check: the success path is unchanged - no extra or duplicated
  // events introduced by the release bookkeeping.
  {
    const { session, keyEvents } = makeSession()
    const r = await outcome(() => keyboard.pressCombo(session, 'Control+a'))
    const shape = keyEvents.map((e) => `${e.type} ${e.key}`)
    const expected = ['keyDown Control', 'keyDown a', 'keyUp a', 'keyUp Control']
    const pass =
      r.ok &&
      shape.length === 4 &&
      expected.every((pair, i) => pair === shape[i]) &&
      heldKeys(keyEvents).length === 0
    check(
      'no-failure path: pressCombo("Control+a") dispatches exactly 4 key events in the unchanged order (modifier down, main down, main up, modifier up)',
      pass,
      r.ok
        ? `dispatched [${shape.join(' | ')}]`
        : `threw: ${String(r.err?.message ?? r.err)}`,
    )
  }
  {
    const { session, mouseEvents } = makeSession()
    const r = await outcome(() =>
      mouse.dispatchDrag(session, { x: 10, y: 20 }, { x: 30, y: 40 }),
    )
    const presses = mouseEvents.filter((e) => e.type === 'mousePressed').length
    const releases = mouseEvents.filter((e) => e.type === 'mouseReleased').length
    const pass =
      r.ok &&
      presses === 1 &&
      releases === 1 &&
      mouseEvents.length === 4 &&
      heldButtons(mouseEvents).length === 0
    check(
      'no-failure path: dispatchDrag dispatches exactly 1 mousePressed and 1 mouseReleased (4 events total, no duplicates)',
      pass,
      r.ok
        ? `${presses} press / ${releases} release / ${mouseEvents.length} events`
        : `threw: ${String(r.err?.message ?? r.err)}`,
    )
  }

  // Sweep every failure index of pressCombo, including inside the modifier
  // loop (failAt=2 is a failure between the Control and Shift keyDowns) and
  // past the last dispatch (the no-failure control).
  console.log(
    `swept ${PRESS_COMBO_SWEEP_TO} failure indices for pressCombo (combo '${COMBO}', 6 dispatches on the happy path; indices 7-${PRESS_COMBO_SWEEP_TO} are no-failure controls)`,
  )
  const pressSweep = await sweep({
    label: 'pressCombo',
    kind: 'key',
    run: (session) => keyboard.pressCombo(session, COMBO),
    sweepTo: PRESS_COMBO_SWEEP_TO,
  })
  check(
    'pressCombo rejects with the original CDP error at every failing index and resolves at every non-failing index',
    pressSweep.problems.length === 0,
    pressSweep.problems.length > 0
      ? pressSweep.problems.join('; ')
      : `checked indices 1..${PRESS_COMBO_SWEEP_TO}`,
  )

  console.log(
    `swept ${DRAG_SWEEP_TO} failure indices for dispatchDrag (4 dispatches on the happy path; indices 5-${DRAG_SWEEP_TO} are no-failure controls)`,
  )
  const dragSweep = await sweep({
    label: 'dispatchDrag',
    kind: 'mouse',
    run: (session) =>
      mouse.dispatchDrag(session, { x: 1, y: 2 }, { x: 3, y: 4 }),
    sweepTo: DRAG_SWEEP_TO,
  })
  check(
    'dispatchDrag rejects with the original CDP error at every failing index and resolves at every non-failing index',
    dragSweep.problems.length === 0,
    dragSweep.problems.length > 0
      ? dragSweep.problems.join('; ')
      : `checked indices 1..${DRAG_SWEEP_TO}`,
  )

  // Named check: releaseHeldInput itself - reverse order, swallows errors,
  // never throws (a throw from a finally would displace the original error).
  if (typeof keyboard.releaseHeldInput !== 'function') {
    check(
      'releaseHeldInput releases in reverse press order, swallows release errors, and never throws',
      false,
      'keyboard.ts does not export a releaseHeldInput function',
    )
  } else {
    const order = []
    const r = await outcome(() =>
      keyboard.releaseHeldInput([
        async () => {
          order.push('first')
        },
        async () => {
          order.push('second')
          throw new Error('planted release failure')
        },
        async () => {
          order.push('third')
        },
      ]),
    )
    const pass = r.ok && order.join(',') === 'third,second,first'
    check(
      'releaseHeldInput releases in reverse press order, swallows release errors, and never throws',
      pass,
      r.ok
        ? `release order [${order.join(' -> ')}]; planted release error swallowed`
        : `threw: ${String(r.err?.message ?? r.err)} (order [${order.join(' -> ')}])`,
    )
  }

  const totalLeaks = pressSweep.leaks.length + dragSweep.leaks.length
  if (totalLeaks === 0 && failures.length === 0) {
    console.log('gate: PASS — no input left held at any failure index')
  } else {
    console.log(
      `gate: FAILED — ${totalLeaks} leak${totalLeaks === 1 ? '' : 's'}, ` +
        `${failures.length} failed check${failures.length === 1 ? '' : 's'}`,
    )
  }
  console.log(`total leaks: ${totalLeaks}`)
  process.exit(totalLeaks === 0 && failures.length === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Self-test: prove the detector can go red, using in-memory stubs only
// ---------------------------------------------------------------------------

// Deliberately leaking stubs modelled on the pre-fix code: every dispatch is
// awaited with no try/finally, so a rejection strands whatever was pressed
// before it. These live only in memory.
async function leakingStubPressCombo(session, combo) {
  const parts = combo.split('+')
  const main = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  for (const mod of modifiers) {
    await session.Input.dispatchKeyEvent({ type: 'keyDown', key: mod })
  }
  await session.Input.dispatchKeyEvent({ type: 'keyDown', key: main })
  await session.Input.dispatchKeyEvent({ type: 'keyUp', key: main })
  for (const mod of modifiers.reverse()) {
    await session.Input.dispatchKeyEvent({ type: 'keyUp', key: mod })
  }
}

async function leakingStubDispatchDrag(session, from, to) {
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: from.x, y: from.y })
  await session.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    clickCount: 1,
  })
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: to.x, y: to.y })
  await session.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    clickCount: 1,
  })
}

// Fixed-shape stubs model the contract the gate enforces: register the
// release before the press, drop it only after a successful release, and
// clean up from a finally that never throws.
async function cleanStubPressCombo(session, combo) {
  const parts = combo.split('+')
  const main = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  const held = []
  const down = async (key) => {
    held.push(key)
    await session.Input.dispatchKeyEvent({ type: 'keyDown', key })
  }
  const up = async (key) => {
    await session.Input.dispatchKeyEvent({ type: 'keyUp', key })
    held.pop()
  }
  try {
    for (const mod of modifiers) await down(mod)
    await down(main)
    await up(main)
    for (const mod of modifiers.reverse()) await up(mod)
  } finally {
    for (const key of held.reverse()) {
      try {
        await session.Input.dispatchKeyEvent({ type: 'keyUp', key })
      } catch {
        // best effort
      }
    }
  }
}

async function cleanStubDispatchDrag(session, from, to) {
  let buttonHeld = false
  try {
    await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: from.x, y: from.y })
    buttonHeld = true
    await session.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
    })
    await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: to.x, y: to.y })
    await session.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      clickCount: 1,
    })
    buttonHeld = false
  } finally {
    if (buttonHeld) {
      try {
        await session.Input.dispatchMouseEvent({
          type: 'mouseReleased',
          x: from.x,
          y: from.y,
          button: 'left',
          clickCount: 1,
        })
      } catch {
        // best effort
      }
    }
  }
}

async function runSelftest() {
  console.log(
    'input-release-gate selftest: in-memory stubs only; no repository file is written, moved, truncated, or otherwise modified',
  )
  console.log(`runtime: ${RUNTIME}`)

  const keyLeak = await sweep({
    label: 'stub:pressCombo(leaking)',
    kind: 'key',
    run: (session) => leakingStubPressCombo(session, COMBO),
    sweepTo: PRESS_COMBO_SWEEP_TO,
  })
  const mouseLeak = await sweep({
    label: 'stub:dispatchDrag(leaking)',
    kind: 'mouse',
    run: (session) =>
      leakingStubDispatchDrag(session, { x: 0, y: 0 }, { x: 1, y: 1 }),
    sweepTo: DRAG_SWEEP_TO,
  })
  const keyClean = await sweep({
    label: 'stub:pressCombo(fixed-shape)',
    kind: 'key',
    run: (session) => cleanStubPressCombo(session, COMBO),
    sweepTo: PRESS_COMBO_SWEEP_TO,
  })
  const mouseClean = await sweep({
    label: 'stub:dispatchDrag(fixed-shape)',
    kind: 'mouse',
    run: (session) =>
      cleanStubDispatchDrag(session, { x: 0, y: 0 }, { x: 1, y: 1 }),
    sweepTo: DRAG_SWEEP_TO,
  })

  const plantedDetected = keyLeak.leaks.length > 0 && mouseLeak.leaks.length > 0
  const cleanIsClean =
    keyClean.leaks.length === 0 &&
    mouseClean.leaks.length === 0 &&
    keyClean.problems.length === 0 &&
    mouseClean.problems.length === 0
  const stubsBehave =
    keyLeak.problems.length === 0 && mouseLeak.problems.length === 0

  if (plantedDetected && cleanIsClean && stubsBehave) {
    console.log(
      `selftest: PASS — the gate DETECTED the planted leaks in the deliberately leaking stub pair ` +
        `(pressCombo stub: ${keyLeak.leaks.length} leaking indices, e.g. failAt=${keyLeak.leaks[0].failAt} left held: ${keyLeak.leaks[0].held.join(',')}; ` +
        `dispatchDrag stub: ${mouseLeak.leaks.length} leaking indices, e.g. failAt=${mouseLeak.leaks[0].failAt} left button held: ${mouseLeak.leaks[0].held.join(',')}) ` +
        `and reported 0 leaks for the fixed-shape stubs, so the detector can go red and is not passing vacuously`,
    )
    process.exit(0)
  }
  console.error(
    `selftest: FAIL — expected the planted leaks to be detected; ` +
      `leaking pressCombo stub leaks: ${keyLeak.leaks.length}, leaking dispatchDrag stub leaks: ${mouseLeak.leaks.length}, ` +
      `fixed-shape stub leaks: ${keyClean.leaks.length + mouseClean.leaks.length}, ` +
      `stub contract problems: ${keyLeak.problems.length + mouseLeak.problems.length + keyClean.problems.length + mouseClean.problems.length}`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------

if (process.argv.slice(2).includes('--selftest')) {
  await runSelftest()
} else {
  await main()
}
