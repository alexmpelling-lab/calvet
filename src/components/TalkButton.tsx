interface TalkButtonProps {
  state: 'idle' | 'listening' | 'thinking' | 'speaking'
  onPress: () => void
}

export function TalkButton({ state, onPress }: TalkButtonProps) {
  return (
    <button
      className={`talk-button ${state === 'listening' ? 'listening' : ''} ${state === 'speaking' ? 'speaking' : ''}`}
      onClick={onPress}
      aria-label="Talk to Calvet"
    >
      <svg viewBox="0 0 24 24">
        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
      </svg>
    </button>
  )
}
