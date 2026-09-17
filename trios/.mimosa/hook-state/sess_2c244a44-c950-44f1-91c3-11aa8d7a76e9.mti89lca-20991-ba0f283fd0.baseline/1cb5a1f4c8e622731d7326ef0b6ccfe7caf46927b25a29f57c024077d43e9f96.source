import type { EntryAddedEvent } from '@browseros/cdp-protocol/domains/log'
import type {
  ConsoleAPICalledEvent,
  ExceptionThrownEvent,
  RemoteObject,
} from '@browseros/cdp-protocol/domains/runtime'
import { CONTENT_LIMITS } from '@browseros/shared/constants/limits'
import type { CdpBackend } from './backends/types'

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug'

export interface ConsoleEntry {
  source: 'console' | 'exception' | 'browser'
  level: ConsoleLevel
  text: string
  url?: string
  lineNumber?: number
  timestamp: number
}

export interface GetConsoleLogsOptions {
  level?: ConsoleLevel
  search?: string
  limit?: number
  clear?: boolean
}

export interface GetConsoleLogsResult {
  entries: ConsoleEntry[]
  totalCount: number
}

// Lower number = higher severity
const LEVEL_PRIORITY: Record<ConsoleLevel, number> = {
  error: 0,
  warning: 1,
  info: 2,
  debug: 3,
}

const CONSOLE_TYPE_TO_LEVEL: Record<string, ConsoleLevel> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  log: 'info',
  info: 'info',
  dir: 'info',
  dirxml: 'info',
  table: 'info',
  count: 'info',
  timeEnd: 'info',
  debug: 'debug',
  trace: 'debug',
  clear: 'debug',
  startGroup: 'debug',
  startGroupCollapsed: 'debug',
  endGroup: 'debug',
  profile: 'debug',
  profileEnd: 'debug',
}

const LOG_LEVEL_MAP: Record<string, ConsoleLevel> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  verbose: 'debug',
}

export class ConsoleCollector {
  private readonly buffers = new Map<number, ConsoleEntry[]>()
  private readonly sessionToPage = new Map<string, number>()
  private readonly pageToSession = new Map<number, string>()
  private readonly maxEntries = CONTENT_LIMITS.CONSOLE_BUFFER_MAX_ENTRIES

  constructor(cdp: CdpBackend) {
    // Single handler per event type — O(1) routing via sessionToPage lookup
    cdp.onSessionEvent('Runtime.consoleAPICalled', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return
      this.handleConsoleAPI(pageId, params as ConsoleAPICalledEvent)
    })

    cdp.onSessionEvent('Runtime.exceptionThrown', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return
      this.handleException(pageId, params as ExceptionThrownEvent)
    })

    cdp.onSessionEvent('Log.entryAdded', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return
      this.handleLogEntry(pageId, params as EntryAddedEvent)
    })

    // Clear buffer on main-frame navigation
    cdp.onSessionEvent('Page.frameNavigated', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return
      const frame = (params as { frame: { parentId?: string } }).frame
      if (!frame.parentId) {
        this.buffers.set(pageId, [])
      }
    })
  }

  attach(pageId: number, sessionId: string): void {
    if (!this.buffers.has(pageId)) {
      this.buffers.set(pageId, [])
    }
    // Clean up old session mapping if session changed (re-attach after detach)
    const oldSession = this.pageToSession.get(pageId)
    if (oldSession && oldSession !== sessionId) {
      this.sessionToPage.delete(oldSession)
    }
    this.sessionToPage.set(sessionId, pageId)
    this.pageToSession.set(pageId, sessionId)
  }

  detach(pageId: number): void {
    const sessionId = this.pageToSession.get(pageId)
    if (sessionId) this.sessionToPage.delete(sessionId)
    this.pageToSession.delete(pageId)
    this.buffers.delete(pageId)
  }

  getLogs(pageId: number, opts?: GetConsoleLogsOptions): GetConsoleLogsResult {
    const buffer = this.buffers.get(pageId) ?? []
    const levelThreshold = LEVEL_PRIORITY[opts?.level ?? 'info']

    // Filter by level
    let filtered = buffer.filter(
      (e) => LEVEL_PRIORITY[e.level] <= levelThreshold,
    )

    // Filter by search text
    if (opts?.search) {
      const term = opts.search.toLowerCase()
      filtered = filtered.filter((e) => e.text.toLowerCase().includes(term))
    }

    // Return most recent entries up to limit
    const totalCount = filtered.length
    const limit = Math.min(
      opts?.limit ?? CONTENT_LIMITS.CONSOLE_DEFAULT_LIMIT,
      CONTENT_LIMITS.CONSOLE_MAX_LIMIT,
    )
    const entries = filtered.slice(-limit)

    if (opts?.clear) {
      this.buffers.set(pageId, [])
    }

    return { entries, totalCount }
  }

  private addEntry(pageId: number, entry: ConsoleEntry): void {
    const buffer = this.buffers.get(pageId)
    if (!buffer) return

    // FIFO eviction when buffer is full
    if (buffer.length >= this.maxEntries) {
      buffer.shift()
    }
    buffer.push(entry)
  }

  private handleConsoleAPI(pageId: number, event: ConsoleAPICalledEvent): void {
    const level = CONSOLE_TYPE_TO_LEVEL[event.type] ?? 'info'
    const text = serializeArgs(event.args)
    const frame = event.stackTrace?.callFrames[0]

    this.addEntry(pageId, {
      source: 'console',
      level,
      text,
      url: frame?.url,
      lineNumber: frame?.lineNumber,
      timestamp: event.timestamp,
    })
  }

  private handleException(pageId: number, event: ExceptionThrownEvent): void {
    const details = event.exceptionDetails
    const text = details.exception?.description ?? details.text

    this.addEntry(pageId, {
      source: 'exception',
      level: 'error',
      text,
      url: details.url ?? details.stackTrace?.callFrames[0]?.url,
      lineNumber: details.lineNumber,
      timestamp: event.timestamp,
    })
  }

  private handleLogEntry(pageId: number, event: EntryAddedEvent): void {
    const entry = event.entry
    const level = LOG_LEVEL_MAP[entry.level] ?? 'info'

    this.addEntry(pageId, {
      source: 'browser',
      level,
      text: entry.text,
      url: entry.url,
      lineNumber: entry.lineNumber,
      timestamp: entry.timestamp,
    })
  }
}

function serializeArgs(args: RemoteObject[]): string {
  return args
    .map((arg) => {
      if (arg.type === 'string') return arg.value as string
      if (arg.value !== undefined) return String(arg.value)
      return arg.description ?? `[${arg.type}]`
    })
    .join(' ')
}
