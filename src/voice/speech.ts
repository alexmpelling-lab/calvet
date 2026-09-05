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

/** Listens for a single spoken utterance and resolves with the transcript. */
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

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? ''
      resolve(transcript)
    }
    recognition.onerror = (event) => {
      reject(new Error(`Speech recognition error: ${(event as { error?: string }).error ?? 'unknown'}`))
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

/** Speaks a short line in a calm, efficient secretary tone. */
export function speak(text: string): Promise<void> {
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
