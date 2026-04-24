import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { IoCopyOutline, IoLockClosedOutline, IoLockOpenOutline } from 'react-icons/io5'
import { ClaimItemDialog } from '../components/ClaimItemDialog'
import { ReceiptBoard } from '../components/ReceiptBoard'
import { useAuth } from '../lib/auth'
import { formatErrorMessage } from '../lib/errors'
import { supabase } from '../lib/supabaseClient'
import type {
  PaymentAckRow,
  SessionParticipantRow,
  SessionRow,
  SlotClaimRow,
  SplitItemRow,
} from '../lib/types'
import { formatSessionCreatedAt } from '../lib/sessionDisplay'
import { isUuid } from '../lib/uuid'
import { joinSessionUrl } from '../lib/urls'
import { MdEdit } from 'react-icons/md'

type ProfileMap = Record<string, string>

function allSplitItemsFilled(items: SplitItemRow[], claims: SlotClaimRow[]) {
  if (items.length === 0) return false
  return items.every((i) => claims.filter((c) => c.split_item_id === i.id).length >= i.slot_count)
}

function mustClearClaimsOnEdit(newSlotCount: number, itemClaims: SlotClaimRow[]) {
  if (itemClaims.length === 0) return false
  if (newSlotCount < itemClaims.length) return true
  return itemClaims.some((c) => c.slot_index > newSlotCount)
}

function claimsOnItemSorted(itemId: string, allClaims: SlotClaimRow[]) {
  return [...allClaims].filter((c) => c.split_item_id === itemId).sort((a, b) => a.slot_index - b.slot_index)
}

