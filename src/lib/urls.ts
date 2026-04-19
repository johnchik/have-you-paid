export function appBasePath(): string {
  const b = import.meta.env.BASE_URL
  return b.endsWith('/') ? b : `${b}/`
}

export function joinSessionUrl(sessionId: string): string {
  return `${window.location.origin}${appBasePath()}join/${sessionId}`
}
