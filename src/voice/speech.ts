interface SpeechRecognitionResultEvent extends Event {
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onend: (() => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
}

export function isSpeechRecognitionSupported(): boolean {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

const LISTEN_TIMEOUT_MS = 15_000

/** Listens for a single spoken utterance and resolves with the transcript.
 * Guarantees the promise always settles: if the browser stops listening
 * with no speech detected (silence), that previously left the caller
 * hanging forever with the button stuck on "Listening…" — `onend` and a
 * hard timeout both now resolve to an empty transcript instead. */
export function listenOnce(): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Ctor) {
      reject(new Error('Speech recognition is not supported in this browser.'))
      return
    }
    const recognition = new Ctor()
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = false

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      fn()
    }

    const timeoutId = setTimeout(() => {
      try {
        recognition.stop()
      } catch {
        // already stopped
      }
      finish(() => reject(new Error("Didn't catch anything — try again.")))
    }, LISTEN_TIMEOUT_MS)

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? ''
      finish(() => resolve(transcript))
    }
    recognition.onerror = (event) => {
      finish(() => reject(new Error(`Speech recognition error: ${(event as { error?: string }).error ?? 'unknown'}`)))
    }
    recognition.onend = () => {
      // Fires when the browser gives up with no result and no error (pure
      // silence) — without this, the promise never settles.
      finish(() => reject(new Error("Didn't catch anything — try again.")))
    }
    recognition.start()
  })
}

let secretaryVoice: SpeechSynthesisVoice | null = null

function pickVoice(): SpeechSynthesisVoice | null {
  if (secretaryVoice) return secretaryVoice
  const voices = window.speechSynthesis.getVoices()
  secretaryVoice =
    voices.find((v) => /female/i.test(v.name) && /en/i.test(v.lang)) ??
    voices.find((v) => /en/i.test(v.lang)) ??
    voices[0] ??
    null
  return secretaryVoice
}

/** Fallback: the browser's built-in (robotic-ish) voice. Used only if the
 * neural voice can't load — no WebAssembly, blocked by browser policy, or
 * still downloading and the caller doesn't want to wait. */
function speakWithBrowserVoice(text: string): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.voice = pickVoice()
    utterance.rate = 1.05
    utterance.pitch = 1.0
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    window.speechSynthesis.speak(utterance)
  })
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    secretaryVoice = null
  }
}

let neuralVoiceFailed = false

// A failure might just be a flaky download or a momentary blip, not a
// permanent "this browser can't do it" — re-arm the neural voice whenever
// connectivity returns instead of downgrading to the robotic fallback for
// the rest of the session over one bad attempt.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    neuralVoiceFailed = false
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** Speaks a line in a calm, efficient secretary tone. Prefers the neural
 * Kokoro voice (natural pacing and prosody, runs fully offline once
 * downloaded); falls back to the browser's built-in speech synthesis if the
 * neural model fails to load, hangs, or fails to generate — so a stuck
 * download or a rare generation failure can never leave the app silently
 * frozen in the "speaking" state. A timeout only skips the neural voice for
 * *this* turn (the download keeps going in the background and may be ready
 * next turn); only a genuine rejection disables it until connectivity returns. */
export async function speak(text: string, onModelProgress?: (fraction: number) => void): Promise<void> {
  if (!neuralVoiceFailed) {
    try {
      const { speakWithKokoro } = await import('./kokoroTts')
      await withTimeout(speakWithKokoro(text, onModelProgress), 20_000)
      return
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Timed out')) {
        neuralVoiceFailed = true
      }
    }
  }
  await speakWithBrowserVoice(text)
}
