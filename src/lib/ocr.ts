import { supabase } from './supabaseClient'

const PRICE_RE = /(?:HK\$|\$)?\d{1,4}(?:[.,]\d{3})*[.,]\d{2}$/
const IGNORE_RE =
  /\b(subtotal|total|tax|tip|service|change|cash|visa|mastercard|amex|payment|paid|amount|balance|order|server|table|guest|receipt)\b/i
const NON_ITEM_RE =
  /(訂單|單號|桌號|台號|入座|開桌|埋單|結帳|付款|支付|找續|電話|地址|歡迎|謝謝|合計|小計|稅|服務費|總數|總計|時間|日期|term id)/i
const HAS_TEXT_RE = /[\p{Script=Han}A-Za-z]/u
const DIGIT_HEAVY_RE = /^[\d\s.,:$()\-/%]+$/u
const ONLY_PRICE_RE = /^(?:HK\$|\$)?\d{1,4}(?:[.,]\d{3})*[.,]\d{2}$/
const QUANTITY_PREFIX_RE = /^\d+\s*[xX×*]\s*/u

export type OcrDraftItem = {
  id: string
  label: string
  slotCount: number
  confidence: number | null
  priceText: string | null
  unitPrice: number | null
  rawText: string
}

export type OcrLine = {
  text: string
  confidence: number | null
}

type ReceiptOcrSource = Blob | { filePath: string; sessionId: string }

