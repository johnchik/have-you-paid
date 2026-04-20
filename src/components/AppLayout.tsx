import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useDisplayName } from '../lib/useDisplayName'

export function AppLayout() {
  const { user, ready } = useAuth()
  const displayName = useDisplayName(user?.id)

  return (
    <div className="appRoot">
      <header className="appTopBar">
        <span className="appTopBarSpacer" />
        {ready && user ? (
          <div className="userBadgeRow">
            <span className="userBadge" title="Your display name">
              {displayName ?? '…'}
            </span>
            <span className="muted userBadgeHint">
              Change your name in the <Link to="/">home page</Link>.
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
