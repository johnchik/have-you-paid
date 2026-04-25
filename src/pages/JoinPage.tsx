import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ErrorPopup } from '../components/ErrorPopup'
import { formatErrorMessage } from '../lib/errors'
import { defaultGuestDisplayName, getOrCreateGuestToken, setGuestDisplayName } from '../lib/guestIdentity'
import { supabase } from '../lib/supabaseClient'
import type { Session, SessionMember } from '../lib/types'
import { isUuid } from '../lib/uuid'

export function JoinPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { user, ready } = useAuth()
  const guestToken = useMemo(() => getOrCreateGuestToken(), [])

  const [session, setSession] = useState<Session | null>(null)
  const [members, setMembers] = useState<SessionMember[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [displayName, setDisplayName] = useState(defaultGuestDisplayName())

  const load = useCallback(async () => {
    if (!sessionId) return
    if (!isUuid(sessionId)) {
      setLoadError('Invalid session link.')
      return
    }

    setLoadError(null)

    const { data: sessionRow, error: sessionError } = await supabase.from('sessions').select('*').eq('id', sessionId).maybeSingle()
    if (sessionError) {
      setLoadError(sessionError.message)
      return
    }
    if (!sessionRow) {
      setLoadError('This session was not found.')
      return
    }

    const { data: memberRows, error: memberError } = await supabase
      .from('session_members')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
    if (memberError) {
      setLoadError(memberError.message)
      return
    }

    setSession(sessionRow as Session)
    setMembers((memberRows ?? []) as SessionMember[])
  }, [sessionId])

  useEffect(() => {
    if (!ready) return
    void load()
  }, [load, ready])

  useEffect(() => {
    if (!sessionId || !ready || members.length === 0) return

    const existingMember =
      members.find((member) => member.guest_token === guestToken) ??
      (user?.id ? members.find((member) => member.user_id === user.id) : null)

    if (existingMember && existingMember.status !== 'placeholder') {
      navigate(`/session/${sessionId}`, { replace: true })
    }
  }, [guestToken, members, navigate, ready, sessionId, user?.id])

  useEffect(() => {
    if (!actionError) return
    const timer = window.setTimeout(() => setActionError(null), 4000)
    return () => window.clearTimeout(timer)
  }, [actionError])

  const claimPlaceholder = async (member: SessionMember) => {
    if (!sessionId) return
    setBusy(true)
    setActionError(null)

    try {
      const trimmedName = (displayName.trim() || member.display_name || 'Guest').slice(0, 80)
      setGuestDisplayName(trimmedName)

      const { data, error } = await supabase
        .from('session_members')
        .update({
          display_name: trimmedName,
          guest_token: guestToken,
          user_id: user?.id ?? null,
          status: user?.id ? 'linked' : 'claimed',
          claimed_at: new Date().toISOString(),
        })
        .eq('id', member.id)
        .eq('status', 'placeholder')
        .select('*')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('That placeholder was already claimed. Refresh and choose another.')
      }

      navigate(`/session/${sessionId}`, { replace: true })
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
      await load()
    } finally {
      setBusy(false)
    }
  }

  const joinAsNewMember = async () => {
    if (!sessionId) return
    setBusy(true)
    setActionError(null)

    try {
      const trimmedName = (displayName.trim() || 'Guest').slice(0, 80)
      setGuestDisplayName(trimmedName)

      const { error } = await supabase.from('session_members').insert({
        session_id: sessionId,
        display_name: trimmedName,
        guest_token: guestToken,
        user_id: user?.id ?? null,
        is_host: false,
        status: user?.id ? 'linked' : 'claimed',
        claimed_at: new Date().toISOString(),
      })
      if (error) throw error

      navigate(`/session/${sessionId}`, { replace: true })
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!ready) {
    return (
      <div className="appShell">
        <p className="muted">Loading join flow…</p>
      </div>
    )
  }

  if (!sessionId || !isUuid(sessionId)) {
    return (
      <div className="appShell stack">
        <h1 className="h1">Join session</h1>
        <div className="alert">Invalid session link.</div>
      </div>
    )
  }

  const unclaimedMembers = members.filter((member) => member.status === 'placeholder')

  return (
    <div className="appShell stack">
      <header className="stack">
        <h1 className="h1">Join session</h1>
        <p className="muted">{session ? `Claim your spot in "${session.name}".` : 'Opening session…'}</p>
      </header>

      {loadError ? <div className="alert">{loadError}</div> : null}

      {!loadError && session ? (
        <>
          <section className="card stack">
            <h2 className="h2">You</h2>
            <label className="field">
              Display name
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Guest"
              />
            </label>
            <p className="muted">This browser joins as guest token `{guestToken}`.</p>
          </section>

          <section className="card stack">
            <h2 className="h2">Claim a placeholder</h2>
            {unclaimedMembers.length === 0 ? (
              <p className="muted">No unclaimed placeholders are left. You can still join as a new member.</p>
            ) : (
              <div className="stack">
                {unclaimedMembers.map((member) => (
                  <div key={member.id} className="memberRow">
                    <div>
                      <strong>{member.display_name}</strong>
                      <p className="muted">Placeholder</p>
                    </div>
                    <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => void claimPlaceholder(member)}>
                      Claim
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card stack">
            <h2 className="h2">Not on the list?</h2>
            <p className="muted">Create a new member if the host did not add your placeholder yet.</p>
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={() => void joinAsNewMember()}>
                {busy ? 'Joining…' : 'Join as new member'}
              </button>
              <Link to={`/session/${sessionId}`}>Open session</Link>
            </div>
          </section>
        </>
      ) : null}

      {actionError ? <ErrorPopup message={actionError} onClose={() => setActionError(null)} /> : null}
    </div>
  )
}
