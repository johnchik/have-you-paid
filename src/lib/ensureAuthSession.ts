import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

export async function ensureSignedIn(): Promise<{ session: Session | null; error: string | null }> {
  const { data: existing } = await supabase.auth.getSession()
  if (existing.session) {
    return { session: existing.session, error: null }
  }

  const anonResult = await supabase.auth.signInAnonymously()
  if (anonResult.error) {
    return {
      session: null,
      error:
        anonResult.error.message +
        ' — Enable Anonymous sign-ins in Supabase Auth settings, or configure credentials.',
    }
  }
  return { session: anonResult.data.session, error: null }
}
