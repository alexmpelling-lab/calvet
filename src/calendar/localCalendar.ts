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
  }
}

/** Every calendar read/write in the app goes through here. It always reads
 * and writes the local IndexedDB mirror first — so the app works offline —
 * and opportunistically syncs with Google Calendar when the network is up.
 * Nothing calls `googleCalendar.ts` directly except this file and the sync
 * engine's push/pull loop. */

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

export async function createEvent(input: {
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string; displayName?: string }[]
}): Promise<CalendarEvent> {
  const record: LocalEvent = {
    localId: crypto.randomUUID(),
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    attendees: input.attendees,
    updatedAt: Date.now(),
    syncStatus: 'pending-create',
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
    updatedAt: Date.now(),
    syncStatus: existing.syncStatus === 'pending-create' ? 'pending-create' : 'pending-update',
  }
  await putLocalEvent(updated)
  if (isOnline()) void sync()
  return toPublicEvent(updated)
}

export async function deleteEvent(id: string): Promise<void> {
  const existing = await getLocalEventByAnyId(id)
  if (!existing) return
  if (existing.syncStatus === 'pending-create') {
    // Never reached Google — nothing to delete remotely.
    await deleteLocalEvent(existing.localId)
    return
  }
  await putLocalEvent({ ...existing, syncStatus: 'pending-delete', updatedAt: Date.now() })
  if (isOnline()) void sync()
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

// Re-exported so callers that genuinely need the raw Google shape (none, by
// design) don't have to reach into googleCalendar.ts directly.
export type { CalendarEvent as GoogleCalendarEvent } from './googleCalendar'
