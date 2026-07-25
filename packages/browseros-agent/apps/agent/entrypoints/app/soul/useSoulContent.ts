import { useQuery } from '@tanstack/react-query'
import { useRpcClient } from '@/lib/rpc/RpcClientProvider'

export const SOUL_QUERY_KEY = 'soul'

export function useSoulContent() {
  const rpcClient = useRpcClient()

  const { data, isLoading, error, refetch } = useQuery<string, Error>({
    queryKey: [SOUL_QUERY_KEY],
    queryFn: async () => {
      const response = await rpcClient.soul.$get({})
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // The typed Hono AppType died with the TS server (see getClient.ts),
      // so the payload shape is asserted here — the Rust trios-server keeps
      // the same wire contract ({ content }).
      const result = (await response.json()) as { content?: string }
      return result.content || ''
    },
  })

  return {
    content: data ?? null,
    isLoading,
    error,
    refetch,
  }
}
