import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IoAddOutline,
  IoArrowUndoOutline,
  IoCameraOutline,
  IoCheckmarkCircleOutline,
  IoChevronDownOutline,
  IoChevronUpOutline,
  IoCloudUploadOutline,
  IoCloseCircleOutline,
  IoCopyOutline,
  IoCreateOutline,
  IoFlashOutline,
  IoPersonAddOutline,
  IoPricetagOutline,
  IoQrCodeOutline,
  IoReceiptOutline,
  IoSparklesOutline,
  IoStatsChartOutline,
  IoWalletOutline,
} from 'react-icons/io5'
import { ErrorPopup } from '../components/ErrorPopup'
import { OcrReviewDialog } from '../components/OcrReviewDialog'
import { useAuth } from '../lib/auth'
import { formatErrorMessage } from '../lib/errors'
import { getOrCreateGuestToken } from '../lib/guestIdentity'
import type { OcrDraftItem } from '../lib/ocr'
import { runReceiptOcr } from '../lib/ocr'
import { formatSessionCreatedAt } from '../lib/sessionDisplay'
import {
  computeMemberBalances,
  distributeEvenAmounts,
  distributeEvenAmountsFair,
  roundCurrency,
  summarizeExpenseClaims,
} from '../lib/settleUp'
import { supabase } from '../lib/supabaseClient'
import type { Expense, ExpenseClaim, Profile, Session, SessionMember, Settlement } from '../lib/types'
import { joinSessionUrl } from '../lib/urls'
import { isUuid } from '../lib/uuid'

type SplitMode = 'equal' | 'custom'

function formatMoney(value: number) {
  return `$${value.toFixed(2)}`
}

function getSessionStatusLabel(status: Session['status']) {
  return status === 'settled' ? 'Settled' : 'Open'
}

