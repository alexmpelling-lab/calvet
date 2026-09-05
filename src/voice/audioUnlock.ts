let unlocked = false

/** iOS Safari (and some other mobile browsers) only allow audio playback
 * that's tied directly to a user gesture's call stack — once any `await`
 * happens in between (an LLM call, the natural-reply pause, a network
 * request), a later `audio.play()` can be silently blocked. The fix is the
 * standard one-time "unlock": play a near-silent clip synchronously inside
 * the very first real user gesture, which unlocks playback for the page's
 * whole lifetime — every later programmatic play() then works regardless of
 * how far removed it is from a click. Call this at the top of any handler
 * that begins a voice turn, before any `await`. */
export function unlockAudioPlayback(): void {
  if (unlocked) return
  unlocked = true
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
    // A silent <audio> element too — some iOS versions gate HTMLAudioElement
    // playback separately from WebAudio.
    const el = new Audio()
    el.muted = true
    el.play().catch(() => {
      // Autoplay policies vary; if this one attempt fails, subsequent
      // Kokoro/SpeechSynthesis playback initiated from this same click will
      // usually still succeed since the gesture itself was real.
    })
  } catch {
    // No Web Audio support — nothing to unlock, browser voice fallback
    // will still work since SpeechSynthesis has looser gesture rules.
  }
}
