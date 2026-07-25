import { hc } from 'hono/client'
import { getAgentServerUrl } from '../browseros/helpers'

// The typed Hono AppType died with the TS server: the HTTP contract is now
// served by the Rust trios-server (gHashTag/trios), which passes the same
// wire-contract e2e suite. hc<any> keeps the runtime behaviour unchanged.
// biome-ignore lint/suspicious/noExplicitAny: the typed Hono AppType was removed with the TS server
type AppType = any

export type RpcClient = ReturnType<typeof hc<AppType>>

let clientPromise: Promise<RpcClient> | null = null

export const getClient = (): Promise<RpcClient> => {
  if (!clientPromise) {
    clientPromise = getAgentServerUrl().then((serverUrl) =>
      hc<AppType>(serverUrl),
    )
  }
  return clientPromise
}

// Pre-resolve the client immediately when the module is imported
getClient()
