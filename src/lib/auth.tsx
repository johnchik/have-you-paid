import type { Session, User } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ensureSignedIn } from './ensureAuthSession'
import { supabase } from './supabaseClient'

type AuthState = {
  user: User | null
  session: Session | null
  ready: boolean
  error: string | null
}

const AuthContext = createContext<AuthState & { refresh: () => Promise<void> } | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { session: s, error: e } = await ensureSignedIn()
    setSession(s)
    setUser(s?.user ?? null)
    setError(e)
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
      setUser(sess?.user ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [refresh])

  const value = useMemo(
    () => ({ user, session, ready, error, refresh }),
    [user, session, ready, error, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
