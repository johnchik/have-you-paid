import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { defaultGuestDisplayName } from '../lib/guestIdentity'
import { useDisplayName } from '../lib/useDisplayName'

export function AppLayout() {
  const { user, ready } = useAuth()
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
              {user ? 'Linked account.' : 'Guest mode.'} Change your name in the <Link to="/">home page</Link>.
            </span>
          </div>
        ) : null}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
