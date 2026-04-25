import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

export async function ensureSignedIn(): Promise<{ session: Session | null; error: string | null }> {
  const { data: existing } = await supabase.auth.getSession()
  return { session: existing.session ?? null, error: null }
}
