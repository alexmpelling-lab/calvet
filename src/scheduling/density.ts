import { findEventsOnSameDay, findFreeSlots, type CalendarEvent } from '../calendar/localCalendar'

// A day this stacked is the point where back-to-back events stop leaving
// any real breathing room — worth flagging proactively rather than only
// reacting to one tight pair at a time.
const DENSE_DAY_THRESHOLD = 6

export interface DensityReport {
  count: number
  dense: boolean
  /** The largest remaining free gap that day, if any — a candidate spot to
   * actually take a breath, not just a warning with nowhere to act on it. */
  largestGap?: { start: string; end: string; minutes: number }
}

/** Checks how stacked a given day already is. Called after adding a new
 * event to that day, so the count includes the one just created. */
export async function checkDayDensity(dateISO: string): Promise<DensityReport> {
  const events: CalendarEvent[] = await findEventsOnSameDay(dateISO)
  const count = events.length
  if (count < DENSE_DAY_THRESHOLD) return { count, dense: false }

  const dayStart = new Date(dateISO)
  dayStart.setHours(7, 0, 0, 0)
  const dayEnd = new Date(dateISO)
  dayEnd.setHours(22, 0, 0, 0)

  const freeSlots = await findFreeSlots(dayStart, dayEnd)
  let largestGap: DensityReport['largestGap']
  for (const slot of freeSlots) {
    const minutes = (new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60_000
    if (minutes >= 15 && (!largestGap || minutes > largestGap.minutes)) {
      largestGap = { start: slot.start, end: slot.end, minutes: Math.round(minutes) }
    }
  }

  return { count, dense: true, largestGap }
}
