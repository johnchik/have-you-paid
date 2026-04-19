import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { formatErrorMessage } from '../lib/errors'
import { defaultNewSessionTitle, formatSessionCreatedAt } from '../lib/sessionDisplay'
import { supabase } from '../lib/supabaseClient'
import type { SessionRow } from '../lib/types'

type ParticipantWithSession = {
  session_id: string
  joined_at: string
  sessions: SessionRow | null
}

export function Home() {
  const navigate = useNavigate()
  const { user, ready, error: authError } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [profileError, setProfileError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ParticipantWithSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewUrlRef = useRef<string | null>(null)

  const setFileAndPreview = useCallback((file: File | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setReceiptFile(file)
    if (file) {
      const url = URL.createObjectURL(file)
      previewUrlRef.current = url
      setPreviewUrl(url)
    } else {
      setPreviewUrl(null)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
      }
    }
  }, [])

  const loadMySessions = useCallback(async () => {
    if (!user) {
      setSessions([])
      setLoadingSessions(false)
      return
    }
    setLoadingSessions(true)
    const { data, error } = await supabase
      .from('session_participants')
      .select('session_id, joined_at, sessions(*)')
      .eq('user_id', user.id)
      .order('joined_at', { ascending: false })
    if (error) {
      console.error(error)
      setSessions([])
    } else {
      const normalized: ParticipantWithSession[] = (data ?? []).map((row: Record<string, unknown>) => {
        const s = row.sessions
        const sessionRow =
          s && typeof s === 'object' && !Array.isArray(s)
            ? (s as SessionRow)
            : Array.isArray(s) && s[0]
              ? (s[0] as SessionRow)
              : null
        return {
          session_id: row.session_id as string,
          joined_at: row.joined_at as string,
          sessions: sessionRow,
        }
      })
      setSessions(normalized)
    }
    setLoadingSessions(false)
  }, [user])

  useEffect(() => {
    void loadMySessions()
  }, [loadMySessions])

  useEffect(() => {
    if (!user) return
    void (async () => {
      const { data } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle()
      if (data?.display_name) setDisplayName(data.display_name)
    })()
  }, [user])

  const saveDisplayName = async () => {
    if (!user) return
    setProfileError(null)
    const name = displayName.trim() || 'Guest'
    const { error } = await supabase.from('profiles').upsert({ id: user.id, display_name: name })
    if (error) setProfileError(error.message)
  }

  const uploadSession = async () => {
    const file = receiptFile
    if (!file || !user) return
    setBusy(true)
    setCreateError(null)
    try {
      const { data: sessionRow, error: sErr } = await supabase
        .from('sessions')
        .insert({ host_user_id: user.id, title: defaultNewSessionTitle() })
        .select('id')
        .single()
      if (sErr || !sessionRow) throw sErr ?? new Error('Failed to create session')

      const sessionId = sessionRow.id as string

      const { error: pErr } = await supabase.from('session_participants').insert({
        session_id: sessionId,
        user_id: user.id,
        role: 'host',
      })
      if (pErr) throw pErr

      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
      const path = `${sessionId}/receipt.${ext}`
      const { error: uErr } = await supabase.storage.from('receipts').upload(path, file, {
        upsert: true,
        contentType: file.type || 'image/jpeg',
      })
      if (uErr) throw uErr

      const { error: upErr } = await supabase
        .from('sessions')
        .update({ receipt_storage_path: path })
        .eq('id', sessionId)
      if (upErr) throw upErr

      setFileAndPreview(null)
      await loadMySessions()
      navigate(`/session/${sessionId}`)
    } catch (e: unknown) {
      setCreateError(formatErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onPickFile = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) {
      setCreateError('Please choose an image file.')
      return
    }
    setCreateError(null)
    setFileAndPreview(file)
  }

  if (!ready) {
    return (
      <div className="appShell">
        <p className="muted">Starting…</p>
      </div>
    )
  }

  if (authError || !user) {
    return (
      <div className="appShell">
        <div className="alert">{authError ?? 'Not signed in.'}</div>
      </div>
    )
  }

  return (
    <div className="appShell stack">
      <header>
        <h1 className="h1">Have you paid?</h1>
        <p className="muted">Share a receipt, tag items, and track who has paid.</p>
      </header>

      <section className="card stack">
        <h2 className="h2">Your name</h2>
        <p className="muted">Shown to others in the session.</p>
        <div className="row">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Guest"
            aria-label="Display name"
          />
          <button type="button" className="btn btnPrimary" onClick={() => void saveDisplayName()}>
            Save
          </button>
        </div>
        {profileError ? <p className="muted">{profileError}</p> : null}
      </section>

      <section className="card stack">
        <h2 className="h2">New bill session</h2>
        <p className="muted">Choose or take a photo, review it, then start the session.</p>
        <div className="row">
          <label className="btn">
            Choose image
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={busy}
              onChange={(e) => {
                onPickFile(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
          </label>
          <label className="btn">
            Take photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              disabled={busy}
              onChange={(e) => {
                onPickFile(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
          </label>
        </div>

        {previewUrl ? (
          <div className="stack">
            <div className="receiptWrap" style={{ maxHeight: '50vh' }}>
              <img src={previewUrl} alt="Receipt preview" className="receiptImg" />
            </div>
            <p className="muted">{receiptFile?.name}</p>
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={() => setFileAndPreview(null)}>
                Change image
              </button>
              <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => void uploadSession()}>
                {busy ? 'Working…' : 'Start session with this image'}
              </button>
            </div>
          </div>
        ) : null}

        {createError ? <p className="muted">{createError}</p> : null}
      </section>

      <section className="card stack">
        <h2 className="h2">My sessions</h2>
        {loadingSessions ? (
          <p className="muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <table className="table tableActionLast">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((row) => {
                const s = row.sessions
                if (!s) return null
                return (
                  <tr key={row.session_id}>
                    <td>{s.title?.trim() || 'Untitled'}</td>
                    <td className="muted">{formatSessionCreatedAt(s.created_at)}</td>
                    <td>
                      <span className={s.status === 'locked' ? 'badge badgeLocked' : 'badge'}>{s.status}</span>
                    </td>
                    <td>
                      <Link to={`/session/${s.id}`}>Open</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
