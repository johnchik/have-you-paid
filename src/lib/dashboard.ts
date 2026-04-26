import type { Expense, ExpenseClaim, Profile, Session, SessionMember, Settlement } from './types'
import { roundCurrency } from './settleUp'

export type ClaimedExpenseRecord = {
  sessionId: string
  sessionName: string
  sessionCreatedAt: string
  expenseCreatedAt: string
  currency: string
  expenseId: string
  expenseName: string
  expenseTotalAmount: number
  myShareAmount: number
  hostName: string
  hostPaymentComment: string | null
  acceptsFps: boolean
  acceptsPayme: boolean
  isPaid: boolean
  outstandingAmount: number
}

export type DashboardSummary = {
  totalSpent: number
  actualSpent: number
  pendingToReceive: number
  sessionsCount: number
}

export function buildClaimedExpenseRecords(args: {
  currentUserId: string
  sessions: Session[]
  members: SessionMember[]
  expenses: Expense[]
  claims: ExpenseClaim[]
  settlements: Settlement[]
  profiles: Profile[]
}) {
  const { currentUserId, sessions, members, expenses, claims, settlements, profiles } = args
  const memberById = new Map(members.map((member) => [member.id, member]))
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const expenseById = new Map(expenses.map((expense) => [expense.id, expense]))
  const hostBySessionId = new Map(members.filter((member) => member.is_host).map((member) => [member.session_id, member]))
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
  const claimsByMemberId = new Map<string, number>()
  for (const claim of claims) {
    claimsByMemberId.set(claim.member_id, roundCurrency((claimsByMemberId.get(claim.member_id) ?? 0) + claim.share_amount))
  }
  const paidByMemberId = new Map<string, number>()
  for (const settlement of settlements) {
    if (settlement.status !== 'confirmed') continue
    paidByMemberId.set(
      settlement.from_member_id,
      roundCurrency((paidByMemberId.get(settlement.from_member_id) ?? 0) + settlement.amount),
    )
  }

  return claims
    .filter((claim) => memberById.get(claim.member_id)?.user_id === currentUserId)
    .map((claim) => {
      const member = memberById.get(claim.member_id)
      const expense = expenseById.get(claim.expense_id)
      if (!member || !expense) return null
      const session = sessionById.get(expense.session_id)
      if (!session) return null
      const hostMember = hostBySessionId.get(session.id)
      const hostProfile = hostMember?.user_id ? profileById.get(hostMember.user_id) ?? null : null
      const combinedComment = [hostProfile?.default_payment_comment?.trim(), session.host_payment_comment?.trim()]
        .filter((part) => Boolean(part))
        .join('\n')
      const memberClaimedTotal = claimsByMemberId.get(member.id) ?? 0
      const memberPaidTotal = paidByMemberId.get(member.id) ?? 0
      const outstandingAmount = member.is_host ? 0 : Math.max(0, roundCurrency(memberClaimedTotal - memberPaidTotal))

      return {
        sessionId: session.id,
        sessionName: session.name,
        sessionCreatedAt: session.created_at,
        expenseCreatedAt: expense.created_at,
        currency: session.currency,
        expenseId: expense.id,
        expenseName: expense.name,
        expenseTotalAmount: expense.amount,
        myShareAmount: claim.share_amount,
        hostName: hostMember?.display_name ?? 'Host',
        hostPaymentComment: combinedComment || null,
        acceptsFps: hostProfile?.default_accepts_fps ?? false,
        acceptsPayme: hostProfile?.default_accepts_payme ?? false,
        isPaid: member.is_host || outstandingAmount <= 0,
        outstandingAmount,
      } satisfies ClaimedExpenseRecord
    })
    .filter((record): record is ClaimedExpenseRecord => record !== null)
    .sort((left, right) => new Date(right.expenseCreatedAt).getTime() - new Date(left.expenseCreatedAt).getTime())
}

export function computeDashboardSummary(args: {
  currentUserId: string
  sessions: Session[]
  members: SessionMember[]
  claims: ExpenseClaim[]
  settlements: Settlement[]
}) {
  const { currentUserId, sessions, members, claims, settlements } = args
  const memberIdsForUser = members.filter((member) => member.user_id === currentUserId).map((member) => member.id)
  const memberIdSet = new Set(memberIdsForUser)
  const linkedSessions = new Set(members.filter((member) => member.user_id === currentUserId).map((member) => member.session_id))

  const totalClaimed = roundCurrency(
    claims
      .filter((claim) => memberIdSet.has(claim.member_id))
      .reduce((sum, claim) => sum + claim.share_amount, 0),
  )

  const claimsByMemberId = new Map<string, number>()
  for (const claim of claims) {
    claimsByMemberId.set(claim.member_id, roundCurrency((claimsByMemberId.get(claim.member_id) ?? 0) + claim.share_amount))
  }
  const paidByMemberId = new Map<string, number>()
  for (const settlement of settlements) {
    if (settlement.status !== 'confirmed') continue
    paidByMemberId.set(
      settlement.from_member_id,
      roundCurrency((paidByMemberId.get(settlement.from_member_id) ?? 0) + settlement.amount),
    )
  }

  let actualSpent = 0
  let pendingToReceive = 0

  for (const member of members.filter((entry) => entry.user_id === currentUserId)) {
    const memberClaimed = claimsByMemberId.get(member.id) ?? 0

    if (member.is_host) {
      const sessionMembers = members.filter((entry) => entry.session_id === member.session_id && !entry.is_host)
      const sessionPendingToReceive = roundCurrency(
        sessionMembers.reduce((sessionSum, sessionMember) => {
          const claimed = claimsByMemberId.get(sessionMember.id) ?? 0
          const paid = paidByMemberId.get(sessionMember.id) ?? 0
          return sessionSum + Math.max(0, roundCurrency(claimed - paid))
        }, 0),
      )
      pendingToReceive = roundCurrency(pendingToReceive + sessionPendingToReceive)
      actualSpent = roundCurrency(actualSpent + memberClaimed + sessionPendingToReceive)
      continue
    }

    actualSpent = roundCurrency(actualSpent + memberClaimed)
  }

  return {
    totalSpent: totalClaimed,
    actualSpent,
    pendingToReceive,
    sessionsCount: sessions.filter((session) => linkedSessions.has(session.id)).length,
  } satisfies DashboardSummary
}

export function buildCsv(records: ClaimedExpenseRecord[]) {
  const rows = [
    [
      'date',
      'session_name',
      'expense_name',
      'expense_total_amount',
      'my_share_amount',
      'currency',
      'host_name',
      'accepts_fps',
      'accepts_payme',
      'payment_comment',
    ],
    ...records.map((record) => [
      record.expenseCreatedAt,
      record.sessionName,
      record.expenseName,
      record.expenseTotalAmount.toFixed(2),
      record.myShareAmount.toFixed(2),
      record.currency,
      record.hostName,
      record.acceptsFps ? 'yes' : 'no',
      record.acceptsPayme ? 'yes' : 'no',
      record.hostPaymentComment ?? '',
    ]),
  ]

  return rows
    .map((row) =>
      row
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(','),
    )
    .join('\n')
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
