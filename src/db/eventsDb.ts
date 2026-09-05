import { getDb } from './db'

export type SyncStatus = 'synced' | 'pending-create' | 'pending-update' | 'pending-delete'

export interface LocalEvent {
  localId: string
  googleId?: string
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string; displayName?: string }[]
  updatedAt: number
  syncStatus: SyncStatus
  /** True only for events Calvet itself created. Anything pulled in from
   * Google (created elsewhere — Google Calendar directly, another app, an
   * invite) is false, and deleting it requires explicit confirmation. */
  createdByCalvet: boolean
  /** How much this event matters, for conflict resolution — a 'low'
   * priority, cancelable event is what Calvet offers to bump first when a
   * new event collides with it. Defaults to 'normal'/false when unset. */
  priority?: 'low' | 'normal' | 'high'
  cancelable?: boolean
}

const STORE = 'events'

export async function getAllLocalEvents(): Promise<LocalEvent[]> {
  const db = await getDb()
  return db.getAll(STORE)
}

export async function getLocalEventByAnyId(id: string): Promise<LocalEvent | undefined> {
  const db = await getDb()
  const byLocal = await db.get(STORE, id)
  if (byLocal) return byLocal
  return db.getFromIndex(STORE, 'googleId', id)
}

export async function putLocalEvent(event: LocalEvent): Promise<void> {
  const db = await getDb()
  await db.put(STORE, event)
}

export async function deleteLocalEvent(localId: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE, localId)
}

export async function getPendingEvents(): Promise<LocalEvent[]> {
  const all = await getAllLocalEvents()
  return all.filter((e) => e.syncStatus !== 'synced').sort((a, b) => a.updatedAt - b.updatedAt)
}
