import { magicLinkClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { env } from '../env'

export const { signIn, signUp, signOut, useSession } = createAuthClient({
  baseURL: env.VITE_PUBLIC_trios_API,
  plugins: [magicLinkClient()],
})
