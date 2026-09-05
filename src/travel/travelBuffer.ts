import type { CalendarEvent } from '../calendar/localCalendar'
import { findAdjacentEvents } from '../calendar/localCalendar'
import { checkFeasibility } from './feasibility'
import { TRAVEL_MODES } from '../settings/travelSettings'

export interface TravelBufferSuggestion {
  text: string
  suggestedEvent: {
    summary: string
    start: string
    end: string
    location: string
  }
}

const MODE_LABEL = Object.fromEntries(TRAVEL_MODES.map((m) => [m.mode, m.label.toLowerCase()]))
const MAX_GAP_HOURS = 3

async function checkPair(
  earlier: CalendarEvent,
  later: CalendarEvent
): Promise<TravelBufferSuggestion | null> {
  if (!earlier.location || !later.location) return null
  if (earlier.location.trim().toLowerCase() === later.location.trim().toLowerCase()) return null

  const gapStart = new Date(earlier.end.dateTime).getTime()
  const gapEnd = new Date(later.start.dateTime).getTime()
  const gapMinutes = (gapEnd - gapStart) / 60_000
  // The gap-size bound below already covers "reasonably close together" —
  // a separate same-calendar-day check on top of it used to wrongly reject
  // a genuinely tight, legitimate gap that happens to cross midnight (an
  // 11:30pm event followed by one at 12:15am), so it's dropped here.
  if (gapMinutes <= 0 || gapMinutes > MAX_GAP_HOURS * 60) return null

  const report = await checkFeasibility(earlier.location, later.location)
  if (!report.best) return null

  const travelMinutes = Math.ceil(report.best.minutes / 5) * 5 // round up to a tidy 5-minute block
  const tight = travelMinutes >= gapMinutes * 0.7 // worth flagging even if technically possible

  if (!tight && travelMinutes < gapMinutes - 10) return null

  const suggestedStart = new Date(gapStart)
  const suggestedEnd = new Date(gapStart + travelMinutes * 60_000)
  const modeLabel = MODE_LABEL[report.best.mode]

  const fits = travelMinutes <= gapMinutes
  const text = fits
    ? `Heads up — you've only got ${Math.round(gapMinutes)} min between "${earlier.summary}" and "${later.summary}", and it's about ${travelMinutes} min ${modeLabel} between them. Want me to block that travel time?`
    : `That's tight — "${later.summary}" starts before you could realistically get there from "${earlier.summary}" (about ${travelMinutes} min ${modeLabel}). Want me to add a travel block and flag it?`

  return {
    text,
    suggestedEvent: {
      summary: `Travel to ${later.location}`,
      start: suggestedStart.toISOString(),
      end: suggestedEnd.toISOString(),
      location: `${earlier.location} → ${later.location}`,
    },
  }
}

/** Checks whether a newly created/edited event creates a tight or
 * infeasible gap with the event immediately before or after it, and if so
 * returns a ready-to-confirm travel block to offer the user. */
export async function suggestTravelBuffer(event: CalendarEvent): Promise<TravelBufferSuggestion | null> {
  if (!event.location) return null
  const { prev, next } = await findAdjacentEvents(event)

  if (prev) {
    const suggestion = await checkPair(prev, event)
    if (suggestion) return suggestion
  }
  if (next) {
    const suggestion = await checkPair(event, next)
    if (suggestion) return suggestion
  }
  return null
}