function nextId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function parsePriceText(value: string | null | undefined): number | null {
  if (!value) return null
  const normalized = value.replace(/HK\$/gi, '').replace(/\$/g, '').replace(/,/g, '').trim()
  if (normalized.length === 0) return null
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanupCandidateLabel(value: string) {
  return normalizeWhitespace(
    value
      .replace(PRICE_RE, '')
      .replace(/(?:HK\$|\$)?\d{1,4}(?:[.,]\d{3})*[.,]\d{2}/gu, ' ')
      .replace(QUANTITY_PREFIX_RE, '')
      .replace(/^[xX×*]\s*/u, '')
      .replace(/^[0-9]+[.)、:-]\s*/u, '')
      .replace(/^[xX*#\-.:\s]+/, '')
      .replace(/\s+[xX×]\s+\d+(?:\.\d+)?$/u, '')
      .replace(/^\d+\s+/u, '')
      .replace(/[.\-_:|]+$/u, ''),
  )
}

function fallbackCandidateLabel(value: string) {
  return normalizeWhitespace(
    value
      .replace(/(?:HK\$|\$)?\d{1,4}(?:[.,]\d{3})*[.,]\d{2}/gu, ' ')
      .replace(QUANTITY_PREFIX_RE, '')
      .replace(/^[xX×*]\s*/u, '')
      .replace(/[|]/gu, ' ')
      .replace(/[^\p{Script=Han}A-Za-z0-9/&()+,\-.\s]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
}

function hasPriceOnly(value: string) {
  return ONLY_PRICE_RE.test(normalizeWhitespace(value))
}

function looksLikeQuantityLabel(value: string) {
  const text = normalizeWhitespace(value)
  return QUANTITY_PREFIX_RE.test(text) && HAS_TEXT_RE.test(text)
}

function cleanBilingualDuplicate(value: string) {
  return normalizeWhitespace(
    value
      .replace(/\)\s+\(/gu, ') (')
      .replace(/\s{2,}/gu, ' '),
  )
}

function mergeNeighborLabels(current: string, next: string) {
  const currentHasHan = /[\p{Script=Han}]/u.test(current)
  const currentHasLatin = /[A-Za-z]/.test(current)
  const nextHasHan = /[\p{Script=Han}]/u.test(next)
  const nextHasLatin = /[A-Za-z]/.test(next)

  if ((currentHasHan && nextHasLatin) || (currentHasLatin && nextHasHan)) {
    return cleanBilingualDuplicate(`${current} / ${next}`)
  }

  return cleanBilingualDuplicate(current)
}

function parseReceiptLines(lines: OcrLine[]): OcrDraftItem[] {
  const seen = new Set<string>()
  const draftItems: OcrDraftItem[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const rawText = normalizeWhitespace(line.text)
    if (rawText.length < 3) continue
    if (IGNORE_RE.test(rawText)) continue
    if (NON_ITEM_RE.test(rawText)) continue
    if (!HAS_TEXT_RE.test(rawText)) continue

    let combinedRawText = rawText
    let priceText = rawText.match(PRICE_RE)?.[0] ?? null
    const nextLine = lines[index + 1] ? normalizeWhitespace(lines[index + 1].text) : ''
    const nextNextLine = lines[index + 2] ? normalizeWhitespace(lines[index + 2].text) : ''

    if (!priceText && hasPriceOnly(nextLine)) {
      priceText = nextLine
      combinedRawText = `${rawText} ${nextLine}`
      if (looksLikeQuantityLabel(nextNextLine)) {
        combinedRawText = `${rawText} ${nextLine} ${mergeNeighborLabels(rawText, nextNextLine)}`
      }
    }

    if (!priceText) continue

    let label = cleanupCandidateLabel(rawText)
    if (looksLikeQuantityLabel(nextLine) && !hasPriceOnly(nextLine)) {
      label = mergeNeighborLabels(label, cleanupCandidateLabel(nextLine))
    }
    if (looksLikeQuantityLabel(nextNextLine) && hasPriceOnly(nextLine)) {
      label = mergeNeighborLabels(label, cleanupCandidateLabel(nextNextLine))
    }
    if (label.length < 2) continue
    if (!HAS_TEXT_RE.test(label)) continue

    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    draftItems.push({
      id: nextId(),
      label,
      slotCount: 1,
      confidence: line.confidence,
      priceText,
      unitPrice: parsePriceText(priceText),
      rawText: combinedRawText,
    })
  }

  if (draftItems.length > 0) return draftItems

  for (const line of lines) {
    const rawText = normalizeWhitespace(line.text)
    if (rawText.length < 3) continue
    if (IGNORE_RE.test(rawText)) continue
    if (NON_ITEM_RE.test(rawText)) continue
    if (!HAS_TEXT_RE.test(rawText)) continue

    const label = fallbackCandidateLabel(rawText)
    if (label.length < 2) continue
    if (DIGIT_HEAVY_RE.test(label)) continue

    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    draftItems.push({
      id: nextId(),
      label,
      slotCount: 1,
      confidence: line.confidence,
      priceText: rawText.match(PRICE_RE)?.[0] ?? null,
      unitPrice: parsePriceText(rawText.match(PRICE_RE)?.[0] ?? null),
      rawText,
    })

    if (draftItems.length >= 25) break
  }

  return draftItems
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export async function runReceiptOcr(source: ReceiptOcrSource, onProgress?: (message: string) => void): Promise<OcrDraftItem[]> {
  let body: { imageBase64?: string; mimeType?: string; filePath?: string; sessionId?: string }

  if (source instanceof Blob) {
    onProgress?.('Preparing image…')
    const imageBase64 = await blobToBase64(source)
    body = {
      imageBase64,
      mimeType: source.type || 'image/jpeg',
    }
  } else {
    onProgress?.('Loading uploaded receipt…')
    body = {
      filePath: source.filePath,
      sessionId: source.sessionId,
    }
  }

  onProgress?.('Sending receipt to Google OCR…')
  const { data, error } = await supabase.functions.invoke('receipt-ocr', { body })

  if (error) {
    throw new Error(error.message || 'Receipt OCR request failed.')
  }

  const fullText = typeof data?.fullText === 'string' ? data.fullText : ''
  const rawLines = Array.isArray(data?.lines)
    ? data.lines
        .map((line: { text?: unknown; confidence?: unknown }) => ({
          text: typeof line?.text === 'string' ? line.text : '',
          confidence: typeof line?.confidence === 'number' ? line.confidence : null,
        }))
        .filter((line: OcrLine) => line.text.trim().length > 0)
    : []

  console.groupCollapsed('[OCR] Raw Google Vision output')
  console.log('fullText', fullText)
  console.table(
    rawLines.map((line: OcrLine, index: number) => ({
      index,
      confidence: line.confidence,
      text: line.text,
    })),
  )
  console.groupEnd()

  if (typeof data?.cleanupError === 'string' && data.cleanupError.trim().length > 0) {
    console.warn('[OCR] Receipt cleanup warning', data.cleanupError)
    onProgress?.('OCR finished, but receipt cleanup still needs attention.')
  } else if (!(source instanceof Blob)) {
    onProgress?.('OCR finished and the uploaded receipt was deleted.')
  } else {
    onProgress?.(`Google OCR returned ${rawLines.length} lines.`)
  }

  return parseReceiptLines(rawLines)
}
