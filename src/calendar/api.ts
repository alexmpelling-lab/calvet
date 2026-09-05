import { getStoredAccessToken, requestAccessToken } from '../auth/google'

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'

export interface CalendarEvent {
  id?: string
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string; displayName?: string }[]
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let token = getStoredAccessToken()
  if (!token) token = await requestAccessToken(true)

  const res = await fetch(`${CALENDAR_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (res.status === 401) {
    token = await requestAccessToken(true)
    return fetch(`${CALENDAR_BASE}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
  }
  return res
}

export async function listUpcomingEvents(maxResults = 10): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  })
  const res = await authorizedFetch(`/calendars/primary/events?${params.toString()}`)
  if (!res.ok) throw new Error(`Failed to list events: ${res.status}`)
  const data = await res.json()
  return data.items ?? []
}

export async function createEvent(event: CalendarEvent): Promise<CalendarEvent> {
  const res = await authorizedFetch('/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`Failed to create event: ${res.status}`)
  return res.json()
}

export async function updateEvent(eventId: string, event: Partial<CalendarEvent>): Promise<CalendarEvent> {
  const res = await authorizedFetch(`/calendars/primary/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`Failed to update event: ${res.status}`)
  return res.json()
}

export async function deleteEvent(eventId: string): Promise<void> {
  const res = await authorizedFetch(`/calendars/primary/events/${eventId}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 410) throw new Error(`Failed to delete event: ${res.status}`)
}

export interface FreeBusySlot {
  start: string
  end: string
}

export async function findFreeSlots(windowStart: Date, windowEnd: Date): Promise<FreeBusySlot[]> {
  const res = await authorizedFetch('/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      items: [{ id: 'primary' }],
    }),
  })
  if (!res.ok) throw new Error(`Failed to check free/busy: ${res.status}`)
  const data = await res.json()
  const busy: FreeBusySlot[] = data.calendars?.primary?.busy ?? []

  // Derive free gaps between busy blocks within the window.
  const free: FreeBusySlot[] = []
  let cursor = windowStart
  for (const block of busy) {
    const busyStart = new Date(block.start)
    if (busyStart > cursor) {
      free.push({ start: cursor.toISOString(), end: busyStart.toISOString() })
    }
    const busyEnd = new Date(block.end)
    if (busyEnd > cursor) cursor = busyEnd
  }
  if (cursor < windowEnd) {
    free.push({ start: cursor.toISOString(), end: windowEnd.toISOString() })
  }
  return free
}
