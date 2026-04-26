import { getOrCreateGuestToken } from './guestIdentity'
import { supabase } from './supabaseClient'

function claimStorageKey(userId: string, guestToken: string) {
  return `claimed-guest-data:${userId}:${guestToken}`
}

export async function claimGuestDataForUser(userId: string | undefined) {
  if (!userId || typeof window === 'undefined') return

  const guestToken = getOrCreateGuestToken()
  const storageKey = claimStorageKey(userId, guestToken)
  if (window.localStorage.getItem(storageKey) === 'done') return

  const { error } = await supabase.rpc('claim_guest_data', {
    p_user_id: userId,
    p_guest_token: guestToken,
  })
  if (error) throw error

  window.localStorage.setItem(storageKey, 'done')
}
