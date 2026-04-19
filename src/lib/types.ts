export type SessionRow = {
  id: string
  host_user_id: string
  receipt_storage_path: string | null
  status: 'open' | 'locked'
  locked_at: string | null
  title: string | null
  /** null = no cap on guest joins (host is not counted). */
  max_guests: number | null
  created_at: string
}

export type SessionParticipantRow = {
  session_id: string
  user_id: string
  role: 'host' | 'guest'
  joined_at: string
}

export type SplitItemRow = {
  id: string
  session_id: string
  slot_count: number
  anchor_x: number
  anchor_y: number
  label: string | null
  created_at: string
}

export type SlotClaimRow = {
  id: string
  split_item_id: string
  slot_index: number
  claimed_by_user_id: string
  claimed_at: string
}

export type PaymentAckRow = {
  session_id: string
  user_id: string
  acknowledged_at: string
}

export type ProfileRow = {
  id: string
  display_name: string
  updated_at: string
}
