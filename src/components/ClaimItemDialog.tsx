import { useEffect, useMemo, useState } from 'react'
import {
  IoCheckmarkOutline,
  IoHandLeftOutline,
  IoTrashOutline,
} from 'react-icons/io5'
import type { SlotClaimRow, SplitItemRow } from '../lib/types'
import { MdEdit } from 'react-icons/md'

export type ClaimItemDialogProfileMap = Record<string, string>

export type ClaimItemDialogProps = {
  item: SplitItemRow
  itemClaims: SlotClaimRow[]
  sessionOpen: boolean
  isHost: boolean
  myUserId: string
  profiles: ClaimItemDialogProfileMap
  hostEditLabel: string
  hostEditSlotCount: number
  willClearHostEdit: boolean
  splitItemRemoving: boolean
  onClose: () => void
  onHostEditLabelChange: (value: string) => void
  onHostEditSlotCountChange: (value: number) => void
  onDiscardHostDraft: () => void
  onSaveHostLine: () => Promise<void>
  onRemoveLine: () => Promise<void>
  onClaimSlot: (slotIndex: number) => Promise<void>
  onReleaseClaim: (claimId: string) => Promise<void>
}

export function ClaimItemDialog({
  item,
  itemClaims,
  sessionOpen,
  isHost,
  myUserId,
  profiles,
  hostEditLabel,
  hostEditSlotCount,
  willClearHostEdit,
  splitItemRemoving,
  onClose,
  onHostEditLabelChange,
  onHostEditSlotCountChange,
  onDiscardHostDraft,
  onSaveHostLine,
  onRemoveLine,
  onClaimSlot,
  onReleaseClaim,
}: ClaimItemDialogProps) {
  const [hostLineEditMode, setHostLineEditMode] = useState(false)
  const [claimBusySlots, setClaimBusySlots] = useState<Set<number>>(() => new Set())
  const [releaseBusyIds, setReleaseBusyIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setHostLineEditMode(false)
  }, [item.id])

  useEffect(() => {
    setClaimBusySlots(new Set())
    setReleaseBusyIds(new Set())
  }, [item.id])

  const toggleHostEditMode = () => {
    if (hostLineEditMode) {
      onDiscardHostDraft()
      setHostLineEditMode(false)
    } else {
      setHostLineEditMode(true)
    }
  }

  const handleSaveHostLine = async () => {
    await onSaveHostLine()
    setHostLineEditMode(false)
  }

  const claimBusySlotsKey = useMemo(() => claimBusySlots, [claimBusySlots])
  const releaseBusyIdsKey = useMemo(() => releaseBusyIds, [releaseBusyIds])

  return (
    <dialog open className="card claimItemDialog" style={{ position: 'fixed', inset: 'auto', margin: 'auto', zIndex: 20 }}>
      <div className="stack">
        <div className="claimDialogTitleRow">
          <h2 className="h2 claimDialogTitle">{item.label?.trim() || 'Item'}</h2>
          {isHost && sessionOpen ? (
            <button
              type="button"
              className={hostLineEditMode ? 'iconDialogBtn iconDialogBtnToggled' : 'iconDialogBtn'}
              onClick={toggleHostEditMode}
              aria-label={hostLineEditMode ? 'Done editing line' : 'Edit this line'}
              title={
                hostLineEditMode
                  ? 'Done editing — unsaved changes to the line will be reverted'
                  : 'Edit label and number of slots'
              }
            >
              <MdEdit className="iconDialogSvg" size={20} aria-hidden />
            </button>
          ) : null}
        </div>
        <p className="muted">
          {item.slot_count} slot{item.slot_count === 1 ? '' : 's'} total
        </p>

        <div className="stack">
          <h3 className="h2" style={{ fontSize: '1rem' }}>
            Slots
          </h3>
          <table className="table tableActionLast claimSlotsTable">
            <thead>
              <tr>
                <th>#</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: item.slot_count }, (_, i) => i + 1).map((n) => {
                const claim = itemClaims.find((c) => c.slot_index === n)
                const mine = !!(claim && claim.claimed_by_user_id === myUserId)
                const claimBusy = claimBusySlotsKey.has(n)
                const releaseBusy = claim ? releaseBusyIdsKey.has(claim.id) : false
                return (
                  <tr key={n}>
                    <td>{n}</td>
                    <td>
                      {claim ? (
                        <span>{profiles[claim.claimed_by_user_id] ?? claim.claimed_by_user_id.slice(0, 8)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {!sessionOpen ? (
                        <span className="muted">—</span>
                      ) : !claim ? (
                        <button
                          type="button"
                          className="btnSlotHand btnSlotHandClaim"
                          disabled={claimBusy}
                          onClick={() => {
                            if (claimBusySlotsKey.has(n)) return
                            setClaimBusySlots((prev) => new Set(prev).add(n))
                            void (async () => {
                              try {
                                await onClaimSlot(n)
                              } finally {
                                setClaimBusySlots((prev) => {
                                  const next = new Set(prev)
                                  next.delete(n)
                                  return next
                                })
                              }
                            })()
                          }}
                          aria-label="Claim this slot"
                          title={claimBusy ? 'Claiming…' : 'Claim'}
                        >
                          <IoHandLeftOutline className="btnSlotHandSvg" size={18} aria-hidden />
                        </button>
                      ) : mine ? (
                        <button
                          type="button"
                          className="btnSlotHand btnSlotHandRelease"
                          disabled={releaseBusy}
                          onClick={() => {
                            if (releaseBusyIdsKey.has(claim.id)) return
                            setReleaseBusyIds((prev) => new Set(prev).add(claim.id))
                            void (async () => {
                              try {
                                await onReleaseClaim(claim.id)
                              } finally {
                                setReleaseBusyIds((prev) => {
                                  const next = new Set(prev)
                                  next.delete(claim.id)
                                  return next
                                })
                              }
                            })()
                          }}
                          aria-label="Release this slot"
                          title={releaseBusy ? 'Releasing…' : 'Release'}
                        >
                          <IoHandLeftOutline className="btnSlotHandSvg" size={18} aria-hidden />
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {sessionOpen ? null : <p className="muted">Session is locked — claiming and releasing are disabled.</p>}

        {isHost && sessionOpen && hostLineEditMode ? (
          <div className="stack" style={{ borderTop: '1px solid #e2e8f0', paddingTop: '0.75rem' }}>
            <h3 className="h2" style={{ fontSize: '1rem' }}>
              Edit this line (host)
            </h3>
            {willClearHostEdit ? (
              <p className="muted">
                Saving will clear existing claims on this line because the new slot count is too low. Others can claim
                again afterward.
              </p>
            ) : null}
            <label className="field">
              Label
              <input type="text" value={hostEditLabel} onChange={(e) => onHostEditLabelChange(e.target.value)} />
            </label>
            <label className="field">
              Number of slots
              <input
                type="number"
                min={1}
                max={20}
                value={hostEditSlotCount}
                onChange={(e) => onHostEditSlotCountChange(Number(e.target.value))}
              />
            </label>
            <div className="row dialogIconActions">
              <button
                type="button"
                className="iconDialogBtn iconDialogBtnPrimary"
                onClick={() => void handleSaveHostLine()}
                aria-label="Save line changes"
                title="Save line changes"
              >
                <IoCheckmarkOutline className="iconDialogSvg" size={20} aria-hidden />
              </button>
              <button
                type="button"
                className="iconDialogBtn iconDialogBtnDanger"
                disabled={splitItemRemoving}
                onClick={() => void onRemoveLine()}
                aria-label={splitItemRemoving ? 'Removing line…' : 'Remove this line'}
                title={splitItemRemoving ? 'Removing…' : 'Remove this line'}
              >
                <IoTrashOutline className="iconDialogSvg" size={20} aria-hidden />
              </button>
            </div>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  )
}
