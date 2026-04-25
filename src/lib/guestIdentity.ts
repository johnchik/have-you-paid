const GUEST_TOKEN_KEY = 'have-you-paid.guest-token'
const GUEST_NAME_KEY = 'have-you-paid.guest-name'

function fallbackUuid() {
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function getOrCreateGuestToken() {
  if (typeof window === 'undefined') return fallbackUuid()

  const existing = window.localStorage.getItem(GUEST_TOKEN_KEY)?.trim()
  if (existing) return existing

  const token =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackUuid()
  window.localStorage.setItem(GUEST_TOKEN_KEY, token)
  return token
}

export function getGuestDisplayName() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(GUEST_NAME_KEY)?.trim() ?? ''
}

export function setGuestDisplayName(name: string) {
  if (typeof window === 'undefined') return
  const trimmed = name.trim()
  if (trimmed) {
    window.localStorage.setItem(GUEST_NAME_KEY, trimmed)
  } else {
    window.localStorage.removeItem(GUEST_NAME_KEY)
  }
}

export function defaultGuestDisplayName() {
  return getGuestDisplayName() || 'Guest'
}
