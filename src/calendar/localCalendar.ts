import {
  getAllLocalEvents,
  getLocalEventByAnyId,
  putLocalEvent,
  deleteLocalEvent,
  type LocalEvent,
} from '../db/eventsDb'
import { isOnline, sync } from './syncEngine'

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string; displayName?: string }[]
  priority?: 'low' | 'normal' | 'high'
  cancelable?: boolean
}

function effectiveId(e: LocalEvent): string {
  return e.googleId ?? e.localId
}

function toPublicEvent(e: LocalEvent): CalendarEvent {
  return {
    id: effectiveId(e),
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    attendees: e.attendees,
    priority: e.priority,
    cancelable: e.cancelable,
  }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** Every calendar read/write in the app goes through here. It always reads
 * and writes the local IndexedDB mirror first — so the app works offline —
 * and opportunistically syncs with Google Calendar when the network is up.
 * Nothing calls `googleCalendar.ts` directly except this file and the sync
 * engine's push/pull loop. */

export async function getEventById(id: string): Promise<CalendarEvent | undefined> {
  const event = await getLocalEventByAnyId(id)
  return event ? toPublicEvent(event) : undefined
}

export async function listUpcomingEvents(maxResults = 10): Promise<CalendarEvent[]> {
  if (isOnline()) {
    try {
      await sync()
    } catch {
      // Fall through to whatever the local mirror already has.
    }
  }
  const all = await getAllLocalEvents()
  const now = Date.now()
  return all
    .filter((e) => e.syncStatus !== 'pending-delete' && new Date(e.start.dateTime).getTime() >= now - 60_000)
    .sort((a, b) => new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime())
    .slice(0, maxResults)
    .map(toPublicEvent)
}

export interface CreateEventInput {
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string; displayName?: string }[]
  priority?: 'low' | 'normal' | 'high'
  cancelable?: boolean
}

export async function createEvent(input: CreateEventInput): Promise<CalendarEvent> {
  const record: LocalEvent = {
    localId: crypto.randomUUID(),
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    attendees: input.attendees,
    priority: input.priority,
    cancelable: input.cancelable,
    updatedAt: Date.now(),
    syncStatus: 'pending-create',
    createdByCalvet: true,
  }
  await putLocalEvent(record)
  if (isOnline()) void sync()
  return toPublicEvent(record)
}

export async function updateEvent(id: string, changes: Partial<CalendarEvent>): Promise<CalendarEvent> {
  const existing = await getLocalEventByAnyId(id)
  if (!existing) throw new Error(`No such event: ${id}`)
  const updated: LocalEvent = {
    ...existing,
    summary: changes.summary ?? existing.summary,
    description: changes.description ?? existing.description,
    location: changes.location ?? existing.location,
    start: changes.start ?? existing.start,
    end: changes.end ?? existing.end,
    attendees: changes.attendees ?? existing.attendees,
    priority: changes.priority ?? existing.priority,
    cancelable: changes.cancelable ?? existing.cancelable,
    updatedAt: Date.now(),
    syncStatus: existing.syncStatus === 'pending-create' ? 'pending-create' : 'pending-update',
  }
  await putLocalEvent(updated)
  if (isOnline()) void sync()
  return toPublicEvent(updated)
}

export type DeleteEventResult =
  | { status: 'deleted' }
  | { status: 'needs-confirmation'; summary: string; location?: string }
  | { status: 'not-found' }

/** Deletes an event. Anything Calvet didn't create itself (an event already
 * on the calendar, or added by another app/invite) requires `confirmed:
 * true` — otherwise this returns `needs-confirmation` instead of deleting,
 * so the agent has to explicitly ask the user first. */
export async function deleteEvent(id: string, confirmed = false): Promise<DeleteEventResult> {
  const existing = await getLocalEventByAnyId(id)
  if (!existing) return { status: 'not-found' }

  if (!existing.createdByCalvet && !confirmed) {
    return { status: 'needs-confirmation', summary: existing.summary, location: existing.location }
  }

  if (existing.syncStatus === 'pending-create') {
    // Never reached Google — nothing to delete remotely.
    await deleteLocalEvent(existing.localId)
    return { status: 'deleted' }
  }
  await putLocalEvent({ ...existing, syncStatus: 'pending-delete', updatedAt: Date.now() })
  if (isOnline()) void sync()
  return { status: 'deleted' }
}

