/**
 * Contract suite for the single export of ./browseros-app-manager.ts:
 * the BrowserOSAppManager class.
 *
 * Everything below pins behaviour that already exists, with no live
 * BrowserOS build, no database, no container and no network:
 *
 *   - per-worker port derivation (constructor + getPorts + getServerUrl)
 *   - isAppRunning() reporting false while nothing holds the manager's ports
 *   - killApp() completing cleanly for a never-started manager
 *   - restart() giving up after its three attempts and throwing the
 *     documented error when the app binary cannot be launched
 *   - the patchNopechaApiKey() guard path when the extension is absent
 *
 * Behaviour that could not be pinned, and the dependency that blocked it:
 *
 *   - restart()'s success path, and everything startAll does once the
 *     browser process appears (waiting for the CDP /json/version endpoint,
 *     launching @browseros/server, waiting for its /health endpoint):
 *     needs a live BrowserOS build answering on localhost. Only the
 *     give-up half of restart is pinned here, by steering
 *     BROWSEROS_BINARY at a path that cannot exist.
 *   - isAppRunning()'s positive answer, and killApp()'s force-kill of
 *     processes squatting on the manager's ports: the class probes ports
 *     through `lsof`, which this environment does not provide, and the
 *     positive case would also need a live listener on the port.
 *   - patchNopechaApiKey()'s write path: CAPTCHA_EXT_DIR is fixed
 *     relative to the module and cannot be pointed elsewhere, and writing
 *     the real NopeCHA manifest would touch files outside this suite's
 *     permitted boundary.
 *
 * The subject is imported through a variable with a query string, so a
 * fresh module instance is guaranteed to observe the steered
 * BROWSEROS_BINARY no matter what any other suite loaded earlier in the
 * same test process. The environment is restored when the test ends.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalPorts } from './browseros-app-manager'

const HERE = dirname(fileURLToPath(import.meta.url))

// A path no machine provides. Steering BROWSEROS_BINARY here before the
// fresh import makes restart() walk its three failed attempts without
// ever launching a real browser.
const UNLAUNCHABLE_BINARY = '/nonexistent-browseros-binary-for-contract-suite'
const MODULE_WITH_QUERY = './browseros-app-manager?contract-suite-fresh'

const BASE: EvalPorts = { cdp: 49777, server: 49787, extension: 49797 }
const WORKER_INDEX = 7

/** Fail loudly when some other process already holds one of the ports. */
function assertNothingHolds(ports: EvalPorts): Promise<void> {
  return Promise.all(
    (['cdp', 'server', 'extension'] as const).map(
      (key) =>
        new Promise<void>((resolve, reject) => {
          const probe = createServer(() => {})
          probe.once('error', (err: Error) =>
            reject(
              new Error(
                `precondition failed: port ${ports[key]} already in use` +
                  ` (${(err as Error & { code?: string }).code})`,
              ),
            ),
          )
          probe.listen(ports[key], '127.0.0.1', () =>
            probe.close(() => resolve()),
          )
        }),
    ),
  ).then(() => undefined)
}

describe('browserosAppManagerContract', () => {
  it(
    'pins the BrowserOSAppManager export as it stands today',
    async () => {
      const savedBinary = process.env.BROWSEROS_BINARY
      process.env.BROWSEROS_BINARY = UNLAUNCHABLE_BINARY
      try {
        const managerModule = (await import(
          MODULE_WITH_QUERY
        )) as typeof import('./browseros-app-manager')
        const { BrowserOSAppManager } = managerModule

        // --- port derivation: defaults, custom bases, worker offsets ---
        const defaults = new BrowserOSAppManager()
        expect(defaults.getPorts()).toEqual({
          cdp: 9010,
          server: 9110,
          extension: 9310,
        } satisfies EvalPorts)
        expect(defaults.getServerUrl()).toBe('http://127.0.0.1:9110')

        const lead = new BrowserOSAppManager(0, BASE)
        expect(lead.getPorts()).toEqual(BASE satisfies EvalPorts)

        const worker = new BrowserOSAppManager(WORKER_INDEX, BASE)
        expect(worker.getPorts()).toEqual({
          cdp: BASE.cdp + WORKER_INDEX,
          server: BASE.server + WORKER_INDEX,
          extension: BASE.extension + WORKER_INDEX,
        } satisfies EvalPorts)
        expect(worker.getServerUrl()).toBe(
          `http://127.0.0.1:${BASE.server + WORKER_INDEX}`,
        )

        // --- isAppRunning: nothing holds these ports, and the manager
        // --- reports exactly that
        await assertNothingHolds(worker.getPorts())
        expect(worker.isAppRunning()).toBe(false)

        // --- killApp: safe on a manager that never started ---
        await worker.killApp()
        expect(worker.isAppRunning()).toBe(false)

        // --- restart: three attempts against an unlaunchable binary,
        // --- then the documented give-up
        await expect(worker.restart()).rejects.toThrow(
          'Failed to start BrowserOS after 3 attempts',
        )
        // a failed restart leaves the manager killable and its ports free
        await worker.killApp()
        expect(worker.isAppRunning()).toBe(false)

        // --- patchNopechaApiKey: guard path when no extension ships ---
        const extDir = join(HERE, '../extensions/nopecha')
        // precondition: this tree carries no NopeCHA extension; failing
        // here is safer than ever writing outside this suite's boundary
        expect(existsSync(extDir)).toBe(false)
        expect(() =>
          BrowserOSAppManager.patchNopechaApiKey('contract-suite-key'),
        ).not.toThrow()
        expect(existsSync(join(extDir, 'manifest.json'))).toBe(false)
      } finally {
        if (savedBinary === undefined) delete process.env.BROWSEROS_BINARY
        else process.env.BROWSEROS_BINARY = savedBinary
      }
    },
    30000,
  )
})
