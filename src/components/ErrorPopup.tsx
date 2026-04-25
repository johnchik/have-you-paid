type Props = {
  message: string
  onClose: () => void
}

export function ErrorPopup({ message, onClose }: Props) {
  return (
    <div className="errorToast" role="alert" aria-live="assertive">
      <span>{message}</span>
      <button type="button" className="btn" onClick={onClose}>
        Dismiss
      </button>
    </div>
  )
}
