import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { IoCheckmarkCircleOutline, IoFlashOutline, IoWalletOutline } from 'react-icons/io5'
import { useAuth } from '../lib/auth'
import { DISPLAY_NAME_UPDATED_EVENT } from '../lib/useDisplayName'
import { ErrorPopup } from '../components/ErrorPopup'
import { formatErrorMessage } from '../lib/errors'
import { defaultGuestDisplayName, getOrCreateGuestToken, setGuestDisplayName } from '../lib/guestIdentity'
import { defaultNewSessionTitle, formatSessionCreatedAt } from '../lib/sessionDisplay'
import { supabase } from '../lib/supabaseClient'
import type { Profile, Session, SessionMember } from '../lib/types'

type SessionListItem = {
  session: Session
  member: SessionMember
}

const DEFAULT_CURRENCY = 'HKD'

export function Home() {
  const navigate = useNavigate()
  const { user, ready, signOut } = useAuth()
  const guestToken = useMemo(() => getOrCreateGuestToken(), [])

  const [displayName, setDisplayName] = useState(defaultGuestDisplayName())
  const [defaultPaymentComment, setDefaultPaymentComment] = useState('')
  const [defaultAcceptsFps, setDefaultAcceptsFps] = useState(false)
  const [defaultAcceptsPayme, setDefaultAcceptsPayme] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)

  const [sessionName, setSessionName] = useState(defaultNewSessionTitle())
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY)
  const [sessionPaymentComment, setSessionPaymentComment] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [authEmail, setAuthEmail] = useState('')
  const [authOtp, setAuthOtp] = useState('')
  const [authStep, setAuthStep] = useState<'request' | 'verify'>('request')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authMessage, setAuthMessage] = useState<string | null>(null)

  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)

  const loadMySessions = useCallback(async () => {
    setSessionsLoading(true)

    try {
      let memberRows: SessionMember[] = []

      const { data: guestRows, error: guestError } = await supabase
        .from('session_members')
        .select('*')
        .eq('guest_token', guestToken)
        .order('created_at', { ascending: false })
      if (guestError) throw guestError
      memberRows = (guestRows ?? []) as SessionMember[]

      if (user?.id) {
        const { data: linkedRows, error: linkedError } = await supabase
          .from('session_members')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
        if (linkedError) throw linkedError

        const seen = new Set(memberRows.map((row) => row.id))
        for (const row of (linkedRows ?? []) as SessionMember[]) {
          if (!seen.has(row.id)) {
            memberRows.push(row)
          }
        }
      }

      const sessionIds = [...new Set(memberRows.map((row) => row.session_id))]
      if (sessionIds.length === 0) {
        setSessions([])
        setSessionsLoading(false)
        return
      }

      const { data: sessionRows, error: sessionError } = await supabase
        .from('sessions')
        .select('*')
        .in('id', sessionIds)
        .order('created_at', { ascending: false })
      if (sessionError) throw sessionError

      const sessionMap = new Map(((sessionRows ?? []) as Session[]).map((session) => [session.id, session]))
      const nextItems = memberRows
        .map((member) => {
          const session = sessionMap.get(member.session_id)
          return session ? { session, member } : null
        })
        .filter((item): item is SessionListItem => item !== null)
        .sort((left, right) => new Date(right.session.created_at).getTime() - new Date(left.session.created_at).getTime())

      setSessions(nextItems)
    } catch (error: unknown) {
      console.error(error)
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [guestToken, user?.id])

  useEffect(() => {
    if (!user?.id) {
      setDefaultPaymentComment('')
      setDefaultAcceptsFps(false)
      setDefaultAcceptsPayme(false)
      return
    }

    void (async () => {
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
      const profile = data as Profile | null
      if (!profile) return
      if (profile.display_name?.trim()) {
        setDisplayName(profile.display_name.trim())
      }
      setDefaultPaymentComment(profile.default_payment_comment?.trim() ?? '')
      setDefaultAcceptsFps(profile.default_accepts_fps ?? false)
      setDefaultAcceptsPayme(profile.default_accepts_payme ?? false)
      setSessionPaymentComment('')
    })()
  }, [user?.id])

  useEffect(() => {
    if (!ready) return
    void loadMySessions()
  }, [loadMySessions, ready])

  useEffect(() => {
    if (!profileError && !createError && !authError && !authMessage) return
    const timer = window.setTimeout(() => {
      setProfileError(null)
      setCreateError(null)
      setAuthError(null)
      setAuthMessage(null)
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [authError, authMessage, createError, profileError])

  const saveProfile = async () => {
    const trimmed = displayName.trim() || 'Guest'
    setProfileError(null)
    setProfileSaved(false)
    setGuestDisplayName(trimmed)

    if (user?.id) {
      const { error } = await supabase.from('profiles').upsert(
        {
          id: user.id,
          display_name: trimmed,
          default_payment_comment: defaultPaymentComment.trim() || null,
          default_accepts_fps: defaultAcceptsFps,
          default_accepts_payme: defaultAcceptsPayme,
        },
        { onConflict: 'id' },
      )
      if (error) {
        setProfileError(error.message)
        return
      }
      setDefaultPaymentComment(defaultPaymentComment.trim())
      window.dispatchEvent(new Event(DISPLAY_NAME_UPDATED_EVENT))
    }

    const { error: memberError } = await supabase
      .from('session_members')
      .update({ display_name: trimmed })
      .eq('guest_token', guestToken)
      .neq('status', 'placeholder')
    if (memberError) {
      setProfileError(memberError.message)
      return
    }

    setDisplayName(trimmed)
    setProfileSaved(true)
    await loadMySessions()
  }

  const createSession = async () => {
    const trimmedSessionName = sessionName.trim()
    const trimmedDisplayName = (displayName.trim() || 'Guest').slice(0, 80)

    if (!trimmedSessionName) {
      setCreateError('Session name is required.')
      return
    }

    setCreateBusy(true)
    setCreateError(null)

    try {
      setGuestDisplayName(trimmedDisplayName)

      const { data: sessionRow, error: sessionError } = await supabase
        .from('sessions')
        .insert({
          name: trimmedSessionName,
          currency: currency.trim().toUpperCase() || DEFAULT_CURRENCY,
          host_payment_comment: sessionPaymentComment.trim() || null,
        })
        .select('*')
        .single()
      if (sessionError) throw sessionError

      const { error: hostError } = await supabase.from('session_members').insert({
        session_id: (sessionRow as Session).id,
        display_name: trimmedDisplayName,
        guest_token: guestToken,
        user_id: user?.id ?? null,
        is_host: true,
        status: user?.id ? 'linked' : 'claimed',
        claimed_at: new Date().toISOString(),
      })
      if (hostError) throw hostError

      await loadMySessions()
      navigate(`/session/${(sessionRow as Session).id}`)
    } catch (error: unknown) {
      setCreateError(formatErrorMessage(error))
    } finally {
      setCreateBusy(false)
    }
  }

  const requestOtp = async () => {
    const trimmedEmail = authEmail.trim()
    if (!trimmedEmail) {
      setAuthError('Email is required.')
      return
    }

    setAuthBusy(true)
    setAuthError(null)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmedEmail,
        options: { shouldCreateUser: true },
      })
      if (error) throw error
      setAuthStep('verify')
      setAuthMessage(`Sent an email code to ${trimmedEmail}.`)
    } catch (error: unknown) {
      setAuthError(formatErrorMessage(error))
    } finally {
      setAuthBusy(false)
    }
  }

  const verifyOtp = async () => {
    const trimmedEmail = authEmail.trim()
    const trimmedOtp = authOtp.trim()
    if (!trimmedEmail || !trimmedOtp) {
      setAuthError('Email and OTP code are required.')
      return
    }

    setAuthBusy(true)
    setAuthError(null)
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: trimmedEmail,
        token: trimmedOtp,
        type: 'email',
      })
      if (error) throw error
      setAuthOtp('')
      setAuthStep('request')
      setAuthMessage('Account linked.')
    } catch (error: unknown) {
      setAuthError(formatErrorMessage(error))
    } finally {
      setAuthBusy(false)
    }
  }

  const handleSignOut = async () => {
    setAuthBusy(true)
    setAuthError(null)
    try {
      await signOut()
      setAuthStep('request')
      setAuthMessage('Signed out.')
    } catch (error: unknown) {
      setAuthError(formatErrorMessage(error))
    } finally {
      setAuthBusy(false)
    }
  }

  return (
    <div className="appShell stack">
      <header className="stack">
        <h1 className="h1">Have you paid?</h1>
        <p className="muted">Create a settle-up session, share the join link, and track expenses by guest token first.</p>
      </header>

      <section className="card stack">
        <h2 className="h2">Account</h2>
        {user ? (
          <>
            <p className="muted">Linked auth user: {user.email ?? user.id}</p>
            <div className="row">
              <Link className="btn btnGhost" to="/dashboard">
                Open dashboard
              </Link>
              <button type="button" className="btn" disabled={authBusy} onClick={() => void handleSignOut()}>
                {authBusy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">Link your guest history to an account for cross-session balance and claimed-expense statistics.</p>
            <div className="inlineFormCard">
              <label className="field growField">
                Email
                <input
                  type="email"
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              {authStep === 'verify' ? (
                <label className="field amountField">
                  Email code
                  <input
                    type="text"
                    inputMode="numeric"
                    value={authOtp}
                    onChange={(event) => setAuthOtp(event.target.value)}
                    placeholder="12345678"
                  />
                </label>
              ) : null}
              <button type="button" className="btn btnPrimary" disabled={authBusy} onClick={() => void (authStep === 'request' ? requestOtp() : verifyOtp())}>
                {authBusy ? 'Working…' : authStep === 'request' ? 'Send OTP' : 'Verify OTP'}
              </button>
              {authStep === 'verify' ? (
                <button type="button" className="btn btnGhost" disabled={authBusy} onClick={() => setAuthStep('request')}>
                  Change email
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>

      <section className="card stack">
        <h2 className="h2">Your identity</h2>
        <p className="muted">
          You can use the app as a guest. If you later sign in, the same guest token can be linked to your account.
        </p>
        <div className="paymentPrefsLayout">
          <label className="field growField fullRowField">
            Display name
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Guest"
            />
          </label>
          <div className="chipRow">
            <button
              type="button"
              className={`methodChip ${defaultAcceptsFps ? 'methodChipSelected' : ''}`}
              onClick={() => setDefaultAcceptsFps((current) => !current)}
            >
              <span className="methodChipIcon">
                <IoFlashOutline size={16} aria-hidden />
              </span>
              <span>FPS</span>
              <IoCheckmarkCircleOutline size={16} aria-hidden className="methodChipCheck" />
            </button>
            <button
              type="button"
              className={`methodChip ${defaultAcceptsPayme ? 'methodChipSelected' : ''}`}
              onClick={() => setDefaultAcceptsPayme((current) => !current)}
            >
              <span className="methodChipIcon">
                <IoWalletOutline size={16} aria-hidden />
              </span>
              <span>PayMe</span>
              <IoCheckmarkCircleOutline size={16} aria-hidden className="methodChipCheck" />
            </button>
          </div>
          <div className="actionsRow">
            <button type="button" className="btn btnPrimary" onClick={() => void saveProfile()}>
              Save
            </button>
          </div>
          <label className="field growField fullRowField">
            Transfer comment
            <textarea
              className="commentTextarea"
              value={defaultPaymentComment}
              onChange={(event) => setDefaultPaymentComment(event.target.value)}
              placeholder=""
              rows={4}
            />
          </label>
        </div>
        <p className="muted">Guest token: {guestToken}</p>
        {user ? <p className="muted">Saved defaults apply to new sessions. Dashboard totals use linked session rows only.</p> : <p className="muted">Sign in to persist payment defaults across browsers.</p>}
        {profileSaved ? <p className="muted">Saved.</p> : null}
      </section>

      <section className="card stack">
        <h2 className="h2">Create session</h2>
        <div className="inlineFormCard">
          <label className="field growField">
            Session name
            <input
              type="text"
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="Team lunch"
            />
          </label>
          <label className="field currencyField">
            Currency
            <input
              type="text"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              maxLength={8}
              placeholder="HKD"
            />
          </label>
          <button type="button" className="btn btnPrimary" disabled={createBusy} onClick={() => void createSession()}>
            {createBusy ? 'Creating…' : 'Create session'}
          </button>
        </div>

        <div className="sessionPaymentGrid">
          <label className="field growField fullRowField">
            Additional transfer comment
            <textarea
              className="commentTextarea"
              value={sessionPaymentComment}
              onChange={(event) => setSessionPaymentComment(event.target.value)}
              placeholder=""
              rows={4}
            />
          </label>
        </div>

        {user && (defaultPaymentComment || defaultAcceptsFps || defaultAcceptsPayme) ? (
          <p className="muted">Your saved FPS / PayMe preferences and default comment apply automatically. This session comment is only an extra note.</p>
        ) : null}
      </section>

      <section className="card stack">
        <h2 className="h2">Your sessions</h2>
        {sessionsLoading ? (
          <p className="muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <table className="table tableActionLast">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Your role</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map(({ session, member }) => (
                <tr key={member.id}>
                  <td>{session.name}</td>
                  <td>
                    <span className={session.status === 'settled' ? 'badge badgeLocked' : 'badge'}>{session.status}</span>
                  </td>
                  <td>{member.is_host ? 'Host' : member.status === 'placeholder' ? 'Placeholder' : 'Member'}</td>
                  <td className="muted">{formatSessionCreatedAt(session.created_at)}</td>
                  <td>
                    <Link to={`/session/${session.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {profileError ? <ErrorPopup message={profileError} onClose={() => setProfileError(null)} /> : null}
      {createError ? <ErrorPopup message={createError} onClose={() => setCreateError(null)} /> : null}
      {authError ? <ErrorPopup message={authError} onClose={() => setAuthError(null)} /> : null}
      {authMessage ? <div className="alert">{authMessage}</div> : null}
    </div>
  )
}
