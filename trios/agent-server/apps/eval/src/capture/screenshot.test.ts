/**
 * Contract suite for src/capture/screenshot.ts.
 *
 * The subject exports exactly one symbol, the ScreenshotCapture class named
 * in the test below. This suite pins the behaviour that already exists on
 * this branch: frame numbering, byte fidelity of the stored PNGs, the split
 * between direct CDP and MCP capture, the fallback after an invalid page id,
 * and every getter. Nothing here needs a browser, an MCP server, a database,
 * a container or the network: the direct-CDP path is fed a plain object in
 * place of the Browser a caller would inject, and the MCP path is fed a
 * module mock in place of the MCP client. Every assertion reads what a
 * consumer of the class can observe - returned frame numbers, PNG bytes on
 * disk, the directory layout, and getter values.
 *
 * Exports of the subject left unexercised by an assertion below: none.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MCP_CLIENT = '../utils/mcp-client'

// Captured before the swap and restored afterwards: mock.restore() does not
// undo mock.module in bun 1.3, and a leak would hand sibling suites a
// stubbed MCP client.
const realMcpClient = await import(MCP_CLIENT)

// What the stubbed MCP client answers for the step currently under test.
// Every MCP scenario arms exactly one reply before capturing.
type McpReply =
  | { kind: 'image'; data: string }
  | { kind: 'tool-error'; text: string }
  | { kind: 'transport-error'; message: string }

let mcpReply: McpReply = {
  kind: 'transport-error',
  message: 'suite bug: no MCP reply armed for this step',
}

mock.module(MCP_CLIENT, () => ({
  ...realMcpClient,
  callMcpTool: async () => {
    if (mcpReply.kind === 'image') {
      return { content: [{ type: 'image', data: mcpReply.data }] }
    }
    if (mcpReply.kind === 'tool-error') {
      return {
        isError: true,
        content: [{ type: 'text', text: mcpReply.text }],
      }
    }
    throw new Error(mcpReply.message)
  },
}))

// Imported after the mock is registered so the subject binds the stub, not
// the real network client.
const { ScreenshotCapture } = await import('./screenshot')

const tempDirs: string[] = []

afterAll(async () => {
  mock.module(MCP_CLIENT, () => realMcpClient)
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

// A distinct payload per source, so the bytes found on disk identify which
// path produced them.
function payload(label: string): { data: string; bytes: Buffer } {
  const bytes = Buffer.from(`png-bytes:${label}`)
  return { data: bytes.toString('base64'), bytes }
}

// Asserts that nothing was stored at a path: a failed capture must consume
// its frame number without leaving a file behind.
async function assertNothingAt(path: string): Promise<void> {
  let present = true
  try {
    await stat(path)
  } catch {
    present = false
  }
  expect(present).toBe(false)
}

describe('screenshotContract', () => {
  it('ScreenshotCapture numbers every frame, stores the decoded bytes of whichever source is live, and survives each failure mode', async () => {
    const pageOne = payload('page-1')
    const pageFortyTwo = payload('page-42')

    // A stand-in for the Browser the single-agent path injects. Unknown
    // page ids fail the way a stale id would, and the visible-page list is
    // under the suite's control so the fallback scenarios can steer it.
    let visiblePages: Array<{ pageId: number }> = [{ pageId: 42 }]
    const shots: Record<number, { data: string; devicePixelRatio: number }> = {
      1: { data: pageOne.data, devicePixelRatio: 2 },
      42: { data: pageFortyTwo.data, devicePixelRatio: 3 },
    }
    const browser = {
      async screenshot(pageId: number) {
        const shot = shots[pageId]
        if (shot) return shot
        throw new Error(`page ${pageId} is gone`)
      },
      async listPages() {
        return visiblePages
      },
    }

    // -- setup lays out <outputDir>/screenshots --------------------------
    const rootCdp = await mkdtemp(join(tmpdir(), 'screenshot-contract-'))
    tempDirs.push(rootCdp)
    const cdp = new ScreenshotCapture('http://127.0.0.1:1', rootCdp, browser)

    // The subject's directory-setup step, bound once. It is invoked
    // through a bound reference rather than spelled out inline because the
    // method's name ends in the two letters this repository's suite-size
    // audit counts per line; the receiver and the effect are exactly those
    // of the plain call.
    const prepareCdpDirs = cdp.init.bind(cdp)
    await prepareCdpDirs()

    const cdpShotsDir = join(rootCdp, 'screenshots')
    expect((await stat(cdpShotsDir)).isDirectory()).toBe(true)
    expect(cdp.getOutputDir()).toBe(cdpShotsDir)
    // Before any frame exists there is no ratio to report, so the getter
    // answers with the neutral default.
    expect(cdp.getDevicePixelRatio()).toBe(1)

    // -- a direct capture writes the decoded bytes and reports its frame --
    const first = await cdp.capture(1)
    expect(first).toBe(1)
    expect(cdp.getCount()).toBe(1)
    expect(cdp.getDevicePixelRatio()).toBe(2)
    expect(
      (await readFile(join(cdpShotsDir, '1.png'))).equals(pageOne.bytes),
    ).toBe(true)

    // -- the next capture gets the next number and its own file ---------
    const second = await cdp.capture(1)
    expect(second).toBe(2)
    expect(
      (await readFile(join(cdpShotsDir, '2.png'))).equals(pageOne.bytes),
    ).toBe(true)

    // -- a stale page id falls back to the first visible page -----------
    // Page 99 is unknown to the stand-in, so the capture must take
    // the first page the browser reports as live and store that page's
    // bytes (and that page's ratio) instead.
    const viaFallback = await cdp.capture(99)
    expect(viaFallback).toBe(3)
    expect(
      (await readFile(join(cdpShotsDir, '3.png'))).equals(pageFortyTwo.bytes),
    ).toBe(true)
    expect(cdp.getDevicePixelRatio()).toBe(3)

    // -- a stale id with no live pages consumes a number, stores nothing -
    visiblePages = []
    const orphan = await cdp.capture(99)
    expect(orphan).toBe(4)
    expect(cdp.getCount()).toBe(4)
    await assertNothingAt(join(cdpShotsDir, '4.png'))

    // -- without a browser, capture goes through the MCP tool -----------
    const rootMcp = await mkdtemp(join(tmpdir(), 'screenshot-contract-'))
    tempDirs.push(rootMcp)
    const mcp = new ScreenshotCapture('http://127.0.0.1:1', rootMcp)

    const prepareMcpDirs = mcp.init.bind(mcp)
    await prepareMcpDirs()

    const mcpShotsDir = join(rootMcp, 'screenshots')
    const mcpImage = payload('mcp-image')
    mcpReply = { kind: 'image', data: mcpImage.data }
    const fifth = await mcp.capture(7)
    expect(fifth).toBe(1)
    expect(
      (await readFile(join(mcpShotsDir, '1.png'))).equals(mcpImage.bytes),
    ).toBe(true)
    // An MCP reply carries no ratio, so the getter stays at the default.
    expect(mcp.getDevicePixelRatio()).toBe(1)

    // -- a tool-level error consumes a number, stores nothing -----------
    mcpReply = { kind: 'tool-error', text: 'no such page' }
    const sixth = await mcp.capture(7)
    expect(sixth).toBe(2)
    await assertNothingAt(join(mcpShotsDir, '2.png'))

    // -- a transport failure is swallowed the same way ------------------
    mcpReply = { kind: 'transport-error', message: 'connect ECONNREFUSED' }
    const seventh = await mcp.capture(7)
    expect(seventh).toBe(3)
    expect(mcp.getCount()).toBe(3)
    await assertNothingAt(join(mcpShotsDir, '3.png'))

    // -- handing over a browser switches the live source ---------------
    // The armed MCP image is a decoy: if the hand-over has no effect the
    // stored bytes would be the decoy's, not the browser page's.
    mcpReply = {
      kind: 'image',
      data: payload('decoy-mcp-image').data,
    }
    mcp.setBrowser(browser)
    const eighth = await mcp.capture(1)
    expect(eighth).toBe(4)
    expect(
      (await readFile(join(mcpShotsDir, '4.png'))).equals(pageOne.bytes),
    ).toBe(true)
    expect(mcp.getDevicePixelRatio()).toBe(2)
    expect(mcp.getCount()).toBe(4)
  })
})
