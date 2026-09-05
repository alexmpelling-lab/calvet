import { getStoredAccessToken, requestAccessToken } from '../auth/google'

/** Thrown when the app can't get a usable Google token without popping an
 * interactive consent prompt — which must never happen from a background
 * sync (no user gesture behind it, so most browsers just block the popup,
 * or it appears out of nowhere with no click to explain it). Callers that
 * run outside a real user gesture should let this surface as a "needs
 * reconnect" state rather than attempting an interactive prompt. */
export class AuthExpiredError extends Error {
  constructor() {
    super('Your Google session needs reconnecting.')
    this.name = 'AuthExpiredError'
  }
}

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

/** Gets a token without ever popping an interactive consent prompt. Every
 * call in this file goes through here, whether it originated from a user's
 * button press or a background sync — an OAuth popup with no click behind
 * it just gets blocked by the browser or appears with no context, so the
 * only two outcomes here are "silent refresh worked" or a clear
 * AuthExpiredError the caller can turn into a "reconnect" prompt. */
async function getTokenSilently(): Promise<string> {
  const cached = getStoredAccessToken()
  if (cached) return cached
  try {
    return await requestAccessToken(false)
  } catch {
    throw new AuthExpiredError()
  }
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let token = await getTokenSilently()

  const res = await fetch(`${CALENDAR_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (res.status === 401) {
    token = await getTokenSilently()
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
