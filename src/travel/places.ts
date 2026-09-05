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
  /** When set, this record is just an alias — resolving it always redirects
   * to the canonical place with this id, so "the gym" and "Pure Gym, Baker
   * Street" end up sharing one visit history instead of splitting it. */
  aliasFor?: string
}

const STORE = 'places'

// Below this length, substring containment matching produces nonsense —
// "home" would "match" a business literally named "Home Depot", merging two
// completely unrelated places into one record.
const MIN_FUZZY_KEY_LENGTH = 5

// Generic labels that don't identify a specific place on their own. Geocoding
// one of these confidently returns *some* real business or landmark
// somewhere with that name — a plausible-looking but almost certainly wrong
// answer, which is worse than honestly saying "I don't know where that is."
const VAGUE_LABELS = new Set([
  'home',
  'work',
  'office',
  'the office',
  'here',
  'there',
  'school',
  'the gym',
  'gym',
])

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function findExistingPlace(query: string): Promise<Place | undefined> {
  const db = await getDb()
  const key = normalizeKey(query)
  const exact = await db.getFromIndex(STORE, 'key', key)
  if (exact) return exact

  if (key.length < MIN_FUZZY_KEY_LENGTH) return undefined

  // Loose match for "Tate Modern" vs "Tate Modern, Bankside" — same place,
  // slightly different text each time it's mentioned.
  const all: Place[] = await db.getAll(STORE)
  return all.find((p) => p.key.length >= MIN_FUZZY_KEY_LENGTH && (p.key.includes(key) || key.includes(p.key)))
}

// getOrCreatePlace does a read-then-write with no database transaction
// spanning both steps, so two concurrent calls for the same brand-new
// location (e.g. a create_event and its background travel-buffer check
// firing at nearly the same time) could both miss the not-yet-committed
// record and each create their own — silently splitting one place's visit
// history across two rows. A per-key in-flight lock serializes concurrent
// callers onto the same creation instead.
const creationLocks = new Map<string, Promise<Place>>()

/** Looks up a place by name/address, creating a bare (ungeocoded) local
 * record the first time it's seen. Never touches the network. */
export async function getOrCreatePlace(query: string): Promise<Place> {
  const key = normalizeKey(query)
  const inFlight = creationLocks.get(key)
  if (inFlight) return inFlight

  const task = (async () => {
    try {
      const existing = await findExistingPlace(query)
      if (existing) return existing
      const db = await getDb()
      const place: Place = {
        id: crypto.randomUUID(),
        key,
        label: query.trim(),
        visitCount: 0,
        updatedAt: Date.now(),
      }
      await db.put(STORE, place)
      return place
    } finally {
      creationLocks.delete(key)
    }
  })()
  creationLocks.set(key, task)
  return task
}

async function savePlace(place: Place): Promise<void> {
  const db = await getDb()
  await db.put(STORE, place)
}

// Nominatim's usage policy caps unauthenticated use at ~1 request/second —
// two lookups fired close together (e.g. checking a "from" and "to" place at
// once) could otherwise breach that and risk a temporary block. This queues
// geocode calls so they're always spaced out.
let nominatimQueue: Promise<void> = Promise.resolve()
const NOMINATIM_MIN_INTERVAL_MS = 1100

function throttledNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimQueue.then(fn)
  nominatimQueue = run.then(
    () => new Promise((resolve) => setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS)),
    () => new Promise((resolve) => setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS))
  )
  return run
}

/** Geocodes a place via OpenStreetMap Nominatim (free, no API key) and
 * caches the coordinates locally. No-ops if already geocoded, offline, or
 * the label is too generic to safely geocode (see VAGUE_LABELS) — leaving
 * it ungeocoded so a feasibility check can honestly say it doesn't know
 * where that is, rather than confidently reporting travel times to a
 * random same-named business somewhere else in the world. */
export async function ensureGeocoded(place: Place): Promise<Place> {
  if (place.lat !== undefined && place.lng !== undefined) return place
  if (!isOnline()) return place
  if (VAGUE_LABELS.has(place.key)) return place

  try {
    const geocoded = await throttledNominatim(async () => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place.label)}`
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const results = await res.json()
      const hit = results[0]
      if (!hit) return null
      return { ...place, lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), updatedAt: Date.now() } as Place
    })
    if (!geocoded) return place
    await savePlace(geocoded)
    return geocoded
  } catch {
    return place
  }
}

async function followAlias(place: Place): Promise<Place> {
  if (!place.aliasFor) return place
  const db = await getDb()
  const canonical: Place | undefined = await db.get(STORE, place.aliasFor)
  return canonical ?? place
}

/** Resolves free text ("the office", "23 Bell Street") to a known place,
 * geocoding it if this is the first time and we're online, and following
 * any alias to its canonical place. */
export async function resolvePlace(query: string): Promise<Place> {
  const place = await followAlias(await getOrCreatePlace(query))
  return ensureGeocoded(place)
}

/** Records that the user is visiting/has visited a place — called whenever
 * a calendar event with a location is created, so Calvet builds up a real
 * picture of repeat visits over time. Follows an alias first, so visits
 * under a vague label ("the gym") accumulate on the one real place it's
 * been pointed at instead of splitting the history. */
export async function recordVisit(query: string, whenISO?: string): Promise<Place> {
  const place = await followAlias(await getOrCreatePlace(query))
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

/** Explicitly teaches Calvet what a vague label actually means ("the gym"
 * → "Pure Gym, 12 Baker Street") — geocodes the real address as the
 * canonical place, then points the vague label's record at it so every
 * future mention of the vague label resolves and accumulates visits there
 * instead of being silently skipped (see VAGUE_LABELS) or split apart. */
export async function setPlaceAlias(alias: string, actualAddress: string): Promise<Place> {
  const canonical = await ensureGeocoded(await getOrCreatePlace(actualAddress))
  const aliasPlace = await getOrCreatePlace(alias)
  const updatedAlias: Place = { ...aliasPlace, aliasFor: canonical.id, updatedAt: Date.now() }
  await savePlace(updatedAlias)
  return canonical
}

export async function getAllPlaces(): Promise<Place[]> {
  const db = await getDb()
  return db.getAll(STORE)
}
