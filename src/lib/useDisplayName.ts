import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

export function useDisplayName(userId: string | undefined) {
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) {
      setName(null)
      return
    }
    void (async () => {
      const { data } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle()
      setName(data?.display_name?.trim() || 'Guest')
    })()
  }, [userId])

  return name
}
