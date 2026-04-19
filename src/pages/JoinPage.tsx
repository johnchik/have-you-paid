import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { formatErrorMessage } from '../lib/errors'
import { supabase } from '../lib/supabaseClient'
import { isUuid } from '../lib/uuid'

export function JoinPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { user, ready, error: authError } = useAuth()
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!ready || !user || !sessionId) return

    void (async () => {
      if (!isUuid(sessionId)) {
        setMessage('Invalid session link.')
        return
      }

      const { data: preview, error: previewErr } = await supabase.rpc('get_session_join_preview', {
        p_session_id: sessionId,
      })
      if (previewErr) {
        setMessage(formatErrorMessage(previewErr))
        return
      }
      if (!preview?.length) {
        setMessage('This bill was not found, or joining is closed (session locked).')
        return
      }

      const { error: pe } = await supabase.from('session_participants').insert({
        session_id: sessionId,
        user_id: user.id,
        role: 'guest',
      })
      if (pe) {
        if (pe.code === '23505') {
          navigate(`/session/${sessionId}`, { replace: true })
          return
        }
        if (pe.message?.includes('Guest limit reached')) {
          setMessage('This bill has reached its guest limit. Ask the host to raise the limit or make room.')
          return
        }
        setMessage(pe.message)
        return
      }
      navigate(`/session/${sessionId}`, { replace: true })
    })()
  }, [ready, user, sessionId, navigate])

  if (!ready) {
    return (
      <div className="appShell">
        <p className="muted">Joining…</p>
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
      <h1 className="h1">Join session</h1>
      {message ? <div className="alert">{message}</div> : <p className="muted">Adding you to the bill…</p>}
    </div>
  )
}
