import { KokoroTTS } from 'kokoro-js'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const VOICE = 'af_heart' // top-graded American English voice — warm, natural pacing

let ttsPromise: Promise<KokoroTTS> | null = null

/** Lazily loads the Kokoro neural TTS model (a small open-weight model,
 * ~80MB quantized) fully client-side via Transformers.js/ONNX Runtime Web —
 * downloaded once from Hugging Face and cached by the browser afterwards,
 * same pattern as the on-device LLM. No audio ever leaves the device. */
function loadTts(onProgress?: (fraction: number) => void): Promise<KokoroTTS> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (progress: { status: string; progress?: number }) => {
        if (progress.status === 'progress' && typeof progress.progress === 'number') {
          onProgress?.(progress.progress / 100)
        }
      },
    }).catch((err) => {
      ttsPromise = null
      throw err
    })
  }
  return ttsPromise
}

let currentAudio: HTMLAudioElement | null = null

/** Generates speech for `text` with the neural voice and plays it. Resolves
 * once playback finishes. Throws if the model can't be loaded (caller
 * should fall back to the browser's built-in speech synthesis). */
export async function speakWithKokoro(text: string, onProgress?: (fraction: number) => void): Promise<void> {
  const tts = await loadTts(onProgress)
  const audio = await tts.generate(text, { voice: VOICE })
  const blob = audio.toBlob()
  const url = URL.createObjectURL(blob)

  currentAudio?.pause()
  const el = new Audio(url)
  currentAudio = el

  await new Promise<void>((resolve, reject) => {
    el.onended = () => resolve()
    el.onerror = () => reject(new Error('Playback failed'))
    el.play().catch(reject)
  }).finally(() => {
    URL.revokeObjectURL(url)
    if (currentAudio === el) currentAudio = null
  })
}

export function isKokoroReady(): boolean {
  return ttsPromise !== null
}

export function preloadKokoro(onProgress?: (fraction: number) => void): Promise<KokoroTTS> {
  return loadTts(onProgress)
}
