import { createClient } from '@supabase/supabase-js'
import { getOrCreateGuestToken } from './guestIdentity'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !publishableKey) {
  console.warn('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY')
}

const guestToken = typeof window !== 'undefined' ? getOrCreateGuestToken() : ''

export const supabase = createClient(url ?? '', publishableKey ?? '', {
  global: {
    headers: {
      'x-guest-token': guestToken,
    },
  },
})
