import { findEventsStartingAfter, updateEvent, type CalendarEvent } from '../calendar/localCalendar'

export interface CascadeShift {
  eventId: string
  summary: string
  currentStart: string
  newStart: string
  newEnd: string
}

export interface CascadeSuggestion {
  text: string
  deltaMinutes: number
  shifts: CascadeShift[]
}

const MAX_CASCADE_EVENTS = 8

/** When an anchor event's start time moves, works out what shifting every
 * later same-day event by the same delta would look like — read-only, a
 * suggestion for the agent to offer, never applied automatically. */
export async function suggestCascadeShift(
  anchorId: string,
  oldStartISO: string,
  newStartISO: string
): Promise<CascadeSuggestion | null> {
  const deltaMs = new Date(newStartISO).getTime() - new Date(oldStartISO).getTime()
  if (deltaMs === 0) return null

  const downstream = await findEventsStartingAfter(oldStartISO, anchorId)
  if (downstream.length === 0 || downstream.length > MAX_CASCADE_EVENTS) return null

  const shifts: CascadeShift[] = downstream.map((event) => {
    const newStart = new Date(new Date(event.start.dateTime).getTime() + deltaMs)
    const newEnd = new Date(new Date(event.end.dateTime).getTime() + deltaMs)
    return {
      eventId: event.id,
      summary: event.summary,
      currentStart: event.start.dateTime,
      newStart: newStart.toISOString(),
      newEnd: newEnd.toISOString(),
    }
  })

  const deltaMinutes = Math.round(deltaMs / 60_000)
  const direction = deltaMinutes > 0 ? 'later' : 'earlier'
  const names = shifts.map((s) => `"${s.summary}"`).join(', ')
  const text = `That also pushes everything after it — ${names} — ${Math.abs(deltaMinutes)} min ${direction} today. Want me to shift those too?`

  return { text, deltaMinutes, shifts }
}

/** Applies a previously-suggested cascade — only ever called after the user
 * has explicitly agreed to it. */
export async function applyCascadeShift(shifts: CascadeShift[]): Promise<CalendarEvent[]> {
  const updated: CalendarEvent[] = []
  for (const shift of shifts) {
    const event = await updateEvent(shift.eventId, {
      start: { dateTime: shift.newStart },
      end: { dateTime: shift.newEnd },
    })
    updated.push(event)
  }
  return updated
}
