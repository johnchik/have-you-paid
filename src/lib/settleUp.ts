import type { Expense, ExpenseClaim, SessionMember, Settlement } from './types'

export type MemberBalance = {
  owed: number
  paid: number
  received: number
  outstanding: number
}

export function roundCurrency(value: number) {
  return Math.round(value * 100) / 100
}

export function distributeEvenAmounts(total: number, count: number) {
  if (count <= 0) return []

  const cents = Math.round(total * 100)
  const base = Math.floor(cents / count)
  const remainder = cents % count

  return Array.from({ length: count }, (_unused, index) => (base + (index < remainder ? 1 : 0)) / 100)
}

export function distributeEvenAmountsFair(
  total: number,
  memberIds: string[],
  runningTotals: Record<string, number>,
) {
  if (memberIds.length === 0) return []

  const cents = Math.round(total * 100)
  const base = Math.floor(cents / memberIds.length)
  const remainder = cents % memberIds.length
  const sortedIds = [...memberIds].sort((left, right) => {
    const leftTotal = runningTotals[left] ?? 0
    const rightTotal = runningTotals[right] ?? 0
    if (leftTotal !== rightTotal) return leftTotal - rightTotal
    return left.localeCompare(right)
  })
  const extraCentIds = new Set(sortedIds.slice(0, remainder))

  return memberIds.map((memberId) => (base + (extraCentIds.has(memberId) ? 1 : 0)) / 100)
}

export function computeMemberBalances(
  members: SessionMember[],
  expenses: Expense[],
  claims: ExpenseClaim[],
  settlements: Settlement[],
) {
  const expenseIds = new Set(expenses.map((expense) => expense.id))
  const balances: Record<string, MemberBalance> = {}

  for (const member of members) {
    balances[member.id] = {
      owed: 0,
      paid: 0,
      received: 0,
      outstanding: 0,
    }
  }

  for (const claim of claims) {
    if (!expenseIds.has(claim.expense_id) || !balances[claim.member_id]) continue
    balances[claim.member_id].owed = roundCurrency(balances[claim.member_id].owed + claim.share_amount)
  }

  for (const settlement of settlements) {
    if (settlement.status !== 'confirmed') continue

    if (balances[settlement.from_member_id]) {
      balances[settlement.from_member_id].paid = roundCurrency(
        balances[settlement.from_member_id].paid + settlement.amount,
      )
    }

    if (balances[settlement.to_member_id]) {
      balances[settlement.to_member_id].received = roundCurrency(
        balances[settlement.to_member_id].received + settlement.amount,
      )
    }
  }

  for (const member of members) {
    const entry = balances[member.id]
    entry.outstanding = roundCurrency(Math.max(0, entry.owed - entry.paid))
  }

  return balances
}

export function summarizeExpenseClaims(
  expenseId: string,
  claims: ExpenseClaim[],
  members: SessionMember[],
) {
  const memberNames = new Map(members.map((member) => [member.id, member.display_name]))
  const relevantClaims = claims.filter((claim) => claim.expense_id === expenseId)

  if (relevantClaims.length === 0) return 'Unassigned'

  return relevantClaims
    .map((claim) => `${memberNames.get(claim.member_id) ?? 'Unknown'} $${claim.share_amount.toFixed(2)}`)
    .join(', ')
}
