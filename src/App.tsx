import { useEffect, useRef, useState } from 'react'
import './App.css'
import { TalkButton } from './components/TalkButton'
import { ChatPanel, type ChatMessage } from './components/ChatPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { isSignedIn, requestAccessToken, signOut, trySilentSignIn } from './auth/google'
import { isSpeechRecognitionSupported, listenOnce, speak } from './voice/speech'
import { runAgentTurn, type AgentMessage } from './llm/agent'
import { getSyncStatus, initSyncEngine, onSyncStatusChange, type SyncStatus } from './calendar/syncEngine'

type ButtonState = 'idle' | 'listening' | 'thinking' | 'speaking'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A short, reply-length-scaled pause with a little randomness, so a fast
 * on-device reply doesn't feel like an instant lookup firing back. */
function naturalPause(replyText: string) {
  const base = 260 + Math.min(replyText.length * 6, 700)
  const jitter = Math.random() * 220
  return sleep(base + jitter)
}

const STATUS_LABEL: Record<SyncStatus, string> = {
  'signed-out': '',
  offline: 'Offline · changes saved locally',
  syncing: 'Syncing…',
  synced: 'Connected · tap to sign out',
  error: 'Some changes need to sync · tap to sign out',
}

function App() {
  const [signedIn, setSignedIn] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [buttonState, setButtonState] = useState<ButtonState>('idle')
  const [hint, setHint] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [clarification, setClarification] = useState<string | null>(null)
  const [modelStatus, setModelStatus] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(getSyncStatus())
  const historyRef = useRef<AgentMessage[]>([])

  useEffect(() => {
    let cancelled = false
    async function restoreSession() {
      if (isSignedIn()) {
        // Ever granted consent before — restore the session with no visible
        // prompt. Falls back to the sign-in screen only if the browser's
        // Google session itself is gone.
        await trySilentSignIn()
        if (!cancelled) setSignedIn(true)
      }
      if (!cancelled) setCheckingSession(false)
    }
    void restoreSession()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!signedIn) return
    initSyncEngine()
    return onSyncStatusChange(setSyncStatus)
  }, [signedIn])

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
      // A reply that lands instantly reads as robotic — a short, length-scaled
      // pause (with a little jitter) is what makes it feel like someone
      // actually composed the answer rather than a lookup firing back.
      await naturalPause(result.reply)
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

  if (checkingSession) {
    return <div className="app" />
  }

  if (!signedIn) {
    return (
      <div className="app">
        <div className="sign-in-screen">
          <h1>Calvet</h1>
          <p>Sign in with Google to connect your calendar. Just once — after that, Calvet remembers you.</p>
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
        {modelStatus || STATUS_LABEL[syncStatus]}
      </div>
      <TalkButton state={buttonState} onPress={handleTalkPress} />
      <div className="talk-hint">{hint || (buttonState === 'listening' ? 'Listening…' : 'Tap to talk')}</div>
      {clarification && <div className="clarify-banner">{clarification}</div>}
      <div className="bottom-actions">
        <button className="chat-toggle" onClick={() => setChatOpen(true)}>
          Chat instead
        </button>
        <button className="settings-toggle" onClick={() => setSettingsOpen(true)} aria-label="Settings">
          ⚙
        </button>
      </div>
      {chatOpen && (
        <ChatPanel
          messages={messages}
          busy={busy}
          onSend={processUserText}
          onClose={() => setChatOpen(false)}
        />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

export default App