export interface FreeBusySlot {
  start: string
  end: string
}

/** Computed entirely from the local mirror, so it works offline too. */
export async function findFreeSlots(windowStart: Date, windowEnd: Date): Promise<FreeBusySlot[]> {
  const all = await getAllLocalEvents()
  const busy = all
    .filter((e) => e.syncStatus !== 'pending-delete')
    .map((e) => [new Date(e.start.dateTime), new Date(e.end.dateTime)] as const)
    .filter(([s, en]) => en > windowStart && s < windowEnd)
    .sort((a, b) => a[0].getTime() - b[0].getTime())

  const free: FreeBusySlot[] = []
  let cursor = windowStart
  for (const [busyStart, busyEnd] of busy) {
    if (busyStart > cursor) free.push({ start: cursor.toISOString(), end: busyStart.toISOString() })
    if (busyEnd > cursor) cursor = busyEnd
  }
  if (cursor < windowEnd) free.push({ start: cursor.toISOString(), end: windowEnd.toISOString() })
  return free
}

/** Finds the events immediately before and after the given one, regardless
 * of the small window `listUpcomingEvents` normally returns — used to spot
 * back-to-back events at different locations for the travel-buffer check. */
export async function findAdjacentEvents(event: CalendarEvent): Promise<{ prev?: CalendarEvent; next?: CalendarEvent }> {
  const all = await getAllLocalEvents()
  const others = all
    .filter((e) => e.syncStatus !== 'pending-delete' && effectiveId(e) !== event.id)
    .map(toPublicEvent)
    .sort((a, b) => new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime())

  const eventStart = new Date(event.start.dateTime).getTime()
  const eventEnd = new Date(event.end.dateTime).getTime()

  let prev: CalendarEvent | undefined
  let next: CalendarEvent | undefined
  for (const other of others) {
    const otherEnd = new Date(other.end.dateTime).getTime()
    const otherStart = new Date(other.start.dateTime).getTime()
    if (otherEnd <= eventStart && (!prev || otherEnd > new Date(prev.end.dateTime).getTime())) prev = other
    if (otherStart >= eventEnd && (!next || otherStart < new Date(next.start.dateTime).getTime())) next = other
  }
  return { prev, next }
}

/** Every non-deleted event that overlaps the given window, excluding one id
 * (useful when checking whether an edit to an event now collides with
 * something else). Used for conflict-aware scheduling. */
export async function findConflicts(
  start: Date,
  end: Date,
  excludeId?: string
): Promise<CalendarEvent[]> {
  const all = await getAllLocalEvents()
  const startMs = start.getTime()
  const endMs = end.getTime()
  return all
    .filter((e) => e.syncStatus !== 'pending-delete' && effectiveId(e) !== excludeId)
    .filter((e) => overlaps(startMs, endMs, new Date(e.start.dateTime).getTime(), new Date(e.end.dateTime).getTime()))
    .map(toPublicEvent)
}

function isSameCalendarDay(isoA: string, isoB: string): boolean {
  return new Date(isoA).toDateString() === new Date(isoB).toDateString()
}

/** All non-deleted events on the same calendar day as the given date,
 * sorted by start time. Used for day-density checks and cascading
 * reschedules. */
export async function findEventsOnSameDay(dateISO: string, excludeId?: string): Promise<CalendarEvent[]> {
  const all = await getAllLocalEvents()
  return all
    .filter((e) => e.syncStatus !== 'pending-delete' && effectiveId(e) !== excludeId)
    .filter((e) => isSameCalendarDay(e.start.dateTime, dateISO))
    .map(toPublicEvent)
    .sort((a, b) => new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime())
}

/** Every non-deleted event starting at or after the given time, on the same
 * calendar day — the set a cascading reschedule would shift. */
export async function findEventsStartingAfter(afterISO: string, excludeId?: string): Promise<CalendarEvent[]> {
  const afterMs = new Date(afterISO).getTime()
  const sameDay = await findEventsOnSameDay(afterISO, excludeId)
  return sameDay.filter((e) => new Date(e.start.dateTime).getTime() >= afterMs)
}

// Re-exported so callers that genuinely need the raw Google shape (none, by
// design) don't have to reach into googleCalendar.ts directly.
export type { CalendarEvent as GoogleCalendarEvent } from './googleCalendar'