function parseAmount(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null
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

function buildCustomAmountDraft(
  total: number,
  selectedMemberIds: string[],
  currentAmounts: Record<string, string>,
  editedMemberIds: string[],
) {
  const nextAmounts: Record<string, string> = {}
  const activeEditedIds = selectedMemberIds.filter((memberId) => {
    if (!editedMemberIds.includes(memberId)) return false
    const value = parseAmount(currentAmounts[memberId] ?? '')
    return value != null
  })
  const editedIdSet = new Set(activeEditedIds)

  let explicitSum = 0
  for (const memberId of selectedMemberIds) {
    const parsed = parseAmount(currentAmounts[memberId] ?? '')
    if (editedIdSet.has(memberId) && parsed != null) {
      explicitSum = roundCurrency(explicitSum + parsed)
      nextAmounts[memberId] = parsed.toFixed(2)
    }
  }

  const remainingMemberIds = selectedMemberIds.filter((memberId) => !editedIdSet.has(memberId))
  if (remainingMemberIds.length > 0) {
    const remaining = roundCurrency(Math.max(0, total - explicitSum))
    const evenAmounts = distributeEvenAmounts(remaining, remainingMemberIds.length)
    remainingMemberIds.forEach((memberId, index) => {
      nextAmounts[memberId] = evenAmounts[index].toFixed(2)
    })
  }

  return {
    amounts: nextAmounts,
    editedMemberIds: activeEditedIds,
  }
}

function allocateBulkEqualSplit(
  selectedExpenses: Expense[],
  selectedMemberIds: string[],
  currentOwedTotals: Record<string, number>,
) {
  const totalSelectedAmount = roundCurrency(selectedExpenses.reduce((sum, expense) => sum + expense.amount, 0))
  const targetShares = distributeEvenAmountsFair(totalSelectedAmount, selectedMemberIds, currentOwedTotals)
  const targetCentsByMember = Object.fromEntries(
    selectedMemberIds.map((memberId, index) => [memberId, Math.round(targetShares[index] * 100)]),
  )
  const allocatedCentsByMember = Object.fromEntries(selectedMemberIds.map((memberId) => [memberId, 0]))
  const rows: Array<{ expense_id: string; member_id: string; share_amount: number }> = []

  for (const expense of selectedExpenses) {
    const expenseCents = Math.round(expense.amount * 100)
    const claimCentsByMember = Object.fromEntries(selectedMemberIds.map((memberId) => [memberId, 0]))

    for (let centIndex = 0; centIndex < expenseCents; centIndex += 1) {
      let bestMemberId = selectedMemberIds[0]
      let bestRemaining = -Infinity

      for (const memberId of selectedMemberIds) {
        const remaining =
          targetCentsByMember[memberId] - allocatedCentsByMember[memberId] - claimCentsByMember[memberId]
        if (remaining > bestRemaining) {
          bestRemaining = remaining
          bestMemberId = memberId
        }
      }

      claimCentsByMember[bestMemberId] += 1
    }

    for (const memberId of selectedMemberIds) {
      allocatedCentsByMember[memberId] += claimCentsByMember[memberId]
      rows.push({
        expense_id: expense.id,
        member_id: memberId,
        share_amount: claimCentsByMember[memberId] / 100,
      })
    }
  }

  return rows
}

export function SessionPage() {
  const { sessionId } = useParams()
  const { user, ready } = useAuth()
  const guestToken = useMemo(() => getOrCreateGuestToken(), [])

  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [members, setMembers] = useState<SessionMember[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [claims, setClaims] = useState<ExpenseClaim[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [receiptImageUrl, setReceiptImageUrl] = useState<string | null>(null)
  const [hostProfile, setHostProfile] = useState<Profile | null>(null)

  const [sessionNameDraft, setSessionNameDraft] = useState('')
  const [placeholderName, setPlaceholderName] = useState('')
  const [manualExpenseName, setManualExpenseName] = useState('')
  const [manualExpenseAmount, setManualExpenseAmount] = useState('')
  const [savingSessionName, setSavingSessionName] = useState(false)
  const [addingPlaceholder, setAddingPlaceholder] = useState(false)
  const [addingExpense, setAddingExpense] = useState(false)
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const [settlementBusyMemberId, setSettlementBusyMemberId] = useState<string | null>(null)
  const [joinUrlCopied, setJoinUrlCopied] = useState(false)
  const [receiptExpanded, setReceiptExpanded] = useState(false)

  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrSaving, setOcrSaving] = useState(false)
  const [ocrProgressMessage, setOcrProgressMessage] = useState<string | null>(null)
  const [ocrDraftItems, setOcrDraftItems] = useState<OcrDraftItem[]>([])
  const [ocrReviewOpen, setOcrReviewOpen] = useState(false)
  const ocrFileInputRef = useRef<HTMLInputElement>(null)
  const receiptFileInputRef = useRef<HTMLInputElement>(null)
  const receiptCaptureInputRef = useRef<HTMLInputElement>(null)

  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [splitMode, setSplitMode] = useState<SplitMode>('equal')
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({})
  const [customEditedMemberIds, setCustomEditedMemberIds] = useState<string[]>([])
  const [activeCustomMemberId, setActiveCustomMemberId] = useState<string | null>(null)
  const [savingSplit, setSavingSplit] = useState(false)
  const [bulkSelectedMemberIds, setBulkSelectedMemberIds] = useState<string[]>([])
  const [bulkSelectedExpenseIds, setBulkSelectedExpenseIds] = useState<string[]>([])
  const [bulkApplying, setBulkApplying] = useState(false)

  const load = useCallback(async () => {
    if (!sessionId) return
    if (!isUuid(sessionId)) {
      setLoadError('Invalid session link.')
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadError(null)

    try {
      const { data: sessionRow, error: sessionError } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle()
      if (sessionError) throw sessionError
      if (!sessionRow) {
        throw new Error('This session was not found.')
      }

      const { data: memberRows, error: memberError } = await supabase
        .from('session_members')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
      if (memberError) throw memberError
      const loadedMembers = (memberRows ?? []) as SessionMember[]
      const loadedHostMember = loadedMembers.find((member) => member.is_host) ?? null

      let loadedHostProfile: Profile | null = null
      if (loadedHostMember?.user_id) {
        const { data: hostPaymentRows, error: hostPaymentError } = await supabase.rpc('get_session_host_payment_details', {
          p_session_id: sessionId,
        })
        if (hostPaymentError) throw hostPaymentError

        const hostPaymentRow = Array.isArray(hostPaymentRows) ? hostPaymentRows[0] : null
        if (hostPaymentRow) {
          loadedHostProfile = {
            id: loadedHostMember.user_id,
            display_name: hostPaymentRow.display_name ?? loadedHostMember.display_name,
            default_payment_comment: hostPaymentRow.default_payment_comment ?? null,
            default_accepts_fps: hostPaymentRow.default_accepts_fps ?? false,
            default_accepts_payme: hostPaymentRow.default_accepts_payme ?? false,
            payment_qr_url: null,
            updated_at: '',
          }
        }
      }

      const { data: expenseRows, error: expenseError } = await supabase
        .from('expenses')
        .select('*')
        .eq('session_id', sessionId)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
      if (expenseError) throw expenseError

      const loadedExpenses = (expenseRows ?? []) as Expense[]
      const expenseIds = loadedExpenses.map((expense) => expense.id)

      let loadedClaims: ExpenseClaim[] = []
      if (expenseIds.length > 0) {
        const { data: claimRows, error: claimError } = await supabase
          .from('expense_claims')
          .select('*')
          .in('expense_id', expenseIds)
        if (claimError) throw claimError
        loadedClaims = (claimRows ?? []) as ExpenseClaim[]
      }

      const { data: settlementRows, error: settlementError } = await supabase
        .from('settlements')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
      if (settlementError) throw settlementError

      setSession(sessionRow as Session)
      setSessionNameDraft((sessionRow as Session).name)
      setHostProfile(loadedHostProfile)
      setMembers(loadedMembers)
      setExpenses(loadedExpenses)
      setClaims(loadedClaims)
      setSettlements((settlementRows ?? []) as Settlement[])

      const receiptPath = (sessionRow as Session).receipt_storage_path?.trim()
      if (receiptPath) {
        const { data: signedData, error: signedError } = await supabase.storage
          .from('receipts')
          .createSignedUrl(receiptPath, 3600)
        if (signedError) {
          setReceiptImageUrl(null)
        } else {
          setReceiptImageUrl(signedData?.signedUrl ?? null)
        }
      } else {
        setReceiptImageUrl(null)
      }
    } catch (error: unknown) {
      setLoadError(formatErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!ready) return
    void load()
  }, [load, ready])

  useEffect(() => {
    if (!sessionId || !ready || !isUuid(sessionId)) return

    const channel = supabase
      .channel(`settle-up-session:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, () => {
        void load()
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'session_members', filter: `session_id=eq.${sessionId}` },
        () => {
          void load()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'expenses', filter: `session_id=eq.${sessionId}` },
        () => {
          void load()
        },
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expense_claims' }, () => {
        void load()
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settlements', filter: `session_id=eq.${sessionId}` },
        () => {
          void load()
        },
      )

    void channel.subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load, ready, sessionId])

  useEffect(() => {
    if (!actionError) return
    const timer = window.setTimeout(() => setActionError(null), 4500)
    return () => window.clearTimeout(timer)
  }, [actionError])

  useEffect(() => {
    setReceiptExpanded(!session?.receipt_storage_path)
  }, [session?.receipt_storage_path])

  const currentMember = useMemo(() => {
    const byGuestToken = members.find((member) => member.guest_token === guestToken)
    if (byGuestToken) return byGuestToken
    if (user?.id) {
      return members.find((member) => member.user_id === user.id) ?? null
    }
    return null
  }, [guestToken, members, user?.id])

  const hostMember = useMemo(() => members.find((member) => member.is_host) ?? null, [members])
  const isHost = currentMember?.id === hostMember?.id
  const joinUrl = sessionId ? joinSessionUrl(sessionId) : ''

  useEffect(() => {
    if (!sessionId || !currentMember || !user?.id) return
    if (currentMember.user_id === user.id && currentMember.status === 'linked') return
    if (currentMember.guest_token !== guestToken) return
    if (currentMember.status === 'placeholder') return

    void (async () => {
      await supabase
        .from('session_members')
        .update({
          user_id: user.id,
          status: 'linked',
        })
        .eq('id', currentMember.id)
      await load()
    })()
  }, [currentMember, guestToken, load, sessionId, user?.id])

  const balances = useMemo(
    () => computeMemberBalances(members, expenses, claims, settlements),
    [claims, expenses, members, settlements],
  )
  const owedTotalsByMember = useMemo(
    () => Object.fromEntries(members.map((member) => [member.id, balances[member.id]?.owed ?? 0])),
    [balances, members],
  )

  const currentOutstanding = currentMember ? balances[currentMember.id]?.outstanding ?? 0 : 0
  const hostReceivable = useMemo(
    () =>
      members
        .filter((member) => !member.is_host)
        .reduce((sum, member) => sum + (balances[member.id]?.outstanding ?? 0), 0),
    [balances, members],
  )
  const latestConfirmedSettlementByMember = useMemo(() => {
    const entries = settlements
      .filter((settlement) => settlement.status === 'confirmed' && settlement.to_member_id === hostMember?.id)
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())

    return new Map(
      entries.map((settlement) => [settlement.from_member_id, settlement] as const).filter((entry, index, array) => {
        return array.findIndex(([memberId]) => memberId === entry[0]) === index
      }),
    )
  }, [hostMember?.id, settlements])

  const editingExpense = editingExpenseId ? expenses.find((expense) => expense.id === editingExpenseId) ?? null : null
  const bulkSelectedMembers = members.filter((member) => bulkSelectedMemberIds.includes(member.id))
  const bulkSelectedExpenses = expenses.filter((expense) => bulkSelectedExpenseIds.includes(expense.id))
  const totalExpenseAmount = useMemo(
    () => roundCurrency(expenses.reduce((sum, expense) => sum + expense.amount, 0)),
    [expenses],
  )
  const confirmedSettlementAmount = useMemo(
    () =>
      roundCurrency(
        settlements
          .filter((settlement) => settlement.status === 'confirmed')
          .reduce((sum, settlement) => sum + settlement.amount, 0),
      ),
    [settlements],
  )
  const sessionSummaryAmount = isHost ? hostReceivable : currentOutstanding
  const sessionSummaryLabel = isHost ? 'Still to receive' : 'You currently owe'

  const openSplitEditor = (expense: Expense) => {
    const existingClaims = claims.filter((claim) => claim.expense_id === expense.id)
    setEditingExpenseId(expense.id)

    if (existingClaims.length === 0) {
      if (currentMember) {
        setSelectedMemberIds([currentMember.id])
      } else {
        setSelectedMemberIds([])
      }
      setSplitMode('equal')
      setCustomAmounts({})
      setCustomEditedMemberIds([])
      return
    }

    const nextSelectedMemberIds = existingClaims.map((claim) => claim.member_id)
    const nextCustomAmounts = Object.fromEntries(
      existingClaims.map((claim) => [claim.member_id, claim.share_amount.toFixed(2)]),
    )
    setSelectedMemberIds(nextSelectedMemberIds)
    setCustomAmounts(nextCustomAmounts)

    const evenSplit = distributeEvenAmounts(expense.amount, existingClaims.length)
    const matchesEvenSplit =
      evenSplit.length === existingClaims.length &&
      existingClaims.every((claim, index) => roundCurrency(claim.share_amount) === roundCurrency(evenSplit[index]))

    setSplitMode(matchesEvenSplit ? 'equal' : 'custom')
    setCustomEditedMemberIds(matchesEvenSplit ? [] : nextSelectedMemberIds)
  }

  const closeSplitEditor = () => {
    setEditingExpenseId(null)
    setSelectedMemberIds([])
    setCustomAmounts({})
    setCustomEditedMemberIds([])
    setActiveCustomMemberId(null)
    setSavingSplit(false)
    setActionError(null)
  }

  const toggleBulkMemberSelection = (memberId: string, checked: boolean) => {
    setBulkSelectedMemberIds((current) =>
      checked ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId),
    )
  }

  const toggleBulkExpenseSelection = (expenseId: string, checked: boolean) => {
    setBulkSelectedExpenseIds((current) =>
      checked ? [...new Set([...current, expenseId])] : current.filter((id) => id !== expenseId),
    )
  }

  const selectAllBulkMembers = () => {
    setBulkSelectedMemberIds(members.map((member) => member.id))
  }

  const invertBulkMembers = () => {
    setBulkSelectedMemberIds(members.filter((member) => !bulkSelectedMemberIds.includes(member.id)).map((member) => member.id))
  }

  const selectAllBulkExpenses = () => {
    setBulkSelectedExpenseIds(expenses.map((expense) => expense.id))
  }

  const invertBulkExpenses = () => {
    setBulkSelectedExpenseIds(expenses.filter((expense) => !bulkSelectedExpenseIds.includes(expense.id)).map((expense) => expense.id))
  }

  const saveSessionName = async () => {
    if (!isHost || !session) return
    const trimmed = sessionNameDraft.trim()
    if (!trimmed) {
      setActionError('Session name is required.')
      return
    }

    setSavingSessionName(true)
    setActionError(null)
    try {
      const { error } = await supabase
        .from('sessions')
        .update({
          name: trimmed,
        })
        .eq('id', session.id)
      if (error) throw error
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setSavingSessionName(false)
    }
  }

  const uploadReceipt = async (file: File) => {
    if (!isHost || !sessionId) return
    if (!file.type.startsWith('image/')) {
      setActionError('Please choose an image file.')
      return
    }

    setUploadingReceipt(true)
    setActionError(null)

    try {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
      const path = `${sessionId}/receipt.${extension}`

      const { error: uploadError } = await supabase.storage.from('receipts').upload(path, file, {
        upsert: true,
        contentType: file.type || 'image/jpeg',
      })
      if (uploadError) throw uploadError

      const { error: updateError } = await supabase
        .from('sessions')
        .update({ receipt_storage_path: path })
        .eq('id', sessionId)
      if (updateError) throw updateError

      if (receiptFileInputRef.current) receiptFileInputRef.current.value = ''
      if (receiptCaptureInputRef.current) receiptCaptureInputRef.current.value = ''

      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setUploadingReceipt(false)
    }
  }

  const addPlaceholder = async () => {
    if (!isHost || !sessionId) return
    const trimmed = placeholderName.trim()
    if (!trimmed) {
      setActionError('Placeholder name is required.')
      return
    }

    setAddingPlaceholder(true)
    setActionError(null)
    try {
      const { error } = await supabase.from('session_members').insert({
        session_id: sessionId,
        display_name: trimmed,
        is_host: false,
        status: 'placeholder',
      })
      if (error) throw error
      setPlaceholderName('')
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setAddingPlaceholder(false)
    }
  }

  const resetMemberClaim = async (member: SessionMember) => {
    if (!isHost || member.is_host) return

    setActionError(null)
    try {
      const { error } = await supabase
        .from('session_members')
        .update({
          status: 'placeholder',
          display_name: member.display_name,
        })
        .eq('id', member.id)
      if (error) throw error
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    }
  }

  const removePlaceholder = async (member: SessionMember) => {
    if (!isHost || member.is_host || member.status !== 'placeholder') return

    setActionError(null)
    try {
      const affectedExpenses = expenses.filter((expense) =>
        claims.some((claim) => claim.expense_id === expense.id && claim.member_id === member.id),
      )

      const { error: deleteMemberError } = await supabase.from('session_members').delete().eq('id', member.id)
      if (deleteMemberError) throw deleteMemberError

      for (const expense of affectedExpenses) {
        const remainingMemberIds = [
          ...new Set(
            claims
              .filter((claim) => claim.expense_id === expense.id && claim.member_id !== member.id)
              .map((claim) => claim.member_id),
          ),
        ]

        const { error: deleteClaimsError } = await supabase.from('expense_claims').delete().eq('expense_id', expense.id)
        if (deleteClaimsError) throw deleteClaimsError

        if (remainingMemberIds.length === 0) continue

        const shareAmounts = distributeEvenAmounts(expense.amount, remainingMemberIds.length)
        const rows = remainingMemberIds.map((memberId, index) => ({
          expense_id: expense.id,
          member_id: memberId,
          share_amount: shareAmounts[index],
        }))

        const { error: insertClaimsError } = await supabase.from('expense_claims').insert(rows)
        if (insertClaimsError) throw insertClaimsError
      }

      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    }
  }

  const addManualExpense = async () => {
    if (!isHost || !sessionId) return
    const trimmedName = manualExpenseName.trim()
    const amount = parseAmount(manualExpenseAmount)

    if (!trimmedName) {
      setActionError('Expense name is required.')
      return
    }
    if (amount == null || amount <= 0) {
      setActionError('Expense amount must be greater than zero.')
      return
    }

    setAddingExpense(true)
    setActionError(null)

    try {
      const nextSortOrder = expenses.reduce((max, expense) => Math.max(max, expense.sort_order ?? 0), 0) + 1
      const { error } = await supabase.from('expenses').insert({
        session_id: sessionId,
        name: trimmedName,
        amount,
        source: 'manual',
        sort_order: nextSortOrder,
      })
      if (error) throw error

      setManualExpenseName('')
      setManualExpenseAmount('')
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setAddingExpense(false)
    }
  }

  const saveSplitClaims = async () => {
    if (!editingExpense) return

    const uniqueMemberIds = [...new Set(selectedMemberIds)]
    if (uniqueMemberIds.length === 0) {
      setActionError('Select at least one member.')
      return
    }

    let shareAmounts: number[] = []
    let nextExpenseAmount = editingExpense.amount
    if (splitMode === 'equal') {
      shareAmounts = distributeEvenAmounts(editingExpense.amount, uniqueMemberIds.length)
    } else {
      const parsed = uniqueMemberIds.map((memberId) => parseAmount(customAmounts[memberId] ?? ''))
      if (parsed.some((amount) => amount == null || amount <= 0)) {
        setActionError('Custom split amounts must all be greater than zero.')
        return
      }

      const values = parsed as number[]
      const total = roundCurrency(values.reduce((sum, value) => sum + value, 0))
      nextExpenseAmount = total
      shareAmounts = values
    }

    setSavingSplit(true)
    setActionError(null)

    try {
      if (roundCurrency(editingExpense.amount) !== roundCurrency(nextExpenseAmount)) {
        const { error: updateExpenseError } = await supabase
          .from('expenses')
          .update({ amount: nextExpenseAmount })
          .eq('id', editingExpense.id)
        if (updateExpenseError) throw updateExpenseError
      }

      const { error: deleteError } = await supabase.from('expense_claims').delete().eq('expense_id', editingExpense.id)
      if (deleteError) throw deleteError

      const rows = uniqueMemberIds.map((memberId, index) => ({
        expense_id: editingExpense.id,
        member_id: memberId,
        share_amount: shareAmounts[index],
      }))

      const { error: insertError } = await supabase.from('expense_claims').insert(rows)
      if (insertError) throw insertError

      await load()
      closeSplitEditor()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setSavingSplit(false)
    }
  }

  const applyBulkSplit = async () => {
    if (bulkSelectedMemberIds.length === 0) {
      setActionError('Select at least one member for bulk split.')
      return
    }
    if (bulkSelectedExpenseIds.length === 0) {
      setActionError('Select at least one expense for bulk split.')
      return
    }

    setBulkApplying(true)
    setActionError(null)

    try {
      const rows = allocateBulkEqualSplit(bulkSelectedExpenses, bulkSelectedMemberIds, owedTotalsByMember)
      for (const expense of bulkSelectedExpenses) {
        const { error: deleteError } = await supabase.from('expense_claims').delete().eq('expense_id', expense.id)
        if (deleteError) throw deleteError
      }

      const { error: insertError } = await supabase.from('expense_claims').insert(rows)
      if (insertError) throw insertError

      for (const expense of bulkSelectedExpenses) {
        const totalForExpense = roundCurrency(
          rows.filter((row) => row.expense_id === expense.id).reduce((sum, row) => sum + row.share_amount, 0),
        )
        if (totalForExpense !== roundCurrency(expense.amount)) {
          throw new Error(`Bulk split allocation mismatch on ${expense.name}.`)
        }
      }

      setBulkSelectedExpenseIds([])
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setBulkApplying(false)
    }
  }

  const applyBulkAddMe = async () => {
    if (!currentMember) {
      setActionError('Join the session before adding yourself to expenses.')
      return
    }
    if (bulkSelectedExpenseIds.length === 0) {
      setActionError('Select at least one expense to add yourself to.')
      return
    }

    setBulkApplying(true)
    setActionError(null)

    try {
      for (const expense of bulkSelectedExpenses) {
        const existingClaims = claims.filter((claim) => claim.expense_id === expense.id)
        const nextMemberIds = [...new Set([...existingClaims.map((claim) => claim.member_id), currentMember.id])]
        const shareAmounts = distributeEvenAmounts(expense.amount, nextMemberIds.length)

        const { error: deleteError } = await supabase.from('expense_claims').delete().eq('expense_id', expense.id)
        if (deleteError) throw deleteError

        const rows = nextMemberIds.map((memberId, index) => ({
          expense_id: expense.id,
          member_id: memberId,
          share_amount: shareAmounts[index],
        }))

        const { error: insertError } = await supabase.from('expense_claims').insert(rows)
        if (insertError) throw insertError
      }

      setBulkSelectedExpenseIds([])
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setBulkApplying(false)
    }
  }

  const runOcrForFile = async (file: File) => {
    if (!isHost) return
    if (!file.type.startsWith('image/')) {
      setActionError('Please choose an image file.')
      return
    }

    setOcrBusy(true)
    setActionError(null)
    setOcrProgressMessage(null)

    try {
      const items = await runReceiptOcr(file, (message) => setOcrProgressMessage(message))
      setOcrDraftItems(items)
      setOcrReviewOpen(true)
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setOcrBusy(false)
    }
  }

  const runOcrOnSavedReceipt = async () => {
    if (!isHost || !receiptImageUrl) return

    setOcrBusy(true)
    setActionError(null)
    setOcrProgressMessage('Loading saved receipt…')

    try {
      const response = await fetch(receiptImageUrl)
      if (!response.ok) {
        throw new Error('Failed to load the saved receipt image.')
      }
      const blob = await response.blob()
      const items = await runReceiptOcr(blob, (message) => setOcrProgressMessage(message))
      setOcrDraftItems(items)
      setOcrReviewOpen(true)
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setOcrBusy(false)
    }
  }

  const saveOcrItems = async (items: OcrDraftItem[]) => {
    if (!isHost || !sessionId) return

    const expenseRows = items
      .map((item) => ({
        name: item.label.trim(),
        amount: roundCurrency(item.unitPrice ?? 0),
        source: 'ocr' as const,
        ocr_confidence: item.confidence,
      }))
      .filter((item) => item.name.length > 0 && item.amount > 0)

    if (expenseRows.length === 0) {
      setActionError('OCR did not produce any expenses with a usable price.')
      return
    }

    setOcrSaving(true)
    setActionError(null)
    try {
      let nextSortOrder = expenses.reduce((max, expense) => Math.max(max, expense.sort_order ?? 0), 0)
      const rows = expenseRows.map((item) => {
        nextSortOrder += 1
        return {
          session_id: sessionId,
          name: item.name,
          amount: item.amount,
          source: item.source,
          sort_order: nextSortOrder,
          ocr_confidence: item.ocr_confidence,
        }
      })

      const { error } = await supabase.from('expenses').insert(rows)
      if (error) throw error

      setOcrReviewOpen(false)
      setOcrDraftItems([])
      setOcrProgressMessage(null)
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setOcrSaving(false)
    }
  }

  const markSettlementPaid = async (member: SessionMember) => {
    if (!sessionId || !hostMember) return

    const amount = balances[member.id]?.outstanding ?? 0
    if (amount <= 0) return

    setSettlementBusyMemberId(member.id)
    setActionError(null)

    try {
      const { error } = await supabase.from('settlements').insert({
        session_id: sessionId,
        from_member_id: member.id,
        to_member_id: hostMember.id,
        amount,
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      if (error) throw error
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setSettlementBusyMemberId(null)
    }
  }

  const undoSettlementPaid = async (settlement: Settlement) => {
    setSettlementBusyMemberId(settlement.from_member_id)
    setActionError(null)

    try {
      const { error } = await supabase.from('settlements').delete().eq('id', settlement.id)
      if (error) throw error
      await load()
    } catch (error: unknown) {
      setActionError(formatErrorMessage(error))
    } finally {
      setSettlementBusyMemberId(null)
    }
  }

  const copyJoinLink = async () => {
    if (!joinUrl) return
    await navigator.clipboard.writeText(joinUrl)
    setJoinUrlCopied(true)
    window.setTimeout(() => setJoinUrlCopied(false), 1600)
  }

  const combinedHostPaymentComment = [hostProfile?.default_payment_comment?.trim(), session?.host_payment_comment?.trim()]
    .filter((part) => Boolean(part))
    .join('\n')

  const updateSplitMode = (nextMode: SplitMode) => {
    if (!editingExpense) return
    setSplitMode(nextMode)

    if (nextMode === 'custom') {
      const seededAmounts =
        selectedMemberIds.length > 0
          ? Object.fromEntries(
              selectedMemberIds.map((memberId, index) => [
                memberId,
                distributeEvenAmounts(editingExpense.amount, selectedMemberIds.length)[index].toFixed(2),
              ]),
            )
          : {}
      const draft = buildCustomAmountDraft(editingExpense.amount, selectedMemberIds, seededAmounts, [])
      setCustomAmounts(draft.amounts)
      setCustomEditedMemberIds(draft.editedMemberIds)
    }
  }

  const updateSelectedMembers = (memberId: string, checked: boolean) => {
    if (!editingExpense) return

    const nextSelectedMemberIds = checked
      ? [...selectedMemberIds, memberId]
      : selectedMemberIds.filter((id) => id !== memberId)

    setSelectedMemberIds(nextSelectedMemberIds)

    if (splitMode === 'custom') {
      const nextEditedMemberIds = checked
        ? customEditedMemberIds
        : customEditedMemberIds.filter((id) => id !== memberId)
      const nextAmounts = { ...customAmounts }
      if (!checked) {
        delete nextAmounts[memberId]
      }
      const draft = buildCustomAmountDraft(editingExpense.amount, nextSelectedMemberIds, nextAmounts, nextEditedMemberIds)
      setCustomAmounts(draft.amounts)
      setCustomEditedMemberIds(draft.editedMemberIds)
    }
  }

  const updateCustomAmount = (memberId: string, value: string) => {
    setCustomAmounts((current) => ({
      ...current,
      [memberId]: value,
    }))
  }

  const finalizeCustomAmount = (memberId: string) => {
    if (!editingExpense) return

    const value = customAmounts[memberId] ?? ''
    const nextEditedMemberIds = value.trim()
      ? [...new Set([...customEditedMemberIds, memberId])]
      : customEditedMemberIds.filter((id) => id !== memberId)

    const draft = buildCustomAmountDraft(editingExpense.amount, selectedMemberIds, customAmounts, nextEditedMemberIds)
    setCustomAmounts(draft.amounts)
    setCustomEditedMemberIds(draft.editedMemberIds)
    setActiveCustomMemberId(null)
  }

  if (!ready) {
    return (
      <div className="appShell">
        <p className="muted">Loading session…</p>
      </div>
    )
  }

  if (!sessionId || !isUuid(sessionId)) {
    return (
      <div className="appShell stack">
        <h1 className="h1">Session</h1>
        <div className="alert">Invalid session link.</div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="appShell">
        <p className="muted">Loading session…</p>
      </div>
    )
  }

  if (loadError || !session) {
    return (
      <div className="appShell stack">
        <h1 className="h1">Session</h1>
        <div className="alert">{loadError ?? 'Session not found.'}</div>
      </div>
    )
  }

  return (
    <div className="appShell sessionPage stack">
      <header className="card heroCard revealCard">
        <div className="sessionHeroLayout">
          <div className="heroMain stack">
            <div className="heroPills">
              <span className="infoPill infoPillWarm">
                <IoReceiptOutline size={15} aria-hidden />
                <span>Created {formatSessionCreatedAt(session.created_at)}</span>
              </span>
              <span className="infoPill">
                <IoPricetagOutline size={15} aria-hidden />
                <span>{session.currency}</span>
              </span>
              <span className={`infoPill ${session.status === 'settled' ? 'infoPillSuccess' : 'infoPillAccent'}`}>
                <IoCheckmarkCircleOutline size={15} aria-hidden />
                <span>{getSessionStatusLabel(session.status)}</span>
              </span>
            </div>

            <div className="stack compactStack">
              <h1 className="pageTitle">{session.name}</h1>
              {currentMember ? (
                <p className="heroSummary">
                  You are <strong>{currentMember.display_name}</strong>. {sessionSummaryLabel} {formatMoney(sessionSummaryAmount)}.
                </p>
              ) : (
                <p className="heroSummary">
                  This browser has not claimed a member yet. <Link to={`/join/${session.id}`}>Claim a placeholder or join the session.</Link>
                </p>
              )}
            </div>

            <div className="heroMetrics">
              <div className="heroMetricCard">
                <span className="heroMetricLabel">{isHost ? 'Still to receive' : 'Your balance'}</span>
                <strong>{formatMoney(sessionSummaryAmount)}</strong>
              </div>
              <div className="heroMetricCard">
                <span className="heroMetricLabel">Members</span>
                <strong>{members.length}</strong>
              </div>
              <div className="heroMetricCard">
                <span className="heroMetricLabel">Expenses</span>
                <strong>{expenses.length}</strong>
              </div>
            </div>

            {isHost ? (
              <div className="stack">
                <div className="inlineFormCard">
                  <label className="field growField">
                    Session name
                    <input
                      type="text"
                      value={sessionNameDraft}
                      onChange={(event) => setSessionNameDraft(event.target.value)}
                    />
                  </label>
                  <button type="button" className="btn btnPrimary" disabled={savingSessionName} onClick={() => void saveSessionName()}>
                    <span className="btnContent">
                      <IoCreateOutline size={17} aria-hidden />
                      <span>{savingSessionName ? 'Saving…' : 'Save host details'}</span>
                    </span>
                  </button>
                </div>

              </div>
            ) : null}
          </div>

          {isHost ? (
            <aside className="sharePanel">
              <div className="sharePanelHead">
                <span className="sharePanelIcon">
                  <IoQrCodeOutline size={18} aria-hidden />
                </span>
                <div>
                  <h2 className="sharePanelTitle">Invite people</h2>
                  <p className="muted">Scan or copy the join link.</p>
                </div>
              </div>
              <div className="qrBox">
                <QRCodeSVG value={joinUrl} size={156} />
              </div>
              <button type="button" className="btn btnGhost" onClick={() => void copyJoinLink()} aria-label="Copy join link">
                <span className="btnContent">
                  <IoCopyOutline size={17} aria-hidden />
                  <span>{joinUrlCopied ? 'Copied' : 'Copy join link'}</span>
                </span>
              </button>
            </aside>
          ) : null}
        </div>
      </header>

      <section className="card sectionCard revealCard">
        <div className="sectionHeader">
          <div>
            <div className="sectionKicker">
              <IoPersonAddOutline size={15} aria-hidden />
              <span>People</span>
            </div>
            <h2 className="sectionTitle">Members</h2>
            <p className="muted">Placeholders can be claimed later by guest token. Claims and settlements attach to the member row.</p>
          </div>
        </div>

        {isHost ? (
          <div className="inlineFormCard">
            <label className="field growField">
              New placeholder
              <input
                type="text"
                value={placeholderName}
                onChange={(event) => setPlaceholderName(event.target.value)}
                placeholder="Add a member"
              />
            </label>
            <button type="button" className="btn btnPrimary" disabled={addingPlaceholder} onClick={() => void addPlaceholder()}>
              <span className="btnContent">
                <IoAddOutline size={17} aria-hidden />
                <span>{addingPlaceholder ? 'Adding…' : 'Add placeholder'}</span>
              </span>
            </button>
          </div>
        ) : null}

        {isHost ? (
          <div className="toolbarPills">
            <button type="button" className="btn btnGhost" onClick={selectAllBulkMembers}>
              Select all members
            </button>
            <button type="button" className="btn btnGhost" onClick={invertBulkMembers}>
              Invert member selection
            </button>
          </div>
        ) : null}

        <div className="tableWrap">
          <table className="table tableActionLast dataTable">
            <thead>
              <tr>
                {isHost ? <th>Bulk</th> : null}
                <th>Name</th>
                <th>Status</th>
                <th>Owed</th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const balance = balances[member.id] ?? { owed: 0, paid: 0, received: 0, outstanding: 0 }
                const memberShare = balance.owed
                const memberPaid = member.is_host ? totalExpenseAmount : balance.paid
                const memberOutstanding = member.is_host ? roundCurrency(hostReceivable) : balance.outstanding
                const statusLabel =
                  member.status === 'placeholder'
                    ? 'Placeholder'
                    : member.status === 'linked'
                      ? 'Linked'
                      : member.guest_token === guestToken
                        ? 'Claimed by you'
                        : 'Claimed'
                const statusTone =
                  member.status === 'placeholder'
                    ? 'statusBadgeMuted'
                    : member.guest_token === guestToken
                      ? 'statusBadgeAccent'
                      : 'statusBadgeSuccess'

                return (
                  <tr key={member.id} className={member.is_host ? 'tableRowHost' : undefined}>
                    {isHost ? (
                      <td className="checkboxCell">
                        <input
                          type="checkbox"
                          checked={bulkSelectedMemberIds.includes(member.id)}
                          onChange={(event) => toggleBulkMemberSelection(member.id, event.target.checked)}
                        />
                      </td>
                    ) : null}
                    <td>
                      <div className="memberIdentity">
                        <strong>{member.display_name}</strong>
                        {member.is_host ? <span className="rolePill">Host</span> : null}
                      </div>
                    </td>
                    <td>
                      <span className={`statusBadge ${statusTone}`}>{statusLabel}</span>
                    </td>
                    <td>{member.is_host ? <span className="softLabel">Host share {formatMoney(memberShare)}</span> : formatMoney(memberShare)}</td>
                    <td>{formatMoney(memberPaid)}</td>
                    <td>{member.is_host ? <strong>{formatMoney(memberOutstanding)} to receive</strong> : formatMoney(memberOutstanding)}</td>
                    <td>
                      {isHost && !member.is_host ? (
                        <div className="row rowEnd">
                          {member.status !== 'placeholder' ? (
                            <button type="button" className="btn btnGhost" onClick={() => void resetMemberClaim(member)}>
                              <span className="btnContent">
                                <IoArrowUndoOutline size={16} aria-hidden />
                                <span>Reset claim</span>
                              </span>
                            </button>
                          ) : (
                            <button type="button" className="btn btnDanger" onClick={() => void removePlaceholder(member)}>
                              Delete
                            </button>
                          )}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card sectionCard revealCard">
        <div className="sectionHeader">
          <div>
            <div className="sectionKicker">
              <IoPricetagOutline size={15} aria-hidden />
              <span>Split</span>
            </div>
            <h2 className="sectionTitle">Expenses</h2>
            <p className="muted">Each receipt line becomes one expense. Splits are stored directly as exact `share_amount` claims.</p>
          </div>
        </div>

        {isHost ? (
          <div className="bulkAssignBar">
            <div className="stack compactStack">
              <span className="bulkTitle">Bulk equal split</span>
              <span className="muted">
                {bulkSelectedMembers.length} member{bulkSelectedMembers.length === 1 ? '' : 's'} selected · {bulkSelectedExpenses.length} expense
                {bulkSelectedExpenses.length === 1 ? '' : 's'} selected
              </span>
            </div>
            <button type="button" className="btn btnPrimary" disabled={bulkApplying} onClick={() => void applyBulkSplit()}>
              <span className="btnContent">
                <IoSparklesOutline size={17} aria-hidden />
                <span>{bulkApplying ? 'Applying…' : 'Apply equal split'}</span>
              </span>
            </button>
          </div>
        ) : currentMember ? (
          <div className="bulkAssignBar">
            <div className="stack compactStack">
              <span className="bulkTitle">Quick add me</span>
              <span className="muted">
                Add <strong>{currentMember.display_name}</strong> to {bulkSelectedExpenses.length} selected expense
                {bulkSelectedExpenses.length === 1 ? '' : 's'}.
              </span>
            </div>
            <button type="button" className="btn btnPrimary" disabled={bulkApplying} onClick={() => void applyBulkAddMe()}>
              <span className="btnContent">
                <IoPersonAddOutline size={17} aria-hidden />
                <span>{bulkApplying ? 'Applying…' : 'Confirm add me'}</span>
              </span>
            </button>
          </div>
        ) : null}

        {isHost ? (
          <>
            <div className="inlineFormCard expenseComposer">
              <label className="field growField">
                Expense name
                <input
                  type="text"
                  value={manualExpenseName}
                  onChange={(event) => setManualExpenseName(event.target.value)}
                  placeholder="Fried rice"
                />
              </label>
              <label className="field amountField">
                Amount
                <span className="inputWithPrefix">
                  <span className="inputPrefix">{session.currency}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={manualExpenseAmount}
                    onChange={(event) => setManualExpenseAmount(event.target.value)}
                    placeholder="0.00"
                  />
                </span>
              </label>
              <button type="button" className="btn btnPrimary" disabled={addingExpense} onClick={() => void addManualExpense()}>
                <span className="btnContent">
                  <IoAddOutline size={17} aria-hidden />
                  <span>{addingExpense ? 'Adding…' : 'Add expense'}</span>
                </span>
              </button>
            </div>

            <div className="toolbarPills">
              <label className="btn btnGhost">
                <span className="btnContent">
                  <IoSparklesOutline size={17} aria-hidden />
                  <span>{ocrBusy ? 'Running OCR…' : 'Import one-off image with OCR'}</span>
                </span>
                <input
                  ref={ocrFileInputRef}
                  type="file"
                  hidden
                  accept="image/*"
                  disabled={ocrBusy}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void runOcrForFile(file)
                    event.target.value = ''
                  }}
                />
              </label>
              {ocrProgressMessage ? <span className="muted">{ocrProgressMessage}</span> : null}
            </div>
          </>
        ) : null}

        {currentMember ? (
          <div className="toolbarPills">
            <button type="button" className="btn btnGhost" onClick={selectAllBulkExpenses}>
              Select all expenses
            </button>
            <button type="button" className="btn btnGhost" onClick={invertBulkExpenses}>
              Invert expense selection
            </button>
          </div>
        ) : null}

        {expenses.length === 0 ? (
          <div className="emptyState">
            <IoReceiptOutline size={20} aria-hidden />
            <p className="muted">No expenses yet.</p>
          </div>
        ) : (
          <div className="tableWrap">
            <table className="table tableActionLast dataTable">
              <thead>
                <tr>
                  {currentMember ? <th>{isHost ? 'Bulk' : 'Add me'}</th> : null}
                  <th>Expense</th>
                  <th>Amount</th>
                  <th>Split</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    {currentMember ? (
                      <td className="checkboxCell">
                        <input
                          type="checkbox"
                          checked={bulkSelectedExpenseIds.includes(expense.id)}
                          onChange={(event) => toggleBulkExpenseSelection(expense.id, event.target.checked)}
                        />
                      </td>
                    ) : null}
                    <td>
                      <div className="expenseIdentity">
                        <strong>{expense.name}</strong>
                        <span className={`statusBadge ${expense.source === 'ocr' ? 'statusBadgeAccent' : 'statusBadgeWarm'}`}>
                          {expense.source === 'ocr' ? 'OCR import' : 'Manual'}
                        </span>
                      </div>
                    </td>
                    <td>{formatMoney(expense.amount)}</td>
                    <td>
                      <div className="splitSummaryText">{summarizeExpenseClaims(expense.id, claims, members)}</div>
                    </td>
                    <td>
                      {currentMember ? (
                        <button type="button" className="btn btnGhost" onClick={() => openSplitEditor(expense)}>
                          <span className="btnContent">
                            <IoCreateOutline size={16} aria-hidden />
                            <span>Edit</span>
                          </span>
                        </button>
                      ) : (
                        <Link to={`/join/${session.id}`}>Join first</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card sectionCard revealCard">
        <div className="sectionHeader">
          <div>
            <div className="sectionKicker">
              <IoStatsChartOutline size={15} aria-hidden />
              <span>Overview</span>
            </div>
            <h2 className="sectionTitle">Balances</h2>
            <p className="muted">Outstanding amounts are expense claims minus confirmed settlements.</p>
          </div>
        </div>

        <div className="statGrid">
          <div className="statCard statCardWarm">
            <span className="statIcon">
              <IoWalletOutline size={18} aria-hidden />
            </span>
            <span className="muted">Host receivable</span>
            <strong>{formatMoney(hostReceivable)}</strong>
          </div>
          <div className="statCard statCardBlue">
            <span className="statIcon">
              <IoReceiptOutline size={18} aria-hidden />
            </span>
            <span className="muted">Expenses</span>
            <strong>{formatMoney(totalExpenseAmount)}</strong>
          </div>
          <div className="statCard statCardGreen">
            <span className="statIcon">
              <IoCheckmarkCircleOutline size={18} aria-hidden />
            </span>
            <span className="muted">Confirmed settlements</span>
            <strong>{formatMoney(confirmedSettlementAmount)}</strong>
          </div>
        </div>
      </section>

      {hostMember ? (
        <section className="card sectionCard revealCard">
          <div className="sectionHeader">
            <div>
              <div className="sectionKicker">
                <IoWalletOutline size={15} aria-hidden />
                <span>Trust mode</span>
              </div>
              <h2 className="sectionTitle">Settlements</h2>
              <p className="muted">
                Members can mark themselves paid, and the host can also mark or undo payments for anyone.
              </p>
            </div>
          </div>

          {combinedHostPaymentComment || hostProfile?.default_accepts_fps || hostProfile?.default_accepts_payme ? (
            <div className="paymentInstructionCard">
              <div className="paymentInstructionHead">
                <div>
                  <h3 className="paymentInstructionTitle">Host payment details</h3>
                  <p className="muted">Use these details when you mark a settlement as paid.</p>
                </div>
              </div>
              <div className="paymentInstructionGrid">
                <div className="paymentMethodGroups">
                  <div className="stack compactStack">
                    <span className="softLabel">Accept</span>
                    <div className="paymentBadgeRow">
                      {hostProfile?.default_accepts_fps ? (
                        <span className="statusBadge statusBadgeSuccess">
                          <IoFlashOutline size={15} aria-hidden />
                          <span>FPS</span>
                        </span>
                      ) : null}
                      {hostProfile?.default_accepts_payme ? (
                        <span className="statusBadge statusBadgeSuccess">
                          <IoWalletOutline size={15} aria-hidden />
                          <span>PayMe</span>
                        </span>
                      ) : null}
                      {!hostProfile?.default_accepts_fps && !hostProfile?.default_accepts_payme ? (
                        <span className="muted">None</span>
                      ) : null}
                    </div>
                  </div>

                  {!hostProfile?.default_accepts_fps || !hostProfile?.default_accepts_payme ? (
                    <div className="stack compactStack">
                      <span className="softLabel">Not accept</span>
                      <div className="paymentBadgeRow">
                        {!hostProfile?.default_accepts_fps ? (
                          <span className="statusBadge statusBadgeWarm">
                            <IoCloseCircleOutline size={15} aria-hidden />
                            <span>FPS</span>
                          </span>
                        ) : null}
                        {!hostProfile?.default_accepts_payme ? (
                          <span className="statusBadge statusBadgeWarm">
                            <IoCloseCircleOutline size={15} aria-hidden />
                            <span>PayMe</span>
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
                {combinedHostPaymentComment ? (
                  <div className="paymentInstructionRow paymentInstructionHighlight">
                    <div className="stack compactStack">
                      <span className="softLabel">Comment</span>
                      <strong className="prewrapText richCommentText">{renderLinkedText(combinedHostPaymentComment)}</strong>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="tableWrap">
            <table className="table tableActionLast dataTable">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Outstanding</th>
                  <th>Confirmed paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members
                  .filter((member) => !member.is_host)
                  .map((member) => {
                    const balance = balances[member.id] ?? { owed: 0, paid: 0, received: 0, outstanding: 0 }
                    const latestConfirmedSettlement = latestConfirmedSettlementByMember.get(member.id) ?? null
                    const canActOnMember = isHost || currentMember?.id === member.id
                    const canMarkPaid = canActOnMember && balance.outstanding > 0
                    const canUndoPaid = canActOnMember && latestConfirmedSettlement != null
                    return (
                      <tr key={member.id}>
                        <td>{member.display_name}</td>
                        <td>{formatMoney(balance.outstanding)}</td>
                        <td>{formatMoney(balance.paid)}</td>
                        <td>
                          {canMarkPaid || canUndoPaid ? (
                            <div className="row">
                              {canMarkPaid ? (
                                <button
                                  type="button"
                                  className="btn btnPrimary"
                                  disabled={settlementBusyMemberId === member.id}
                                  onClick={() => void markSettlementPaid(member)}
                                >
                                  <span className="btnContent">
                                    <IoCheckmarkCircleOutline size={16} aria-hidden />
                                    <span>
                                      {settlementBusyMemberId === member.id
                                        ? 'Saving…'
                                        : currentMember?.id === member.id
                                          ? `I paid ${balance.outstanding.toFixed(2)}`
                                          : `Mark paid ${balance.outstanding.toFixed(2)}`}
                                    </span>
                                  </span>
                                </button>
                              ) : null}
                              {canUndoPaid && latestConfirmedSettlement ? (
                                <button
                                  type="button"
                                  className="btn btnGhost"
                                  disabled={settlementBusyMemberId === member.id}
                                  onClick={() => void undoSettlementPaid(latestConfirmedSettlement)}
                                >
                                  <span className="btnContent">
                                    <IoArrowUndoOutline size={16} aria-hidden />
                                    <span>
                                      {settlementBusyMemberId === member.id ? 'Saving…' : `Undo ${latestConfirmedSettlement.amount.toFixed(2)}`}
                                    </span>
                                  </span>
                                </button>
                              ) : null}
                            </div>
                          ) : balance.outstanding > 0 ? (
                            <span className="softLabel">Awaiting payment mark</span>
                          ) : (
                            <span className="statusBadge statusBadgeSuccess">Settled</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="card sectionCard revealCard receiptSection">
        <div className="sectionHeader">
          <div>
            <div className="sectionKicker">
              <IoReceiptOutline size={15} aria-hidden />
              <span>Evidence</span>
            </div>
            <h2 className="sectionTitle">Receipt</h2>
            <p className="muted">Keep the original image with the session so members can review context while claiming expenses.</p>
          </div>
          <button type="button" className="btn btnGhost" onClick={() => setReceiptExpanded((current) => !current)}>
            <span className="btnContent">
              {receiptExpanded ? <IoChevronUpOutline size={16} aria-hidden /> : <IoChevronDownOutline size={16} aria-hidden />}
              <span>{receiptExpanded ? 'Collapse' : receiptImageUrl ? 'Expand receipt' : 'Open receipt'}</span>
            </span>
          </button>
        </div>

        <div className={`receiptAccordion ${receiptExpanded ? 'receiptAccordionOpen' : ''}`}>
          {isHost ? (
            <div className="toolbarPills">
              <label className="btn btnPrimary">
                <span className="btnContent">
                  <IoCloudUploadOutline size={17} aria-hidden />
                  <span>{uploadingReceipt ? 'Uploading…' : 'Upload image'}</span>
                </span>
                <input
                  ref={receiptFileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={uploadingReceipt}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void uploadReceipt(file)
                    event.target.value = ''
                  }}
                />
              </label>
              <label className="btn btnGhost">
                <span className="btnContent">
                  <IoCameraOutline size={17} aria-hidden />
                  <span>Take photo</span>
                </span>
                <input
                  ref={receiptCaptureInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  disabled={uploadingReceipt}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void uploadReceipt(file)
                    event.target.value = ''
                  }}
                />
              </label>
              {session.receipt_storage_path ? (
                <button type="button" className="btn btnGhost" disabled={ocrBusy} onClick={() => void runOcrOnSavedReceipt()}>
                  <span className="btnContent">
                    <IoSparklesOutline size={17} aria-hidden />
                    <span>{ocrBusy ? 'Running OCR…' : 'Extract expenses'}</span>
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}

          {receiptImageUrl ? (
            <img className="receiptImg" src={receiptImageUrl} alt="Uploaded receipt" />
          ) : (
            <div className="emptyState">
              <IoReceiptOutline size={20} aria-hidden />
              <p className="muted">No receipt image uploaded yet.</p>
            </div>
          )}
        </div>

        {!receiptExpanded && receiptImageUrl ? <p className="softLabel">Receipt image attached. Expand to view or rerun OCR.</p> : null}
      </section>

      {ocrReviewOpen ? (
        <OcrReviewDialog
          items={ocrDraftItems}
          saving={ocrSaving}
          onClose={() => setOcrReviewOpen(false)}
          onSave={saveOcrItems}
        />
      ) : null}

      {editingExpense ? (
        <div className="modalBackdrop">
          <dialog open className="card splitEditorDialog">
            <div className="stack">
              <div className="sectionHeader">
                <div>
                  <div className="sectionKicker">
                    <IoCreateOutline size={15} aria-hidden />
                    <span>Split editor</span>
                  </div>
                  <h2 className="sectionTitle">Edit split</h2>
                  <p className="muted">
                    {editingExpense.name} ·{' '}
                    {formatMoney(
                      splitMode === 'custom'
                        ? roundCurrency(
                            selectedMemberIds.reduce((sum, memberId) => sum + (parseAmount(customAmounts[memberId] ?? '') ?? 0), 0),
                          )
                        : editingExpense.amount,
                    )}
                  </p>
                </div>
              </div>

              <div className="segmentedControl">
                <button
                  type="button"
                  className={`btn ${splitMode === 'equal' ? 'btnPrimary' : 'btnGhost'}`}
                  onClick={() => updateSplitMode('equal')}
                >
                  Equal
                </button>
                <button
                  type="button"
                  className={`btn ${splitMode === 'custom' ? 'btnPrimary' : 'btnGhost'}`}
                  onClick={() => updateSplitMode('custom')}
                >
                  Custom
                </button>
              </div>

              <div className="splitEditorList">
                {members.map((member) => {
                  const selected = selectedMemberIds.includes(member.id)
                  return (
                    <div key={member.id} className="splitEditorRow">
                      <label className="splitMemberCheck">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => updateSelectedMembers(member.id, event.target.checked)}
                        />
                        <span>{member.display_name}</span>
                        {member.status === 'placeholder' ? <span className="muted">Placeholder</span> : null}
                      </label>

                      {splitMode === 'custom' ? (
                        <label className="field amountField">
                          Amount
                          <span className="inputWithPrefix">
                            <span className="inputPrefix">{session.currency}</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={customAmounts[member.id] ?? ''}
                              onFocus={() => setActiveCustomMemberId(member.id)}
                              onBlur={() => finalizeCustomAmount(member.id)}
                              onChange={(event) => updateCustomAmount(member.id, event.target.value)}
                              disabled={!selected}
                              placeholder="0.00"
                            />
                          </span>
                        </label>
                      ) : selected ? (
                        <span className="softLabel">
                          {session.currency}{' '}
                          {(
                            activeCustomMemberId == null
                              ? distributeEvenAmounts(editingExpense.amount, selectedMemberIds.length || 1)[
                                  selectedMemberIds.indexOf(member.id)
                                ]
                              : distributeEvenAmounts(editingExpense.amount, selectedMemberIds.length || 1)[
                                  selectedMemberIds.indexOf(member.id)
                                ]
                          )?.toFixed(2) ?? '0.00'}
                        </span>
                      ) : (
                        <span className="muted">Not included</span>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="row">
                <button type="button" className="btn btnPrimary" disabled={savingSplit} onClick={() => void saveSplitClaims()}>
                  <span className="btnContent">
                    <IoCheckmarkCircleOutline size={16} aria-hidden />
                    <span>{savingSplit ? 'Saving…' : 'Save split'}</span>
                  </span>
                </button>
                <button type="button" className="btn btnGhost" disabled={savingSplit} onClick={closeSplitEditor}>
                  <span className="btnContent">
                    <IoArrowUndoOutline size={16} aria-hidden />
                    <span>Cancel</span>
                  </span>
                </button>
              </div>
            </div>
          </dialog>
        </div>
      ) : null}

      {actionError ? <ErrorPopup message={actionError} onClose={() => setActionError(null)} /> : null}
    </div>
  )
}