export function SessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { user, ready, error: authError } = useAuth()

  const [session, setSession] = useState<SessionRow | null>(null)
  const [participants, setParticipants] = useState<SessionParticipantRow[]>([])
  const [splitItems, setSplitItems] = useState<SplitItemRow[]>([])
  const [claims, setClaims] = useState<SlotClaimRow[]>([])
  const [paymentAcks, setPaymentAcks] = useState<PaymentAckRow[]>([])
  const [profiles, setProfiles] = useState<ProfileMap>({})
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  /** New item from receipt tap */
  const [pendingPos, setPendingPos] = useState<{ x: number; y: number } | null>(null)
  const [addSlotDraft, setAddSlotDraft] = useState(1)
  const [addLabelDraft, setAddLabelDraft] = useState('')

  /** Existing item: claim / release / host edits */
  const [itemDialogId, setItemDialogId] = useState<string | null>(null)
  const [hostEditLabel, setHostEditLabel] = useState('')
  const [hostEditSlotCount, setHostEditSlotCount] = useState(1)
  const [sessionTitleDraft, setSessionTitleDraft] = useState('')
  const [sessionTitleSaving, setSessionTitleSaving] = useState(false)
  const [splitItemRemoving, setSplitItemRemoving] = useState(false)
  const [maxGuestsDraft, setMaxGuestsDraft] = useState('')
  const [maxGuestsSaving, setMaxGuestsSaving] = useState(false)
  const [kickingUserId, setKickingUserId] = useState<string | null>(null)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  const [editingSessionTitle, setEditingSessionTitle] = useState(false)
  const sessionTitleInputRef = useRef<HTMLInputElement>(null)
  const [joinUrlCopied, setJoinUrlCopied] = useState(false)
  const joinUrlCopyTimerRef = useRef<number>(null)
  const claimInFlightRef = useRef<Set<string>>(new Set())
  const releaseInFlightRef = useRef<Set<string>>(new Set())
  const [receiptUploading, setReceiptUploading] = useState(false)
  const receiptFileInputRef = useRef<HTMLInputElement>(null)
  const receiptCaptureInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!sessionId || !user) return
    setLoadError(null)

    if (!isUuid(sessionId)) {
      setLoadError('Invalid session link.')
      return
    }

    const { data: s, error: se } = await supabase.from('sessions').select('*').eq('id', sessionId).maybeSingle()
    if (se) {
      setLoadError(se.message)
      return
    }
    if (!s) {
      setLoadError(
        'This session was not found, or you are not part of it yet. Open the join link from the host to add yourself.',
      )
      return
    }
    const sess = s as SessionRow
    setSession(sess)

    const { data: p, error: pe } = await supabase
      .from('session_participants')
      .select('*')
      .eq('session_id', sessionId)
    if (pe) {
      setLoadError(pe.message)
      return
    }
    const plist = (p ?? []) as SessionParticipantRow[]
    setParticipants(plist)

    const amParticipant = plist.some((row) => row.user_id === user.id)
    if (!amParticipant) {
      setLoadError('You are not in this session. Scan the QR code or open the join link.')
      setSplitItems([])
      setClaims([])
      setPaymentAcks([])
      setImageUrl(null)
      return
    }

    const { data: items, error: ie } = await supabase.from('split_items').select('*').eq('session_id', sessionId)
    if (ie) {
      setLoadError(ie.message)
      return
    }
    const itemRows = (items ?? []) as SplitItemRow[]
    setSplitItems(itemRows)

    const itemIds = itemRows.map((r) => r.id)
    let claimsRows: SlotClaimRow[] = []
    if (itemIds.length > 0) {
      const { data: cdata, error: c2e } = await supabase
        .from('split_item_slot_claims')
        .select('*')
        .in('split_item_id', itemIds)
      if (c2e) {
        setLoadError(c2e.message)
        return
      }
      claimsRows = (cdata ?? []) as SlotClaimRow[]
    }
    setClaims(claimsRows)

    const { data: acks, error: ae } = await supabase
      .from('payment_acknowledgements')
      .select('*')
      .eq('session_id', sessionId)
    if (ae) {
      setLoadError(ae.message)
      return
    }
    setPaymentAcks((acks ?? []) as PaymentAckRow[])

    const ids = plist.map((x) => x.user_id)
    const { data: profRows } = await supabase.from('profiles').select('id, display_name').in('id', ids)
    const map: ProfileMap = {}
    for (const row of profRows ?? []) {
      map[row.id as string] = (row.display_name as string) ?? 'Guest'
    }
    setProfiles(map)

    if (sess.receipt_storage_path) {
      const { data: signed, error: signErr } = await supabase.storage
        .from('receipts')
        .createSignedUrl(sess.receipt_storage_path, 3600)
      if (signErr) {
        setImageUrl(null)
      } else {
        setImageUrl(signed?.signedUrl ?? null)
      }
    } else {
      setImageUrl(null)
    }
  }, [sessionId, user])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!sessionId || !user || !isUuid(sessionId)) return

    const channel = supabase
      .channel(`session-live:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, () =>
        void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'session_participants', filter: `session_id=eq.${sessionId}` },
        () => void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'split_items', filter: `session_id=eq.${sessionId}` },
        () => void load(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'split_item_slot_claims' }, () => void load())
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payment_acknowledgements', filter: `session_id=eq.${sessionId}` },
        () => void load(),
      )

    void channel.subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [sessionId, user, load])

  useEffect(() => {
    if (session) {
      setSessionTitleDraft(session.title ?? '')
      setMaxGuestsDraft(session.max_guests == null ? '' : String(session.max_guests))
    }
  }, [session?.id, session?.title, session?.max_guests])

  useEffect(() => {
    if (editingSessionTitle) {
      sessionTitleInputRef.current?.focus()
      sessionTitleInputRef.current?.select()
    }
  }, [editingSessionTitle])

  useEffect(() => {
    return () => {
      if (joinUrlCopyTimerRef.current != null) {
        window.clearTimeout(joinUrlCopyTimerRef.current)
      }
    }
  }, [])

  const isHost = useMemo(() => {
    if (!user || !session) return false
    return session.host_user_id === user.id
  }, [session, user])

  const hasReceipt = useMemo(() => {
    const p = session?.receipt_storage_path?.trim() ?? ''
    return p.length > 0
  }, [session?.receipt_storage_path])

  const amParticipant = useMemo(() => {
    if (!user) return false
    return participants.some((p) => p.user_id === user.id)
  }, [participants, user])

  const guestCount = useMemo(
    () => participants.filter((p) => p.role === 'guest').length,
    [participants],
  )

  const sessionOpen = session?.status === 'open'

  /** Host must upload a receipt before adding lines or locking (DB enforces this too). */
  const hostAwaitingReceipt = isHost && !!sessionOpen && !hasReceipt

  const filled = useMemo(() => allSplitItemsFilled(splitItems, claims), [splitItems, claims])
  const myAck = useMemo(() => {
    if (!user) return null
    return paymentAcks.find((a) => a.user_id === user.id) ?? null
  }, [paymentAcks, user])

  const dialogItem = useMemo(
    () => (itemDialogId ? splitItems.find((i) => i.id === itemDialogId) ?? null : null),
    [itemDialogId, splitItems],
  )

  const itemClaimsForDialog = useMemo(
    () => (itemDialogId ? claims.filter((c) => c.split_item_id === itemDialogId) : []),
    [itemDialogId, claims],
  )

  const willClearHostEdit = useMemo(() => {
    if (!dialogItem || !isHost) return false
    const count = Math.min(20, Math.max(1, Math.floor(hostEditSlotCount)))
    return mustClearClaimsOnEdit(count, itemClaimsForDialog)
  }, [dialogItem, isHost, hostEditSlotCount, itemClaimsForDialog])

  const splitItemsOrdered = useMemo(
    () => [...splitItems].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [splitItems],
  )

  const openAddDialog = (pos: { x: number; y: number }) => {
    setItemDialogId(null)
    setPendingPos(pos)
    setAddSlotDraft(1)
    setAddLabelDraft('')
    setActionError(null)
  }

  const openItemDialog = useCallback((id: string) => {
    setPendingPos(null)
    setItemDialogId(id)
    setActionError(null)
  }, [])

  const closeDialogs = () => {
    setPendingPos(null)
    setItemDialogId(null)
  }

  const discardHostLineDraft = useCallback(() => {
    if (!dialogItem) return
    setHostEditLabel(dialogItem.label ?? '')
    setHostEditSlotCount(dialogItem.slot_count)
  }, [dialogItem])

  useEffect(() => {
    if (!itemDialogId || !dialogItem || !isHost) return
    setHostEditLabel(dialogItem.label ?? '')
    setHostEditSlotCount(dialogItem.slot_count)
  }, [itemDialogId, dialogItem?.id, dialogItem?.label, dialogItem?.slot_count, isHost])

  const uploadSessionReceipt = async (file: File) => {
    if (!sessionId || !isHost) return
    if (!file.type.startsWith('image/')) {
      setActionError('Please choose an image file.')
      return
    }
    setReceiptUploading(true)
    setActionError(null)
    try {
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
      if (receiptFileInputRef.current) receiptFileInputRef.current.value = ''
      if (receiptCaptureInputRef.current) receiptCaptureInputRef.current.value = ''
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      setReceiptUploading(false)
    }
  }

  const saveNewSplitItem = async () => {
    if (!sessionId || !user || !pendingPos || !hasReceipt) return
    setActionError(null)
    const count = Math.min(20, Math.max(1, Math.floor(addSlotDraft)))
    const label = addLabelDraft.trim() || null
    try {
      const { error } = await supabase.from('split_items').insert({
        session_id: sessionId,
        slot_count: count,
        anchor_x: pendingPos.x,
        anchor_y: pendingPos.y,
        label,
      })
      if (error) throw error
      closeDialogs()
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    }
  }

  const saveHostLineEdits = async () => {
    if (!sessionId || !user || !dialogItem || !isHost) return
    setActionError(null)
    const count = Math.min(20, Math.max(1, Math.floor(hostEditSlotCount)))
    const label = hostEditLabel.trim() || null
    try {
      const clear = mustClearClaimsOnEdit(count, itemClaimsForDialog)
      if (clear) {
        const { error: delErr } = await supabase
          .from('split_item_slot_claims')
          .delete()
          .eq('split_item_id', dialogItem.id)
        if (delErr) throw delErr
      }
      const { error: upErr } = await supabase
        .from('split_items')
        .update({ slot_count: count, label })
        .eq('id', dialogItem.id)
      if (upErr) throw upErr
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    }
  }

  const removeSplitItem = async () => {
    if (!itemDialogId || !user || !dialogItem || !isHost || !sessionOpen) return
    if (!window.confirm('Remove this line and all slot claims on it?')) return
    setSplitItemRemoving(true)
    setActionError(null)
    try {
      const { error } = await supabase.from('split_items').delete().eq('id', dialogItem.id)
      if (error) throw error
      closeDialogs()
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      setSplitItemRemoving(false)
    }
  }

  const claimSlotAtIndex = async (slotIndex: number) => {
    if (!user || !itemDialogId || !dialogItem) return
    if (!sessionOpen) return
    const key = `${itemDialogId}:${slotIndex}`
    if (claimInFlightRef.current.has(key)) return
    claimInFlightRef.current.add(key)
    setActionError(null)
    try {
      // Idempotent under rapid clicks: if the slot is already claimed, ignore the duplicate.
      // This preserves the unique constraint and avoids accidentally overwriting someone else's claim.
      const { error } = await supabase.from('split_item_slot_claims').upsert(
        {
          split_item_id: itemDialogId,
          slot_index: slotIndex,
          claimed_by_user_id: user.id,
        },
        { onConflict: 'split_item_id,slot_index', ignoreDuplicates: true },
      )
      if (error) throw error
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      claimInFlightRef.current.delete(key)
    }
  }

  const releaseClaim = async (claimId: string) => {
    if (!sessionOpen) return
    if (releaseInFlightRef.current.has(claimId)) return
    releaseInFlightRef.current.add(claimId)
    setActionError(null)
    try {
      const { error } = await supabase.from('split_item_slot_claims').delete().eq('id', claimId)
      if (error) throw error
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      releaseInFlightRef.current.delete(claimId)
    }
  }

  const saveSessionTitle = async () => {
    if (!sessionId || !user || !session || !isHost) return
    const next = sessionTitleDraft.trim()
    if (next === (session.title ?? '').trim()) {
      setEditingSessionTitle(false)
      return
    }
    setSessionTitleSaving(true)
    setActionError(null)
    try {
      const { error } = await supabase.from('sessions').update({ title: next || null }).eq('id', sessionId)
      if (error) throw error
      await load()
      setEditingSessionTitle(false)
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      setSessionTitleSaving(false)
    }
  }

  const cancelSessionTitleEdit = () => {
    if (session) setSessionTitleDraft(session.title ?? '')
    setEditingSessionTitle(false)
  }

  const copyJoinUrl = async () => {
    if (!session) return
    setActionError(null)
    const url = joinSessionUrl(session.id)
    try {
      await navigator.clipboard.writeText(url)
      setJoinUrlCopied(true)
      if (joinUrlCopyTimerRef.current != null) window.clearTimeout(joinUrlCopyTimerRef.current)
      joinUrlCopyTimerRef.current = window.setTimeout(() => {
        setJoinUrlCopied(false)
        joinUrlCopyTimerRef.current = null
      }, 2000)
    } catch {
      setActionError('Could not copy to the clipboard.')
    }
  }

  const saveMaxGuests = async () => {
    if (!sessionId || !user || !session || !isHost) return
    const trimmed = maxGuestsDraft.trim()
    let next: number | null = null
    if (trimmed !== '') {
      const parsed = Number.parseInt(trimmed, 10)
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 99) {
        setActionError('Guest limit must be blank (no limit) or a number from 1 to 99.')
        return
      }
      next = parsed
    }
    if (next === (session.max_guests ?? null)) return
    setMaxGuestsSaving(true)
    setActionError(null)
    try {
      const { error } = await supabase.from('sessions').update({ max_guests: next }).eq('id', sessionId)
      if (error) throw error
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      setMaxGuestsSaving(false)
    }
  }

  const kickGuest = async (guestUserId: string) => {
    if (!sessionId || !isHost) return
    if (!sessionOpen) return
    if (!window.confirm('Remove this guest from the bill? Their slot claims will be cleared.')) return
    setKickingUserId(guestUserId)
    setActionError(null)
    try {
      const { error } = await supabase.rpc('kick_session_guest', {
        p_session_id: sessionId,
        p_guest_user_id: guestUserId,
      })
      if (error) throw error
      await load()
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      setKickingUserId(null)
    }
  }

  const leaveSessionAsGuest = async () => {
    if (!sessionId || !user || isHost || !sessionOpen) return
    if (!window.confirm('Leave this bill? Your slot claims will be released.')) return
    setLeaveBusy(true)
    setActionError(null)
    try {
      const { error } = await supabase.rpc('leave_session_as_guest', { p_session_id: sessionId })
      if (error) throw error
      navigate('/', { replace: true })
    } catch (e: unknown) {
      setActionError(formatErrorMessage(e))
    } finally {
      setLeaveBusy(false)
    }
  }

  const lockSession = async () => {
    if (!sessionId || !filled || !hasReceipt) return
    setLockBusy(true)
    setActionError(null)
    try {
      const { error } = await supabase
        .from('sessions')
        .update({ status: 'locked', locked_at: new Date().toISOString() })
        .eq('id', sessionId)
      if (error) setActionError(error.message)
      await load()
    } finally {
      setLockBusy(false)
    }
  }

  const markPaid = async () => {
    if (!sessionId || !user) return
    setActionError(null)
    const { error } = await supabase.from('payment_acknowledgements').upsert(
      {
        session_id: sessionId,
        user_id: user.id,
        acknowledged_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,user_id' },
    )
    if (error) setActionError(error.message)
    await load()
  }

  if (!ready) {
    return (
      <div className="appShell">
        <p className="muted">Loading…</p>
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

  if (!sessionId) {
    return (
      <div className="appShell">
        <p className="muted">Missing session id.</p>
      </div>
    )
  }

  if (!isUuid(sessionId)) {
    return (
      <div className="appShell stack">
        <div className="alert">Invalid session link.</div>
        <Link to="/">Home</Link>
      </div>
    )
  }

  const topBarLock =
    session && amParticipant ? (
      sessionOpen ? (
        isHost ? (
          <button
            type="button"
            className="iconLockBtn"
            disabled={!hasReceipt || !filled || lockBusy}
            onClick={() => void lockSession()}
            aria-label={
              !hasReceipt
                ? 'Lock session (upload a receipt image first)'
                : filled
                  ? 'Lock session'
                  : 'Lock session (available when every slot is claimed)'
            }
            title={
              !hasReceipt
                ? 'Upload a receipt image before you can lock the session.'
                : filled
                  ? 'Lock session — guests can then confirm PAID.'
                  : 'Lock when every line has all slots claimed.'
            }
          >
            <IoLockClosedOutline className="iconLockSvg" size={22} aria-hidden />
          </button>
        ) : (
          <span
            className="iconLockBtn iconLockBtnReadonly"
            title="Only the host can lock the session."
            role="img"
            aria-label="Only the host can lock the session"
          >
            <IoLockOpenOutline className="iconLockSvg" size={22} aria-hidden />
          </span>
        )
      ) : (
        <span
          className="iconLockBtn iconLockBtnReadonly iconLockBtnLocked"
          title="Session is locked"
          role="img"
          aria-label="Session locked"
        >
          <IoLockClosedOutline className="iconLockSvg" size={22} aria-hidden />
        </span>
      )
    ) : null

  return (
    <div className="appShell stack">
      <div className="sessionTopBar row">
        <Link to="/">Home</Link>
        <div className="row sessionTopBarEnd">
          {session ? <span className={sessionOpen ? 'badge' : 'badge badgeLocked'}>{session.status}</span> : null}
          {topBarLock}
        </div>
      </div>

      {loadError ? <div className="alert">{loadError}</div> : null}
      {actionError ? <div className="alert">{actionError}</div> : null}

      {session && amParticipant ? (
        <>
          <section className="card stack">
            <div className="sessionTitleRow">
              <h1 className="h1 sessionTitleHeading">{session.title?.trim() || 'Bill session'}</h1>
              {isHost ? (
                <button
                  type="button"
                  className="iconPenBtn"
                  onClick={() => setEditingSessionTitle(true)}
                  aria-label="Edit session name"
                  title="Edit session name"
                  disabled={editingSessionTitle}
                >
                  <MdEdit className="iconPenSvg" size={20} aria-hidden />
                </button>
              ) : null}
            </div>
            {isHost && editingSessionTitle ? (
              <div className="stack">
                <label className="field">
                  Session name
                  <input
                    ref={sessionTitleInputRef}
                    type="text"
                    value={sessionTitleDraft}
                    onChange={(e) => setSessionTitleDraft(e.target.value)}
                    placeholder="Name this bill"
                    aria-label="Session name"
                  />
                </label>
                <div className="row">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={
                      sessionTitleSaving || sessionTitleDraft.trim() === (session.title ?? '').trim()
                    }
                    onClick={() => void saveSessionTitle()}
                  >
                    {sessionTitleSaving ? 'Saving…' : 'Save name'}
                  </button>
                  <button type="button" className="btn" disabled={sessionTitleSaving} onClick={cancelSessionTitleEdit}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            <p className="muted">Created {formatSessionCreatedAt(session.created_at)}</p>
            {isHost ? (
              <div className="stack">
                <div className="qrBox">
                  <QRCodeSVG value={joinSessionUrl(session.id)} size={180} />
                  <div className="qrShareRow">
                    <p className="muted qrShareText">Share this code to join this bill.</p>
                    <button
                      type="button"
                      className="iconCopyBtn"
                      onClick={() => void copyJoinUrl()}
                      aria-label="Copy join link to clipboard"
                      title="Copy join link"
                    >
                      <IoCopyOutline className="iconCopySvg" size={20} aria-hidden />
                    </button>
                    {joinUrlCopied ? (
                      <span className="muted inviteCopiedFeedback" aria-live="polite">
                        Copied!
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            <div className="stack">
              <h2 className="h2">
                People on this bill ({guestCount}/{session.max_guests ?? '∞'})
              </h2>
              {isHost && sessionOpen ? (
                <div className="stack">
                  <label className="field">
                    Max guests (blank = no limit)
                    <input
                      type="number"
                      min={1}
                      max={99}
                      placeholder="No limit"
                      value={maxGuestsDraft}
                      onChange={(e) => setMaxGuestsDraft(e.target.value)}
                      aria-label="Maximum number of guests"
                    />
                  </label>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={
                        maxGuestsSaving ||
                        (() => {
                          const t = maxGuestsDraft.trim()
                          if (t === '') return (session.max_guests ?? null) == null
                          const n = Number.parseInt(t, 10)
                          if (Number.isNaN(n)) return false
                          return n === (session.max_guests ?? null)
                        })()
                      }
                      onClick={() => void saveMaxGuests()}
                    >
                      {maxGuestsSaving ? 'Saving…' : 'Save guest limit'}
                    </button>
                  </div>
                </div>
              ) : null}
              <table className={isHost ? 'table tableActionLast' : 'table'}>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    {isHost ? <th>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p) => (
                    <tr key={`${p.session_id}-${p.user_id}`}>
                      <td>{profiles[p.user_id] ?? p.user_id.slice(0, 8)}</td>
                      <td>{p.role}</td>
                      {isHost ? (
                        <td>
                          {p.role === 'guest' && sessionOpen ? (
                            <button
                              type="button"
                              className="btn btnDanger"
                              disabled={kickingUserId !== null}
                              onClick={() => void kickGuest(p.user_id)}
                            >
                              {kickingUserId === p.user_id ? 'Removing…' : 'Kick'}
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!isHost && sessionOpen ? (
                <button
                  type="button"
                  className="btn"
                  disabled={leaveBusy}
                  onClick={() => void leaveSessionAsGuest()}
                >
                  {leaveBusy ? 'Leaving…' : 'Leave this bill'}
                </button>
              ) : null}
            </div>
          </section>

          <section className="card stack">
            <h2 className="h2">Receipt</h2>
            {hostAwaitingReceipt ? (
              <p className="muted">
                Upload a photo of the receipt to add share lines and to lock the bill. You can still share the
                join link and set the session name. Guests can join, but there will be no lines to claim until
                the image is here.
              </p>
            ) : sessionOpen ? (
              isHost ? (
                <p className="muted">
                  Tap the receipt to add a line. Tap a marker to claim or release slots, or edit the line (host). When
                  every slot is claimed, use the lock in the top bar to close the bill.
                </p>
              ) : (
                <div className="stack">
                  <p className="muted">Tap a marker to see slots — use Claim or Release on each row.</p>
                  <p className="muted">
                    After the host locks the session, the Payment section appears — tap PAID when you have settled with
                    them.
                  </p>
                </div>
              )
            ) : (
              <p className="muted">Session is locked. You can open markers to view who took each slot.</p>
            )}
            {isHost && sessionOpen && !hasReceipt ? (
              <div className="stack">
                <div className="row">
                  <label className="btn btnPrimary">
                    {receiptUploading ? 'Uploading…' : 'Upload receipt image'}
                    <input
                      ref={receiptFileInputRef}
                      type="file"
                      accept="image/*"
                      hidden
                      disabled={receiptUploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void uploadSessionReceipt(f)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  <label className="btn">
                    Take photo
                    <input
                      ref={receiptCaptureInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      hidden
                      disabled={receiptUploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void uploadSessionReceipt(f)
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
              </div>
            ) : null}
            <ReceiptBoard
              imageUrl={imageUrl}
              splitItems={splitItems}
              claims={claims}
              myUserId={user.id}
              sessionOpen={!!sessionOpen}
              hostMode={isHost}
              onReceiptTap={
                sessionOpen && isHost && hasReceipt ? (pos) => openAddDialog(pos) : undefined
              }
              onMarkerClick={(id) => openItemDialog(id)}
            />
          </section>

          {!sessionOpen ? (
            <section className="card stack">
              <h2 className="h2">Payment</h2>
              <p className="muted">Session is locked. Press PAID when you have settled with the host.</p>
              <button type="button" className="btn btnPrimary" disabled={!!myAck} onClick={() => void markPaid()}>
                {myAck ? 'PAID recorded' : 'PAID'}
              </button>
            </section>
          ) : null}

          {isHost ? (
            <section className="card stack">
              <h2 className="h2">Who has paid</h2>
              <p className="muted">
                PAID confirmations are grouped by receipt line. Each slot row shows the claimant and whether they have
                confirmed PAID to you (one confirmation applies to the whole bill).
              </p>

              {splitItemsOrdered.length === 0 ? (
                <p className="muted">No items on this receipt yet.</p>
              ) : (
                <table className="table tableActionLast">
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th>Person</th>
                      <th>Role</th>
                      <th>PAID</th>
                    </tr>
                  </thead>
                  {splitItemsOrdered.map((item) => {
                    const itemClaims = claimsOnItemSorted(item.id, claims)
                    const claimBySlot = new Map(itemClaims.map((c) => [c.slot_index, c]))
                    const lineTitle = item.label?.trim() || 'New Item'
                    return (
                      <tbody key={item.id}>
                        <tr className="tableGroupHead">
                          <td colSpan={4}>{lineTitle}</td>
                        </tr>
                        {Array.from({ length: item.slot_count }, (_, i) => i + 1).map((slotIndex) => {
                          const claim = claimBySlot.get(slotIndex)
                          const personId = claim?.claimed_by_user_id
                          const participant = personId
                            ? participants.find((p) => p.user_id === personId)
                            : undefined
                          const displayName = personId
                            ? (profiles[personId] ?? personId.slice(0, 8))
                            : null
                          const ack = personId ? paymentAcks.find((a) => a.user_id === personId) : undefined
                          return (
                            <tr key={`${item.id}-slot-${slotIndex}`}>
                              <td>{slotIndex}</td>
                              <td>
                                {claim ? (
                                  displayName
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td>{participant ? participant.role : '—'}</td>
                              <td>
                                {!claim ? (
                                  <span className="muted">—</span>
                                ) : ack ? (
                                  'Yes'
                                ) : (
                                  'No'
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    )
                  })}
                </table>
              )}
            </section>
          ) : null}
        </>
      ) : null}

      {pendingPos ? (
        <dialog open className="card" style={{ position: 'fixed', inset: 'auto', margin: 'auto', zIndex: 20 }}>
          <div className="stack">
            <h2 className="h2">New Item</h2>
            <p className="muted">Add a label and how many people can share this line.</p>
            <label className="field">
              Label (optional)
              <input
                type="text"
                value={addLabelDraft}
                onChange={(e) => setAddLabelDraft(e.target.value)}
                placeholder="e.g. Pizza"
              />
            </label>
            <label className="field">
              Slots
              <input
                type="number"
                min={1}
                max={20}
                value={addSlotDraft}
                onChange={(e) => setAddSlotDraft(Number(e.target.value))}
              />
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={closeDialogs}>
                Cancel
              </button>
              <button type="button" className="btn btnPrimary" onClick={() => void saveNewSplitItem()}>
                Add line
              </button>
            </div>
          </div>
        </dialog>
      ) : null}

      {itemDialogId && dialogItem && user ? (
        <ClaimItemDialog
          item={dialogItem}
          itemClaims={itemClaimsForDialog}
          sessionOpen={!!sessionOpen}
          isHost={isHost}
          myUserId={user.id}
          profiles={profiles}
          hostEditLabel={hostEditLabel}
          hostEditSlotCount={hostEditSlotCount}
          willClearHostEdit={willClearHostEdit}
          splitItemRemoving={splitItemRemoving}
          onClose={closeDialogs}
          onHostEditLabelChange={setHostEditLabel}
          onHostEditSlotCountChange={setHostEditSlotCount}
          onDiscardHostDraft={discardHostLineDraft}
          onSaveHostLine={saveHostLineEdits}
          onRemoveLine={removeSplitItem}
          onClaimSlot={claimSlotAtIndex}
          onReleaseClaim={releaseClaim}
        />
      ) : null}
    </div>
  )
}
