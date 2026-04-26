import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { defaultGuestDisplayName } from '../lib/guestIdentity'
import { useDisplayName } from '../lib/useDisplayName'

export function AppLayout() {
  const { user, ready, signOut } = useAuth()
  const displayName = useDisplayName(user?.id)
  const guestName = defaultGuestDisplayName()

  return (
    <div className="appRoot">
      <header className="appTopBar">
        <span className="appTopBarSpacer" />
        {ready ? (
          <div className="userBadgeRow">
            <span className="userBadge" title="Your display name">
              {user ? displayName ?? '…' : guestName}
            </span>
            <span className="muted userBadgeHint">
              {user ? (
                <>
                  Linked account. Open the <Link to="/dashboard">dashboard</Link> or manage details on the <Link to="/">home page</Link>.
                </>
              ) : (
                <>
                  Guest mode. Change your name or link an account on the <Link to="/">home page</Link>.
                </>
              )}
            </span>
            {user ? (
              <button type="button" className="btn btnGhost appTopBarButton" onClick={() => void signOut()}>
                Sign out
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
