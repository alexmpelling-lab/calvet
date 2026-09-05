import { useEffect, useRef, useState } from 'react'
import './App.css'
import { TalkButton } from './components/TalkButton'
import { ChatPanel, type ChatMessage } from './components/ChatPanel'
import { isSignedIn, requestAccessToken, signOut } from './auth/google'
import { isSpeechRecognitionSupported, listenOnce, speak } from './voice/speech'
import { runAgentTurn, type AgentMessage } from './llm/agent'

type ButtonState = 'idle' | 'listening' | 'thinking' | 'speaking'

function App() {
  const [signedIn, setSignedIn] = useState(false)
  const [buttonState, setButtonState] = useState<ButtonState>('idle')
  const [hint, setHint] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [clarification, setClarification] = useState<string | null>(null)
  const [modelStatus, setModelStatus] = useState('')
  const historyRef = useRef<AgentMessage[]>([])

  useEffect(() => {
    setSignedIn(isSignedIn())
  }, [])

  async function handleSignIn() {
    try {
      await requestAccessToken(true)
      setSignedIn(true)
    } catch (err) {
      setHint(err instanceof Error ? err.message : 'Sign-in failed')
    }
  }

  function handleSignOut() {
    signOut()
    setSignedIn(false)
    setMessages([])
    historyRef.current = []
  }

  async function processUserText(text: string) {
    setBusy(true)
    setClarification(null)
    setMessages((prev) => [...prev, { role: 'user', text }])
    setButtonState('thinking')
    if (!modelStatus) setModelStatus('Warming up…')
    try {
      const result = await runAgentTurn(historyRef.current, text)
      historyRef.current.push({ role: 'user', content: text }, { role: 'assistant', content: result.reply })
      setMessages((prev) => [...prev, { role: 'assistant', text: result.reply }])
      if (result.clarification) {
        setClarification(
          `Just to check — is "${result.clarification.name}" the same as ${result.clarification.candidates.join(', ')}?`
        )
      }
      setButtonState('speaking')
      await speak(result.reply)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong.'
      setMessages((prev) => [...prev, { role: 'assistant', text: message }])
    } finally {
      setBusy(false)
      setButtonState('idle')
      setModelStatus('')
    }
  }

  async function handleTalkPress() {
    if (buttonState !== 'idle') return
    if (!isSpeechRecognitionSupported()) {
      setHint('Voice input is not supported in this browser. Use the chat below instead.')
      setChatOpen(true)
      return
    }
    setHint('')
    setButtonState('listening')
    try {
      const transcript = await listenOnce()
      setButtonState('idle')
      if (transcript.trim()) {
        await processUserText(transcript.trim())
      }
    } catch (err) {
      setButtonState('idle')
      setHint(err instanceof Error ? err.message : 'Could not hear you — try again.')
    }
  }

  if (!signedIn) {
    return (
      <div className="app">
        <div className="sign-in-screen">
          <h1>Calvet</h1>
          <p>Sign in with Google to connect your calendar.</p>
          <button className="google-btn" onClick={handleSignIn}>
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="status-line" onClick={handleSignOut} role="button">
        {modelStatus || 'Connected · tap to sign out'}
      </div>
      <TalkButton state={buttonState} onPress={handleTalkPress} />
      <div className="talk-hint">{hint || (buttonState === 'listening' ? 'Listening…' : 'Tap to talk')}</div>
      {clarification && <div className="clarify-banner">{clarification}</div>}
      <button className="chat-toggle" onClick={() => setChatOpen(true)}>
        Chat instead
      </button>
      {chatOpen && (
        <ChatPanel
          messages={messages}
          busy={busy}
          onSend={processUserText}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  )
}

export default App
