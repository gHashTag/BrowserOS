/**
 * @public
 */
export interface TRIOSSuggestion {
  mode: 'chat' | 'agent'
  message: string
}

/**
 * @public
 */
export const useTRIOSSuggestions = ({
  query,
}: {
  query: string
}): TRIOSSuggestion[] => {
  return [
    {
      mode: 'agent',
      message: query,
    },
  ]
}
