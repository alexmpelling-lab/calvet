import { useEffect, useRef, useState } from 'react'
import './App.css'
import { TalkButton } from './components/TalkButton'
import { ChatPanel, type ChatMessage } from './components/ChatPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { isSignedIn, requestAccessToken, signOut, trySilentSignIn } from './auth/google'
import { isSpeechRecognitionSupported, listenOnce, speak } from './voice/speech'
import { unlockAudioPlayback } from './voice/audioUnlock'
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
  'needs-reauth': 'Tap to reconnect Google',
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
        // Ever granted consent before — this alone is enough to show the
        // main app. A silent token refresh is attempted in the background,
        // but a transient failure here (a slow network, a momentary GIS
        // hiccup) must never bounce a returning user back to the sign-in
        // screen — that would break the "log in exactly once" promise for
        // reasons that have nothing to do with actually being signed out.
        // Individual calendar calls retry the silent refresh themselves.
        void trySilentSignIn()
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

  function handleStatusLineClick() {
    if (syncStatus === 'needs-reauth') {
      // This click is a genuine user gesture, so the consent popup Google
      // requires will actually be allowed to open — unlike the background
      // sync attempt that got us into this state in the first place.
      void handleSignIn()
      return
    }
    handleSignOut()
  }

  async function processUserText(text: string) {
    setBusy(true)
    setClarification(null)
    setMessages((prev) => [...prev, { role: 'user', text }])
    setButtonState('thinking')
    if (!modelStatus) setModelStatus('Warming up…')
    try {
      const result = await runAgentTurn(historyRef.current, text, (fraction) => {
        // First-ever message downloads a ~1.7GB model with nothing else to
        // show for it otherwise — a static "Warming up…" for several
        // minutes on an ordinary connection looks indistinguishable from
        // being stuck. A live percentage is proof it's actually working.
        if (fraction > 0) setModelStatus(`Warming up… ${Math.round(fraction * 100)}%`)
      })
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
      await speak(result.reply, (fraction) => {
        setModelStatus(`Loading voice… ${Math.round(fraction * 100)}%`)
      })
    } catch (err) {
      // Never show a raw browser/technical error ("NetworkError when
      // attempting to fetch resource", a stack-trace-ish message) straight
      // in the chat log — log it for diagnosis, but say something a
      // secretary would actually say, and make clear it's safe to retry.
      console.error('Calvet turn failed:', err)
      const message =
        err instanceof TypeError || (err instanceof Error && /network|fetch/i.test(err.message))
          ? "Sorry, I lost the connection there — mind trying that again?"
          : "Sorry, something went wrong on my end — could you try that again?"
      setMessages((prev) => [...prev, { role: 'assistant', text: message }])
    } finally {
      setBusy(false)
      setButtonState('idle')
      setModelStatus('')
    }
  }

  function handleChatSend(text: string) {
    // Same iOS audio-unlock requirement as the talk button — chat's Send
    // is just as much a real user gesture and needs the same synchronous
    // unlock before the async agent turn begins.
    unlockAudioPlayback()
    void processUserText(text)
  }

  function handleTalkPress() {
    // Unlocking must happen synchronously inside the real click, before any
    // `await` — on iOS Safari, audio playback tied to a gesture that's
    // already crossed an async boundary (the LLM call, the natural pause)
    // can be silently blocked otherwise, leaving Calvet mute with no error.
    unlockAudioPlayback()
    void runTalkTurn()
  }

  async function runTalkTurn() {
    // Guards against a second turn starting while one is already in
    // flight — pressing the talk button mid-reply (or mid-chat-send)
    // previously could kick off a second concurrent agent turn and
    // interleave conversation history out of order.
    if (buttonState !== 'idle' || busy) return
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
      } else {
        setHint("Didn't catch anything — try again.")
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
      <div className="status-line" onClick={handleStatusLineClick} role="button">
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
          statusText={modelStatus}
          onSend={handleChatSend}
          onClose={() => setChatOpen(false)}
        />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

export default App
