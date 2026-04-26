export type SessionStatus = 'open' | 'settled'

export type Session = {
  id: string
  name: string
  currency: string
  status: SessionStatus
  host_payment_comment: string | null
  accepts_fps: boolean | null
  accepts_payme: boolean | null
  receipt_storage_path: string | null
  created_at: string
}

export type SessionMemberStatus = 'placeholder' | 'claimed' | 'linked'

export type SessionMember = {
  id: string
  session_id: string
  display_name: string
  guest_token: string | null
  user_id: string | null
  is_host: boolean
  status: SessionMemberStatus
  avatar_color: string | null
  claimed_at: string | null
  created_at: string
}

export type ExpenseSource = 'ocr' | 'manual'

export type Expense = {
  id: string
  session_id: string
  name: string
  amount: number
  source: ExpenseSource
  sort_order: number | null
  ocr_confidence: number | null
  created_at: string
}

export type ExpenseClaim = {
  id: string
  expense_id: string
  member_id: string
  share_amount: number
  created_at: string
}

export type SettlementStatus = 'pending' | 'confirmed'

export type Settlement = {
  id: string
  session_id: string
  from_member_id: string
  to_member_id: string
  amount: number
  status: SettlementStatus
  created_at: string
  confirmed_at: string | null
}

export type Profile = {
  id: string
  display_name: string
  default_payment_comment: string | null
  default_accepts_fps: boolean | null
  default_accepts_payme: boolean | null
  payment_qr_url: string | null
  updated_at: string
}
