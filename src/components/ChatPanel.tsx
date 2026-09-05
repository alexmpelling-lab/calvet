import { useEffect, useRef, useState, type FormEvent } from 'react'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (text: string) => void
  onClose: () => void
  busy: boolean
}

export function ChatPanel({ messages, onSend, onClose, busy }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!draft.trim() || busy) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Calvet</span>
        <button onClick={onClose} aria-label="Close chat">✕</button>
      </div>
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="chat-bubble assistant">…</div>}
        <div ref={messagesEndRef} />
      </div>
      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </div>
  )
}
