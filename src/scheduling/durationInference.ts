import { getAllLocalEvents } from '../db/eventsDb'

const STOP_WORDS = new Set(['with', 'and', 'the', 'a', 'an', 'at', 'for', 'to', 'meeting', 'call', 'catch', 'up'])

function significantWords(summary: string): string[] {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
}

export interface DurationInference {
  typicalMinutes: number
  sampleSize: number
}

const MIN_SAMPLES = 2

/** Looks at past events with a similar summary (sharing a significant word —
 * usually a person's name or the subject, like "Priya" in "Coffee with
 * Priya") and returns how long those actually tended to run. Used to gently
 * flag when a newly requested duration looks off from established pattern,
 * without ever silently overriding what the user asked for. */
export async function inferTypicalDuration(summary: string, excludeId?: string): Promise<DurationInference | null> {
  const keywords = significantWords(summary)
  if (keywords.length === 0) return null

  const all = await getAllLocalEvents()
  const durations: number[] = []
  for (const event of all) {
    if (event.syncStatus === 'pending-delete') continue
    if (excludeId && (event.googleId === excludeId || event.localId === excludeId)) continue
    const otherWords = significantWords(event.summary)
    if (!keywords.some((w) => otherWords.includes(w))) continue
    const minutes = (new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()) / 60_000
    if (minutes > 0 && minutes < 12 * 60) durations.push(minutes)
  }

  if (durations.length < MIN_SAMPLES) return null
  const typicalMinutes = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 5) * 5
  return { typicalMinutes, sampleSize: durations.length }
}
