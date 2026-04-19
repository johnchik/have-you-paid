import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { SlotClaimRow, SplitItemRow } from '../lib/types'

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function imageContentMetrics(img: HTMLImageElement) {
  const rect = img.getBoundingClientRect()
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  const rw = rect.width
  const rh = rect.height
  if (nw === 0 || nh === 0 || rw === 0 || rh === 0) {
    return { ox: 0, oy: 0, cw: rw, ch: rh }
  }
  const ir = nw / nh
  const rr = rw / rh
  let cw: number
  let ch: number
  let ox: number
  let oy: number
  if (ir > rr) {
    cw = rw
    ch = rw / ir
    ox = 0
    oy = (rh - ch) / 2
  } else {
    ch = rh
    cw = rh * ir
    ox = (rw - cw) / 2
    oy = 0
  }
  return { ox, oy, cw, ch }
}

function eventToNormalized(img: HTMLImageElement, clientX: number, clientY: number) {
  const rect = img.getBoundingClientRect()
  const { ox, oy, cw, ch } = imageContentMetrics(img)
  const x = (clientX - rect.left - ox) / cw
  const y = (clientY - rect.top - oy) / ch
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
}

/** Marker layer as % of the receipt image layout box (matches object-fit: contain drawing area). */
type Overlay = { leftPct: number; topPct: number; widthPct: number; heightPct: number }

type Props = {
  imageUrl: string | null
  splitItems: SplitItemRow[]
  claims: SlotClaimRow[]
  myUserId: string | null
  sessionOpen: boolean
  hostMode: boolean
  onReceiptTap?: (pos: { x: number; y: number }) => void
  /** Open split-item details (claim / release / host edit) */
  onMarkerClick?: (splitItemId: string) => void
}

export function ReceiptBoard({
  imageUrl,
  splitItems,
  claims,
  myUserId,
  sessionOpen,
  hostMode,
  onReceiptTap,
  onMarkerClick,
}: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  const recompute = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    const rw = rect.width
    const rh = rect.height
    const { ox, oy, cw, ch } = imageContentMetrics(img)
    if (rw <= 0 || rh <= 0) {
      setOverlay(null)
      return
    }
    setOverlay({
      leftPct: (ox / rw) * 100,
      topPct: (oy / rh) * 100,
      widthPct: (cw / rw) * 100,
      heightPct: (ch / rh) * 100,
    })
  }, [])

  useLayoutEffect(() => {
    recompute()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => recompute()) : null
    if (ro && wrapRef.current) ro.observe(wrapRef.current)
    return () => ro?.disconnect()
  }, [recompute, imageUrl])

  const hostTapLayer =
    hostMode && sessionOpen && onReceiptTap ? (
      <div
        role="presentation"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          cursor: 'crosshair',
        }}
        onClick={(e) => {
          const img = imgRef.current
          if (!img) return
          onReceiptTap(eventToNormalized(img, e.clientX, e.clientY))
        }}
      />
    ) : null

  if (!imageUrl) {
    return <p className="muted">No receipt image yet.</p>
  }

  return (
    <div ref={wrapRef} className="receiptWrap">
      <div style={{ position: 'relative', display: 'block', width: '100%' }}>
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Receipt"
          className="receiptImg"
          style={{ pointerEvents: 'none' }}
          onLoad={recompute}
          draggable={false}
        />
        {hostTapLayer}
        {overlay ? (
          <div
            style={{
              position: 'absolute',
              left: `${overlay.leftPct}%`,
              top: `${overlay.topPct}%`,
              width: `${overlay.widthPct}%`,
              height: `${overlay.heightPct}%`,
              zIndex: 2,
              pointerEvents: 'none',
            }}
          >
            {splitItems.map((item) => {
              const itemClaims = claims.filter((c) => c.split_item_id === item.id)
              const full = itemClaims.length >= item.slot_count
              const mine = itemClaims.some((c) => c.claimed_by_user_id === myUserId)
              const cls = ['marker', full ? 'markerFull' : '', mine ? 'markerMine' : '']
                .filter(Boolean)
                .join(' ')
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cls}
                  style={{
                    left: `${Number(item.anchor_x) * 100}%`,
                    top: `${Number(item.anchor_y) * 100}%`,
                    pointerEvents: 'auto',
                  }}
                  title={item.label ?? `Split item (${item.slot_count} slots)`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onMarkerClick?.(item.id)
                  }}
                />
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
