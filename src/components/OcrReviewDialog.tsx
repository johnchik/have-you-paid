import { useEffect, useState } from 'react'
import { parsePriceText, type OcrDraftItem } from '../lib/ocr'

type Props = {
  items: OcrDraftItem[]
  saving: boolean
  onClose: () => void
  onSave: (items: OcrDraftItem[]) => Promise<void>
}

export function OcrReviewDialog({ items, saving, onClose, onSave }: Props) {
  const [drafts, setDrafts] = useState<OcrDraftItem[]>(items)

  useEffect(() => {
    setDrafts(items)
  }, [items])

  const updateDraft = (id: string, patch: Partial<OcrDraftItem>) => {
    setDrafts((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const removeDraft = (id: string) => {
    setDrafts((current) => current.filter((item) => item.id !== id))
  }

  const addDraft = () => {
    setDrafts((current) => [
      ...current,
      {
        id:
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        label: '',
        slotCount: 1,
        confidence: null,
        priceText: null,
        unitPrice: null,
        rawText: '',
      },
    ])
  }

  const save = async () => {
    await onSave(
      drafts
        .map((item) => ({
          ...item,
          label: item.label.trim(),
          slotCount: 1,
          priceText: item.priceText?.trim() ? item.priceText.trim() : null,
          unitPrice: parsePriceText(item.priceText),
        }))
        .filter((item) => item.label.length > 0),
    )
  }

  return (
    <dialog open className="card ocrReviewDialog" style={{ position: 'fixed', inset: 'auto', margin: 'auto', zIndex: 20 }}>
      <div className="stack">
        <div className="claimDialogTitleRow">
          <h2 className="h2 claimDialogTitle">Review OCR Items</h2>
        </div>
        <p className="muted">
          OCR created a draft list. Fix labels, remove junk rows, edit prices, or add missing items before saving.
        </p>
        {drafts.length === 0 ? <p className="muted">No likely receipt items were detected. You can still add rows manually.</p> : null}
        <div className="stack ocrDraftList">
          {drafts.map((item, index) => (
            <div key={item.id} className="ocrDraftRow">
              <label className="field ocrDraftLabel">
                Item
                <input
                  type="text"
                  value={item.label}
                  onChange={(e) => updateDraft(item.id, { label: e.target.value })}
                  placeholder={`Item ${index + 1}`}
                />
              </label>
              <label className="field ocrDraftPrice">
                Price
                <input
                  type="text"
                  inputMode="decimal"
                  value={item.priceText ?? ''}
                  onChange={(e) =>
                    updateDraft(item.id, {
                      priceText: e.target.value,
                      unitPrice: parsePriceText(e.target.value),
                    })
                  }
                  placeholder="$0.00"
                />
              </label>
              <div className="ocrDraftMeta">
                <span className="muted">{item.unitPrice == null ? 'No price saved' : `Saved as $${item.unitPrice.toFixed(2)}`}</span>
                <span className="muted">
                  {item.confidence == null ? 'Manual' : `${Math.round(item.confidence)}% confidence`}
                </span>
              </div>
              <button type="button" className="btn btnDanger" onClick={() => removeDraft(item.id)}>
                Delete
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={addDraft} disabled={saving}>
            Add row
          </button>
          <button type="button" className="btn btnPrimary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save items'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  )
}
