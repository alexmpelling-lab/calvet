import { findConflicts, findFreeSlots, type CalendarEvent } from '../calendar/localCalendar'

export interface ConflictReport {
  conflicts: CalendarEvent[]
  /** The conflicting event Calvet would suggest bumping first — cancelable
   * or explicitly low-priority — if the user wants to keep the new time. */
  bumpCandidate?: CalendarEvent
  /** The nearest free slot of the same duration, if the user would rather
   * move the new event instead. */
  nearestFreeSlot?: { start: string; end: string }
}

const SEARCH_WINDOW_HOURS = 24

/** Checks whether a proposed time collides with anything already on the
 * calendar, and — if so — works out the two ways out: bump a low-priority/
 * cancelable conflicting event, or move to the nearest same-length free
 * slot within the same day-ish window. Read-only; never changes anything
 * itself, so the agent can offer the choice before touching the calendar. */
export async function checkForConflicts(start: Date, end: Date, excludeId?: string): Promise<ConflictReport> {
  const conflicts = await findConflicts(start, end, excludeId)
  if (conflicts.length === 0) return { conflicts: [] }

  const bumpCandidate = conflicts.find((c) => c.cancelable || c.priority === 'low')

  const durationMs = end.getTime() - start.getTime()
  const windowStart = start
  const windowEnd = new Date(start.getTime() + SEARCH_WINDOW_HOURS * 60 * 60 * 1000)
  const freeSlots = await findFreeSlots(windowStart, windowEnd)
  const bigEnough = freeSlots.find((slot) => new Date(slot.end).getTime() - new Date(slot.start).getTime() >= durationMs)
  const nearestFreeSlot = bigEnough
    ? { start: bigEnough.start, end: new Date(new Date(bigEnough.start).getTime() + durationMs).toISOString() }
    : undefined

  return { conflicts, bumpCandidate, nearestFreeSlot }
}
