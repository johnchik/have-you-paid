import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorPopup } from '../components/ErrorPopup'
import { buildClaimedExpenseRecords, buildCsv, computeDashboardSummary, downloadCsv } from '../lib/dashboard'
import { formatErrorMessage } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabaseClient'
import type { Expense, ExpenseClaim, Profile, Session, SessionMember, Settlement } from '../lib/types'

function formatMoney(value: number, currency = 'HKD') {
  return `${currency} ${value.toFixed(2)}`
}

function toDateInputValue(value: Date) {
  return value.toISOString().slice(0, 10)
}

function renderLinkedText(value: string) {
  const parts = value.split(/(https?:\/\/[^\s]+)/g)
  return parts.map((part, index) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      return (
        <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer" className="inlineTextLink">
          {part}
        </a>
      )
    }
    return <span key={`${part}-${index}`}>{part}</span>
  })
}

export function DashboardPage() {
  const { user, ready } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [members, setMembers] = useState<SessionMember[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [claims, setClaims] = useState<ExpenseClaim[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState(toDateInputValue(new Date()))

  const load = useCallback(async () => {
    if (!user?.id) {
      setLoading(false)
      setProfiles([])
      return
    }

    setLoading(true)
    setError(null)

    try {
      const { data: myMemberRows, error: myMembersError } = await supabase
        .from('session_members')
        .select('*')
        .eq('user_id', user.id)
      if (myMembersError) throw myMembersError

      const myMembers = (myMemberRows ?? []) as SessionMember[]
      const sessionIds = [...new Set(myMembers.map((member) => member.session_id))]

      if (sessionIds.length === 0) {
        setSessions([])
        setMembers([])
        setProfiles([])
        setExpenses([])
        setClaims([])
        setSettlements([])
        setLoading(false)
        return
      }

      const { data: sessionRows, error: sessionError } = await supabase.from('sessions').select('*').in('id', sessionIds)
      if (sessionError) throw sessionError

      const { data: memberRows, error: memberError } = await supabase
        .from('session_members')
        .select('*')
        .in('session_id', sessionIds)
      if (memberError) throw memberError
      const loadedMembers = (memberRows ?? []) as SessionMember[]

      const hostUserIds = [...new Set(loadedMembers.filter((member) => member.is_host && member.user_id).map((member) => member.user_id as string))]
      let loadedProfiles: Profile[] = []
      if (hostUserIds.length > 0) {
        const { data: profileRows, error: profileError } = await supabase.from('profiles').select('*').in('id', hostUserIds)
        if (profileError) throw profileError
        loadedProfiles = (profileRows ?? []) as Profile[]
      }

      const { data: expenseRows, error: expenseError } = await supabase
        .from('expenses')
        .select('*')
        .in('session_id', sessionIds)
      if (expenseError) throw expenseError

      const loadedExpenses = (expenseRows ?? []) as Expense[]
      const expenseIds = loadedExpenses.map((expense) => expense.id)

      let loadedClaims: ExpenseClaim[] = []
      if (expenseIds.length > 0) {
        const { data: claimRows, error: claimError } = await supabase.from('expense_claims').select('*').in('expense_id', expenseIds)
        if (claimError) throw claimError
        loadedClaims = (claimRows ?? []) as ExpenseClaim[]
      }

      const { data: settlementRows, error: settlementError } = await supabase
        .from('settlements')
        .select('*')
        .in('session_id', sessionIds)
      if (settlementError) throw settlementError

      setSessions((sessionRows ?? []) as Session[])
      setMembers(loadedMembers)
      setProfiles(loadedProfiles)
      setExpenses(loadedExpenses)
      setClaims(loadedClaims)
      setSettlements((settlementRows ?? []) as Settlement[])
    } catch (loadError: unknown) {
      setError(formatErrorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    if (!ready) return
    void load()
  }, [load, ready])

  const records = useMemo(() => {
    if (!user?.id) return []
    return buildClaimedExpenseRecords({
      currentUserId: user.id,
      sessions,
      members,
      expenses,
      claims,
      settlements,
      profiles,
    })
  }, [claims, expenses, members, profiles, sessions, settlements, user?.id])

  const filteredRecords = useMemo(() => {
    const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
    const end = endDate ? new Date(`${endDate}T23:59:59`).getTime() : Number.POSITIVE_INFINITY
    return records.filter((record) => {
      const at = new Date(record.expenseCreatedAt).getTime()
      return at >= start && at <= end
    })
  }, [endDate, records, startDate])

  const summaryByCurrency = useMemo(() => {
    if (!user?.id) return []

    return [...new Set(sessions.map((session) => session.currency))]
      .map((currency) => {
        const sessionIds = new Set(sessions.filter((session) => session.currency === currency).map((session) => session.id))
        const filteredSessions = sessions.filter((session) => sessionIds.has(session.id))
        const filteredMembers = members.filter((member) => sessionIds.has(member.session_id))
        const expenseIds = new Set(expenses.filter((expense) => sessionIds.has(expense.session_id)).map((expense) => expense.id))
        const filteredClaims = claims.filter((claim) => expenseIds.has(claim.expense_id))
        const filteredSettlements = settlements.filter((settlement) => sessionIds.has(settlement.session_id))

        return {
          currency,
          summary: computeDashboardSummary({
            currentUserId: user.id,
            sessions: filteredSessions,
            members: filteredMembers,
            claims: filteredClaims,
            settlements: filteredSettlements,
          }),
        }
      })
      .sort((left, right) => left.currency.localeCompare(right.currency))
  }, [claims, expenses, members, sessions, settlements, user?.id])

  const spendBySession = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const record of filteredRecords) {
      grouped.set(record.sessionName, (grouped.get(record.sessionName) ?? 0) + record.myShareAmount)
    }
    const values = [...grouped.entries()]
      .map(([label, amount]) => ({ label, amount }))
      .sort((left, right) => right.amount - left.amount)
    const maxAmount = values[0]?.amount ?? 0
    return values.map((item) => ({
      ...item,
      width: maxAmount > 0 ? Math.max(12, Math.round((item.amount / maxAmount) * 100)) : 0,
    }))
  }, [filteredRecords])

  const spendByMonth = useMemo(() => {
      const grouped = new Map<string, number>()
    for (const record of filteredRecords) {
      const date = new Date(record.expenseCreatedAt)
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      grouped.set(key, (grouped.get(key) ?? 0) + record.myShareAmount)
    }
    return [...grouped.entries()]
      .map(([label, amount]) => ({ label, amount }))
      .sort((left, right) => left.label.localeCompare(right.label))
  }, [filteredRecords])

  const exportCsv = () => {
    downloadCsv('claimed-expenses.csv', buildCsv(filteredRecords))
  }

  if (!ready || loading) {
    return (
      <div className="appShell">
        <p className="muted">Loading dashboard…</p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="appShell stack">
        <h1 className="h1">Dashboard</h1>
        <div className="alert">
          Link an account first from the <Link to="/">home page</Link> to see cross-session balances and claimed-expense stats.
        </div>
      </div>
    )
  }

  return (
    <div className="appShell stack">
      <header className="card heroCard revealCard">
        <div className="stack compactStack">
          <h1 className="pageTitle">Dashboard</h1>
          <p className="heroSummary">Cross-session balance, claimed-expense statistics, and export for {user.email ?? user.id}.</p>
        </div>
      </header>

      <section className="card sectionCard revealCard">
        <div className="sectionHeader">
          <div>
            <h2 className="sectionTitle">Balances</h2>
            <p className="muted">Payable is what you still owe. Receivable is what others still owe you as host.</p>
          </div>
          <Link className="btn btnGhost" to="/">
            Back home
          </Link>
        </div>

        <div className="statGrid dashboardStatGrid">
          {summaryByCurrency.map(({ currency, summary: currencySummary }) => (
            <div key={currency} className="card dashboardCurrencyCard">
              <div className="stack compactStack">
                <strong>{currency}</strong>
                <span className="muted">{currencySummary.sessionsCount} linked session{currencySummary.sessionsCount === 1 ? '' : 's'}</span>
              </div>
              <div className="dashboardCurrencyMetrics">
                <div className="statCard statCardWarm">
                  <span className="muted">Spent (Actual spent)</span>
                  <strong>{formatMoney(currencySummary.totalSpent, currency)} ({formatMoney(currencySummary.actualSpent, currency)})</strong>
                </div>
                <div className="statCard statCardBlue">
                  <span className="muted">Pending to receive</span>
                  <strong>{formatMoney(currencySummary.pendingToReceive, currency)}</strong>
                </div>
              </div>
            </div>
          ))}
          {summaryByCurrency.length === 0 ? (
            <div className="statCard">
              <span className="muted">Linked sessions</span>
              <strong>0</strong>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card sectionCard revealCard">
        <div className="sectionHeader">
          <div>
            <h2 className="sectionTitle">Claimed expenses</h2>
            <p className="muted">Filter what you claimed, then export the current view as CSV.</p>
          </div>
          <div className="row">
            <button type="button" className="btn btnPrimary" disabled={filteredRecords.length === 0} onClick={exportCsv}>
              Export CSV
            </button>
          </div>
        </div>

        <div className="inlineFormCard">
          <label className="field">
            Start date
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="field">
            End date
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <div className="softLabel">Rows in range: {filteredRecords.length}</div>
        </div>

        <div className="dashboardCharts">
          <div className="card dashboardPanel">
            <h3 className="dashboardPanelTitle">Spend by session</h3>
            {spendBySession.length === 0 ? (
              <p className="muted">No claimed expenses in this range.</p>
            ) : (
              <div className="dashboardBarList">
                {spendBySession.slice(0, 8).map((item) => (
                  <div key={item.label} className="dashboardBarRow">
                    <div className="dashboardBarMeta">
                      <strong>{item.label}</strong>
                      <span className="muted">{formatMoney(item.amount)}</span>
                    </div>
                    <div className="dashboardBarTrack">
                      <div className="dashboardBarFill" style={{ width: `${item.width}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card dashboardPanel">
            <h3 className="dashboardPanelTitle">Spend by month</h3>
            {spendByMonth.length === 0 ? (
              <p className="muted">No claimed expenses in this range.</p>
            ) : (
              <div className="dashboardMonthList">
                {spendByMonth.map((item) => (
                  <div key={item.label} className="dashboardMonthRow">
                    <span>{item.label}</span>
                    <strong>{formatMoney(item.amount)}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {filteredRecords.length === 0 ? (
          <div className="emptyState">
            <p className="muted">No claimed expenses match the selected dates.</p>
          </div>
        ) : (
          <div className="tableWrap">
            <table className="table dataTable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Session</th>
                  <th>Expense</th>
                  <th>My share</th>
                  <th>Status</th>
                  <th>Host payment</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record) => (
                  <tr key={`${record.expenseId}:${record.sessionId}`}>
                    <td>{new Date(record.expenseCreatedAt).toLocaleDateString()}</td>
                    <td>
                      <div className="stack compactStack">
                        <strong>
                          <Link to={`/session/${record.sessionId}`}>{record.sessionName}</Link>
                        </strong>
                        <span className="muted">{record.hostName}</span>
                      </div>
                    </td>
                    <td>
                      <div className="stack compactStack">
                        <strong>{record.expenseName}</strong>
                        <span className="muted">Total {formatMoney(record.expenseTotalAmount, record.currency)}</span>
                      </div>
                    </td>
                    <td>{formatMoney(record.myShareAmount, record.currency)}</td>
                    <td>
                      {record.isPaid ? (
                        <span className="statusBadge statusBadgeSuccess">Paid</span>
                      ) : (
                        <div className="stack compactStack">
                          <span className="statusBadge statusBadgeWarm">Not paid</span>
                          <span className="muted">Outstanding {formatMoney(record.outstandingAmount, record.currency)}</span>
                        </div>
                      )}
                    </td>
                    <td>
                      {record.isPaid ? (
                        <span className="muted">No action needed.</span>
                      ) : (
                        <div className="stack compactStack">
                          <div className="paymentBadgeRow">
                            <span className={`statusBadge ${record.acceptsFps ? 'statusBadgeSuccess' : 'statusBadgeWarm'}`}>
                              {record.acceptsFps ? '✓' : '✕'} FPS
                            </span>
                            <span className={`statusBadge ${record.acceptsPayme ? 'statusBadgeSuccess' : 'statusBadgeWarm'}`}>
                              {record.acceptsPayme ? '✓' : '✕'} PayMe
                            </span>
                          </div>
                          {record.hostPaymentComment ? <span className="muted prewrapText">{renderLinkedText(record.hostPaymentComment)}</span> : null}
                          {!record.acceptsFps && !record.acceptsPayme && !record.hostPaymentComment ? (
                            <span className="muted">No host payment details saved.</span>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {error ? <ErrorPopup message={error} onClose={() => setError(null)} /> : null}
    </div>
  )
}
