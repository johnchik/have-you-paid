/** Default session title when the host creates a session (local date). */
export function defaultNewSessionTitle(): string {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Display created_at in the session list. */
export function formatSessionCreatedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}
