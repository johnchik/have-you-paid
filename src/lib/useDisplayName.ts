import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

export const DISPLAY_NAME_UPDATED_EVENT = 'display-name-updated'

export function useDisplayName(userId: string | undefined) {
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) {
      setName(null)
      return
    }
    const load = async () => {
      const { data } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle()
      setName(data?.display_name?.trim() || 'Guest')
    }
    void load()
    const onUpdated = () => {
      void load()
    }
    window.addEventListener(DISPLAY_NAME_UPDATED_EVENT, onUpdated)
    return () => {
      window.removeEventListener(DISPLAY_NAME_UPDATED_EVENT, onUpdated)
    }
  }, [userId])

  return name
}
