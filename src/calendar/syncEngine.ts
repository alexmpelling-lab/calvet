import * as google from './googleCalendar'
import {
  getAllLocalEvents,
  getLocalEventByAnyId,
  getPendingEvents,
  putLocalEvent,
  deleteLocalEvent,
  type LocalEvent,
} from '../db/eventsDb'
import { isSignedIn } from '../auth/google'

export type SyncStatus = 'signed-out' | 'offline' | 'syncing' | 'synced' | 'error'

let status: SyncStatus = 'signed-out'
const listeners = new Set<(status: SyncStatus) => void>()

function setStatus(next: SyncStatus) {
  status = next
  listeners.forEach((cb) => cb(status))
}

export function getSyncStatus(): SyncStatus {
  return status
}

export function onSyncStatusChange(cb: (status: SyncStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine
}

function toGoogleShape(e: LocalEvent): google.CalendarEvent {
  return {
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    attendees: e.attendees,
  }
}

/** Pushes one locally-queued change to Google. Throws on failure so the
 * caller can leave the record queued for a later retry. */
async function pushOne(record: LocalEvent): Promise<void> {
  if (record.syncStatus === 'pending-create') {
    const created = await google.createEvent(toGoogleShape(record))
    await putLocalEvent({ ...record, googleId: created.id, syncStatus: 'synced' })
    return
  }
  if (record.syncStatus === 'pending-update') {
    if (!record.googleId) {
      // Never actually reached the server yet — treat as a fresh create.
      const created = await google.createEvent(toGoogleShape(record))
      await putLocalEvent({ ...record, googleId: created.id, syncStatus: 'synced' })
      return
    }
    await google.updateEvent(record.googleId, toGoogleShape(record))
    await putLocalEvent({ ...record, syncStatus: 'synced' })
    return
  }
  if (record.syncStatus === 'pending-delete') {
    if (record.googleId) await google.deleteEvent(record.googleId)
    await deleteLocalEvent(record.localId)
  }
}

/** Pushes every queued local change, in the order they were made. A failure
 * on one record leaves it queued and continues with the rest. */
export async function pushPending(): Promise<{ pushed: number; failed: number }> {
  const pending = await getPendingEvents()
  let pushed = 0
  let failed = 0
  for (const record of pending) {
    try {
      await pushOne(record)
      pushed++
    } catch {
      failed++
    }
  }
  return { pushed, failed }
}

/** Pulls upcoming events from Google and merges them into the local mirror.
 * A record with a queued local change is left alone — it wins until it's
 * pushed, rather than being clobbered by a stale server copy. */
export async function pullFromGoogle(maxResults = 20): Promise<void> {
  const remoteEvents = await google.listUpcomingEvents(maxResults)
  for (const remote of remoteEvents) {
    if (!remote.id) continue
    const existing = await getLocalEventByAnyId(remote.id)
    if (existing && existing.syncStatus !== 'synced') continue
    await putLocalEvent({
      localId: existing?.localId ?? crypto.randomUUID(),
      googleId: remote.id,
      summary: remote.summary,
      description: remote.description,
      location: remote.location,
      start: remote.start,
      end: remote.end,
      attendees: remote.attendees,
      updatedAt: Date.now(),
      syncStatus: 'synced',
    })
  }
}

let syncInFlight: Promise<void> | null = null

/** Runs a full sync (push then pull) if online; no-ops offline. Safe to call
 * repeatedly — concurrent calls share one in-flight sync. */
export async function sync(): Promise<void> {
  if (!isSignedIn()) {
    setStatus('signed-out')
    return
  }
  if (!isOnline()) {
    setStatus('offline')
    return
  }
  if (syncInFlight) return syncInFlight

  setStatus('syncing')
  syncInFlight = (async () => {
    try {
      const { failed } = await pushPending()
      await pullFromGoogle()
      setStatus(failed > 0 ? 'error' : 'synced')
    } catch {
      setStatus(isOnline() ? 'error' : 'offline')
    } finally {
      syncInFlight = null
    }
  })()
  return syncInFlight
}

let initialized = false

/** Wires up online/offline listeners and kicks off an initial sync. Call
 * once, after sign-in, from app startup. */
export function initSyncEngine(): void {
  if (initialized) return
  initialized = true
  window.addEventListener('online', () => void sync())
  window.addEventListener('offline', () => setStatus('offline'))
  void sync()
}

export async function hasUnsyncedChanges(): Promise<boolean> {
  const all = await getAllLocalEvents()
  return all.some((e) => e.syncStatus !== 'synced')
}
