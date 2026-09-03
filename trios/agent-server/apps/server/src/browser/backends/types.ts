import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'

export interface CdpBackend extends ProtocolApi {
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  getTargets(): Promise<CdpTarget[]>
  session(sessionId: string): ProtocolApi
  onSessionEvent(
    event: string,
    handler: (params: unknown, sessionId: string) => void,
  ): () => void
  /**
   * Reconnect notification (trios#1368).
   *
   * The backend reconnects its WebSocket on its own. A new socket means
   * Chrome issued new session ids, and every id from the previous
   * connection is dead — the socket that would have delivered
   * `Target.detachedFromTarget` is the one that died. This notification
   * fires exactly once after the backend's own recovery machinery has
   * established a new connection following an unexpected close, so
   * consumers can drop every connection-scoped cache they hold.
   *
   * Returns an unsubscribe function; long-lived consumers MUST call it on
   * teardown or handlers accumulate — a slower version of this same defect.
   */
  onReconnected(handler: () => void): () => void
}

export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  tabId?: number
  windowId?: number
}
