import { getDb } from '../db/db'
import { isOnline } from '../calendar/syncEngine'

export interface Place {
  id: string
  key: string
  label: string
  lat?: number
  lng?: number
  visitCount: number
  lastVisited?: string
  updatedAt: number
}

const STORE = 'places'

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function findExistingPlace(query: string): Promise<Place | undefined> {
  const db = await getDb()
  const key = normalizeKey(query)
  const exact = await db.getFromIndex(STORE, 'key', key)
  if (exact) return exact

  // Loose match for "Tate Modern" vs "Tate Modern, Bankside" — same place,
  // slightly different text each time it's mentioned.
  const all: Place[] = await db.getAll(STORE)
  return all.find((p) => p.key.includes(key) || key.includes(p.key))
}

/** Looks up a place by name/address, creating a bare (ungeocoded) local
 * record the first time it's seen. Never touches the network. */
export async function getOrCreatePlace(query: string): Promise<Place> {
  const existing = await findExistingPlace(query)
  if (existing) return existing
  const db = await getDb()
  const place: Place = {
    id: crypto.randomUUID(),
    key: normalizeKey(query),
    label: query.trim(),
    visitCount: 0,
    updatedAt: Date.now(),
  }
  await db.put(STORE, place)
  return place
}

async function savePlace(place: Place): Promise<void> {
  const db = await getDb()
  await db.put(STORE, place)
}

/** Geocodes a place via OpenStreetMap Nominatim (free, no API key) and
 * caches the coordinates locally. No-ops if already geocoded, or if
 * offline. This is the only network call in the travel feature besides the
 * routing lookup. */
export async function ensureGeocoded(place: Place): Promise<Place> {
  if (place.lat !== undefined && place.lng !== undefined) return place
  if (!isOnline()) return place

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place.label)}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return place
    const results = await res.json()
    const hit = results[0]
    if (!hit) return place
    const geocoded: Place = { ...place, lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), updatedAt: Date.now() }
    await savePlace(geocoded)
    return geocoded
  } catch {
    return place
  }
}

/** Resolves free text ("the office", "23 Bell Street") to a known place,
 * geocoding it if this is the first time and we're online. */
export async function resolvePlace(query: string): Promise<Place> {
  const place = await getOrCreatePlace(query)
  return ensureGeocoded(place)
}

/** Records that the user is visiting/has visited a place — called whenever
 * a calendar event with a location is created, so Calvet builds up a real
 * picture of repeat visits over time. */
export async function recordVisit(query: string, whenISO?: string): Promise<Place> {
  const place = await getOrCreatePlace(query)
  const updated: Place = {
    ...place,
    visitCount: place.visitCount + 1,
    lastVisited: whenISO ?? new Date().toISOString(),
    updatedAt: Date.now(),
  }
  await savePlace(updated)
  if (isOnline()) void ensureGeocoded(updated)
  return updated
}

export async function getAllPlaces(): Promise<Place[]> {
  const db = await getDb()
  return db.getAll(STORE)
}
