/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * First suite for src/browser/console-collector.ts.
 *
 * The module exports one symbol, the ConsoleCollector class, and the whole
 * of its behaviour is observable without a live dependency: the constructor
 * only needs a CDP backend that accepts session-event subscriptions, which
 * the stand-in below provides while recording the handlers it registers.
 * Every event the collector subscribes to is delivered by hand with a chosen
 * session id, and the outcome is read back through attach / detach / getLogs
 * - the same surface browser.ts drives. No export had to be left out, so
 * there is no export whose behaviour is blocked by a live dependency, and
 * the suite needs no network, no database and no container.
 */

import { describe, expect, it } from 'bun:test'
import { CONTENT_LIMITS } from '@browseros/shared/constants/limits'
import type { CdpBackend } from '../../src/browser/backends/types'
import { ConsoleCollector } from '../../src/browser/console-collector'

type SessionHandler = (params: unknown, sessionId: string) => void

/**
 * A stand-in for the CDP backend. The collector only touches onSessionEvent,
 * so the stand-in records what the constructor registers and offers a way to
 * deliver an event with the session id of the caller's choosing.
 */
function fakeCdp(): CdpBackend & {
  dispatch: (event: string, params: unknown, sessionId: string) => void
} {
  const handlers = new Map<string, SessionHandler>()
  return {
    onSessionEvent: (event: string, handler: SessionHandler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    dispatch: (event: string, params: unknown, sessionId: string) => {
      handlers.get(event)?.(params, sessionId)
    },
  } as unknown as CdpBackend & {
    dispatch: (event: string, params: unknown, sessionId: string) => void
  }
}

const CONSOLE_API = 'Runtime.consoleAPICalled'
const EXCEPTION_THROWN = 'Runtime.exceptionThrown'
const LOG_ENTRY_ADDED = 'Log.entryAdded'
const FRAME_NAVIGATED = 'Page.frameNavigated'

// A console-API call carrying one string argument.
const stringCall = (type: string, text: string, timestamp: number) => ({
  type,
  args: [{ type: 'string', value: text }],
  timestamp,
})

describe('consoleCollectorContract', () => {
  it('ConsoleCollector buffers console, exception and browser messages per page and answers filtered reads', () => {
    const cdp = fakeCdp()
    const collector = new ConsoleCollector(cdp)

    // An event from a session nobody attached lands nowhere: no buffer
    // grows, and a read of a never-attached page is an empty answer, not an
    // error.
    cdp.dispatch(
      CONSOLE_API,
      stringCall('error', 'orphan', 1),
      'session-nobody',
    )
    expect(collector.getLogs(99)).toEqual({ entries: [], totalCount: 0 })

    // Console-API calls: the type maps to a level, the arguments are
    // serialized into one line of text, and the top stack frame becomes the
    // origin.
    collector.attach(1, 'session-1')
    cdp.dispatch(
      CONSOLE_API,
      {
        type: 'log',
        args: [
          { type: 'string', value: 'plain' },
          { type: 'number', value: 42 },
          { type: 'object', description: '{ a: 1 }' },
          { type: 'symbol' },
        ],
        timestamp: 1_111,
        stackTrace: {
          callFrames: [{ url: 'https://page.example/app.js', lineNumber: 17 }],
        },
      },
      'session-1',
    )
    expect(collector.getLogs(1, { level: 'debug' }).entries[0]).toEqual({
      source: 'console',
      level: 'info',
      text: 'plain 42 { a: 1 } [symbol]',
      url: 'https://page.example/app.js',
      lineNumber: 17,
      timestamp: 1_111,
    })

    const typeToLevel: Array<[string, string]> = [
      ['error', 'error'],
      ['assert', 'error'],
      ['warning', 'warning'],
      ['log', 'info'],
      ['debug', 'debug'],
      ['trace', 'debug'],
      ['timeStamp', 'info'], // not in the map: falls back to info
    ]
    for (const [type, level] of typeToLevel) {
      cdp.dispatch(
        CONSOLE_API,
        stringCall(type, `from ${type}`, 2_000),
        'session-1',
      )
      const last = collector.getLogs(1, { level: 'debug', limit: 1 }).entries[0]
      expect(last?.source).toBe('console')
      expect(last?.level).toBe(level)
      expect(last?.text).toBe(`from ${type}`)
    }

    // The default read is level info, so debug entries are held in the
    // buffer but hidden from that read; error and warning stay visible.
    expect(collector.getLogs(1, { level: 'debug' }).totalCount).toBe(8)
    expect(collector.getLogs(1).totalCount).toBe(6)
    expect(collector.getLogs(1).entries.map((e) => e.level)).toEqual([
      'info',
      'error',
      'error',
      'warning',
      'info',
      'info',
    ])
    expect(collector.getLogs(1, { level: 'error' }).totalCount).toBe(2)

    // Exceptions land on the owning page as error entries: the exception's
    // description wins over the bare text, and the url falls back from the
    // details to the top stack frame.
    collector.attach(2, 'session-2')
    cdp.dispatch(
      EXCEPTION_THROWN,
      {
        timestamp: 3_000,
        exceptionDetails: {
          text: 'fallback text',
          lineNumber: 9,
          stackTrace: { callFrames: [{ url: 'https://frame.example/lib.js' }] },
          exception: {
            type: 'object',
            description: 'Error: boom\n    at lib.js',
          },
        },
      },
      'session-2',
    )
    expect(collector.getLogs(2, { level: 'error' }).entries[0]).toEqual({
      source: 'exception',
      level: 'error',
      text: 'Error: boom\n    at lib.js',
      url: 'https://frame.example/lib.js',
      lineNumber: 9,
      timestamp: 3_000,
    })

    // Without an exception object the bare text is the message and the
    // details' own url is used. Page buffers stay isolated: page 2's errors
    // did not leak into page 1's error count.
    cdp.dispatch(
      EXCEPTION_THROWN,
      {
        timestamp: 3_001,
        exceptionDetails: {
          text: 'Uncaught',
          url: 'https://page.example/b.js',
          lineNumber: 3,
        },
      },
      'session-2',
    )
    const exceptions = collector.getLogs(2, { level: 'error' }).entries
    expect(exceptions).toHaveLength(2)
    expect(exceptions[1]).toEqual({
      source: 'exception',
      level: 'error',
      text: 'Uncaught',
      url: 'https://page.example/b.js',
      lineNumber: 3,
      timestamp: 3_001,
    })
    expect(collector.getLogs(1, { level: 'error' }).totalCount).toBe(2)

    // Browser log entries land with source browser and their level mapped:
    // verbose reads as debug, anything unmapped reads as info.
    collector.attach(3, 'session-3')
    const entryLevels: Array<[string, string]> = [
      ['error', 'error'],
      ['warning', 'warning'],
      ['info', 'info'],
      ['verbose', 'debug'],
      ['weird', 'info'], // not in the map: falls back to info
    ]
    for (const [level] of entryLevels) {
      cdp.dispatch(
        LOG_ENTRY_ADDED,
        {
          entry: {
            level,
            text: `entry ${level}`,
            url: 'https://page.example',
            lineNumber: 5,
            timestamp: 4_000,
          },
        },
        'session-3',
      )
    }
    const browserEntries = collector.getLogs(3, { level: 'debug' }).entries
    expect(browserEntries).toHaveLength(5)
    expect(browserEntries.map((e) => [e.source, e.level])).toEqual([
      ['browser', 'error'],
      ['browser', 'warning'],
      ['browser', 'info'],
      ['browser', 'debug'],
      ['browser', 'info'],
    ])
    expect(browserEntries[0]).toMatchObject({
      text: 'entry error',
      url: 'https://page.example',
      lineNumber: 5,
      timestamp: 4_000,
    })

    // A main-frame navigation empties the page's buffer...
    cdp.dispatch(FRAME_NAVIGATED, { frame: { id: 'main' } }, 'session-3')
    expect(collector.getLogs(3, { level: 'debug' })).toEqual({
      entries: [],
      totalCount: 0,
    })

    // ...while a child-frame navigation leaves it alone.
    cdp.dispatch(
      LOG_ENTRY_ADDED,
      { entry: { level: 'error', text: 'kept', timestamp: 4_100 } },
      'session-3',
    )
    cdp.dispatch(
      FRAME_NAVIGATED,
      { frame: { id: 'child', parentId: 'main' } },
      'session-3',
    )
    expect(
      collector.getLogs(3, { level: 'debug' }).entries.map((e) => e.text),
    ).toEqual(['kept'])

    // Reads: the default answer is the most recent CONSOLE_DEFAULT_LIMIT
    // entries of everything the info filter matched, with the full filtered
    // count reported alongside.
    collector.attach(4, 'session-4')
    for (let i = 0; i < 61; i++) {
      cdp.dispatch(
        CONSOLE_API,
        stringCall('log', `entry ${i}`, 5_000 + i),
        'session-4',
      )
    }
    const defaultRead = collector.getLogs(4)
    expect(defaultRead.totalCount).toBe(61)
    expect(defaultRead.entries).toHaveLength(
      CONTENT_LIMITS.CONSOLE_DEFAULT_LIMIT,
    )
    expect(defaultRead.entries[0]?.text).toBe('entry 11')
    expect(defaultRead.entries.at(-1)?.text).toBe('entry 60')

    // An explicit limit answers with the most recent entries up to that
    // limit, while the count still reports every match.
    const limited = collector.getLogs(4, { limit: 3 })
    expect(limited.totalCount).toBe(61)
    expect(limited.entries.map((e) => e.text)).toEqual([
      'entry 58',
      'entry 59',
      'entry 60',
    ])

    // Search is a case-insensitive substring match over the entry text.
    cdp.dispatch(
      CONSOLE_API,
      stringCall('log', 'MiXeD CaSe NeEdLe', 6_000),
      'session-4',
    )
    const found = collector.getLogs(4, { search: 'mixed case needle' })
    expect(found.totalCount).toBe(1)
    expect(found.entries[0]?.text).toBe('MiXeD CaSe NeEdLe')
    expect(collector.getLogs(4, { search: 'nothing matches' }).totalCount).toBe(
      0,
    )

    // A limit above the ceiling is clamped down to the ceiling.
    for (let i = 0; i < 250; i++) {
      cdp.dispatch(
        CONSOLE_API,
        stringCall('log', `bulk ${i}`, 7_000 + i),
        'session-4',
      )
    }
    const clamped = collector.getLogs(4, { limit: 999_999 })
    expect(clamped.totalCount).toBe(312)
    expect(clamped.entries).toHaveLength(CONTENT_LIMITS.CONSOLE_MAX_LIMIT)
    expect(clamped.entries.at(-1)?.text).toBe('bulk 249')

    // clear hands back the filtered answer and then empties the buffer.
    const cleared = collector.getLogs(4, { limit: 1, clear: true })
    expect(cleared.entries.map((e) => e.text)).toEqual(['bulk 249'])
    expect(collector.getLogs(4, { level: 'debug' })).toEqual({
      entries: [],
      totalCount: 0,
    })

    // The buffer is bounded: once CONSOLE_BUFFER_MAX_ENTRIES have
    // accumulated, every further add drops the oldest entry first.
    collector.attach(5, 'session-5')
    const overflow = CONTENT_LIMITS.CONSOLE_BUFFER_MAX_ENTRIES + 5
    for (let i = 0; i < overflow; i++) {
      cdp.dispatch(
        CONSOLE_API,
        stringCall('log', `row ${i}`, 8_000 + i),
        'session-5',
      )
    }
    const evicted = collector.getLogs(5, { level: 'debug', limit: 999_999 })
    expect(evicted.totalCount).toBe(CONTENT_LIMITS.CONSOLE_BUFFER_MAX_ENTRIES)
    expect(evicted.entries[0]?.text).toBe(
      `row ${overflow - CONTENT_LIMITS.CONSOLE_MAX_LIMIT}`,
    )

    // Re-attaching a page under a new session id retires the old session:
    // events from it stop landing, and the buffer built so far survives.
    collector.attach(6, 'session-6')
    cdp.dispatch(
      CONSOLE_API,
      stringCall('log', 'old session', 9_000),
      'session-6',
    )
    collector.attach(6, 'session-6b')
    cdp.dispatch(
      CONSOLE_API,
      stringCall('log', 'old session again', 9_001),
      'session-6',
    )
    expect(
      collector.getLogs(6, { level: 'debug', search: 'old session' })
        .totalCount,
    ).toBe(1)
    cdp.dispatch(
      CONSOLE_API,
      stringCall('log', 'new session', 9_002),
      'session-6b',
    )
    expect(
      collector.getLogs(6, { level: 'debug' }).entries.map((e) => e.text),
    ).toEqual(['old session', 'new session'])

    // detach retires the session and drops the buffer: later events for
    // that page land nowhere, and the read is empty rather than an error.
    collector.detach(6)
    cdp.dispatch(
      CONSOLE_API,
      stringCall('log', 'after detach', 9_003),
      'session-6b',
    )
    expect(collector.getLogs(6, { level: 'debug' })).toEqual({
      entries: [],
      totalCount: 0,
    })
  })
})
