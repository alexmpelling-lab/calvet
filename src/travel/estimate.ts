import { getDb } from '../db/db'
import type { TravelMode } from '../settings/travelSettings'
import type { Place } from './places'

export interface TravelEstimate {
  mode: TravelMode
  minutes: number
  distanceKm: number
  source: 'routed' | 'estimated'
}

interface TravelCacheEntry extends TravelEstimate {
  id: string
  fromPlaceId: string
  toPlaceId: string
  computedAt: number
}

const STORE = 'travelCache'
const ROUTED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days — real routing, roads don't move often
// A rough offline guess shouldn't get to squat on that same 30-day cache
// slot — once back online, a real routed result should replace it almost
// immediately rather than the app confidently repeating a straight-line
// guess for a month after connectivity was available again.
const ESTIMATED_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

// Rough urban average speeds, used when we can't reach a routing service.
// A 1.3x fudge factor over straight-line distance approximates real road/path
// distance reasonably well for short, everyday trips.
const AVG_SPEED_KMH: Record<TravelMode, number> = {
  driving: 32,
  cycling: 16,
  walking: 5,
  transit: 20,
}
const TRANSIT_WAIT_MINUTES = 8
const STRAIGHT_LINE_FUDGE = 1.3

const OSRM_PROFILE: Partial<Record<TravelMode, string>> = {
  driving: 'driving',
  cycling: 'cycling',
  walking: 'foot',
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function estimateOffline(mode: TravelMode, from: { lat: number; lng: number }, to: { lat: number; lng: number }): TravelEstimate {
  const distanceKm = haversineKm(from, to) * STRAIGHT_LINE_FUDGE
  const minutes = (distanceKm / AVG_SPEED_KMH[mode]) * 60 + (mode === 'transit' ? TRANSIT_WAIT_MINUTES : 0)
  return { mode, minutes, distanceKm, source: 'estimated' }
}

/** Real routing via the public OSRM demo server — free, no API key, driving/
 * cycling/walking only (no transit routing exists without a paid API).
 * Falls back to null on any failure so the caller can use the offline
 * estimate instead. */
async function routeViaOSRM(
  mode: TravelMode,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<TravelEstimate | null> {
  const profile = OSRM_PROFILE[mode]
  if (!profile) return null
  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const route = data.routes?.[0]
    if (!route) return null
    return { mode, minutes: route.duration / 60, distanceKm: route.distance / 1000, source: 'routed' }
  } catch {
    return null
  }
}

function cacheId(fromPlaceId: string, toPlaceId: string, mode: TravelMode): string {
  return `${fromPlaceId}|${toPlaceId}|${mode}`
}

async function getCached(fromPlaceId: string, toPlaceId: string, mode: TravelMode): Promise<TravelEstimate | null> {
  const db = await getDb()
  const entry: TravelCacheEntry | undefined = await db.get(STORE, cacheId(fromPlaceId, toPlaceId, mode))
  if (!entry) return null
  const ttl = entry.source === 'routed' ? ROUTED_CACHE_TTL_MS : ESTIMATED_CACHE_TTL_MS
  if (Date.now() - entry.computedAt > ttl) return null
  return entry
}

async function putCached(fromPlaceId: string, toPlaceId: string, estimate: TravelEstimate): Promise<void> {
  const db = await getDb()
  const entry: TravelCacheEntry = {
    id: cacheId(fromPlaceId, toPlaceId, estimate.mode),
    fromPlaceId,
    toPlaceId,
    ...estimate,
    computedAt: Date.now(),
  }
  await db.put(STORE, entry)
}

/** Estimates travel time for one mode between two geocoded places, using a
 * cached result when we have a recent one, real routing when online, and a
 * distance-based estimate otherwise. */
export async function estimateTravel(mode: TravelMode, from: Place, to: Place, online: boolean): Promise<TravelEstimate | null> {
  if (from.lat === undefined || from.lng === undefined || to.lat === undefined || to.lng === undefined) return null

  const cached = await getCached(from.id, to.id, mode)
  if (cached) return cached

  const fromCoord = { lat: from.lat, lng: from.lng }
  const toCoord = { lat: to.lat, lng: to.lng }

  let result: TravelEstimate | null = null
  if (online) result = await routeViaOSRM(mode, fromCoord, toCoord)
  if (!result) result = estimateOffline(mode, fromCoord, toCoord)

  await putCached(from.id, to.id, result)
  return result
}
