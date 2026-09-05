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

// Raw Google Calendar REST calls. The rest of the app never calls these
// directly — go through `calendar/localCalendar.ts`, which mirrors
// everything to IndexedDB and queues changes made while offline.

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let token = getStoredAccessToken()
  if (!token) {
    try {
      token = await requestAccessToken(false)
    } catch {
      token = await requestAccessToken(true)
    }
  }

  const res = await fetch(`${CALENDAR_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (res.status === 401) {
    // Try a silent refresh first — only fall back to a visible consent
    // prompt if the browser's Google session itself is gone.
    try {
      token = await requestAccessToken(false)
    } catch {
      token = await requestAccessToken(true)
    }
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

export async function listUpcomingEvents(maxResults = 20): Promise<CalendarEvent[]> {
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
  if (!res.ok && res.status !== 410 && res.status !== 404) {
    throw new Error(`Failed to delete event: ${res.status}`)
  }
}
