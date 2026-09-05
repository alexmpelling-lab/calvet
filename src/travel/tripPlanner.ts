import { resolvePlace, type Place } from './places'
import { estimateTravel } from './estimate'
import { getEnabledModes } from '../settings/travelSettings'
import { isOnline } from '../calendar/syncEngine'

export interface TripLeg {
  from: string
  to: string
  mode: string
  minutes: number
  departISO: string
  arriveISO: string
}

export interface TripPlan {
  legs: TripLeg[]
  totalMinutes: number
  unreachable: string[]
}

/** Given a starting point, a departure time, and a list of stops, works out
 * a reasonable visiting order (nearest-unvisited-next — a simple greedy
 * heuristic, not a full route optimizer, but good enough for the handful of
 * errands a day realistically has) and the fastest enabled mode for each
 * leg, chained so each leg's arrival becomes the next leg's departure. */
export async function planTrip(startQuery: string, stopQueries: string[], departISO: string): Promise<TripPlan> {
  const modes = getEnabledModes()
  const online = isOnline()

  const start = await resolvePlace(startQuery)
  const stops = await Promise.all(stopQueries.map((q) => resolvePlace(q)))

  const remaining = [...stops]
  const legs: TripLeg[] = []
  const unreachable: string[] = []
  let current = start
  let clock = departISO

  while (remaining.length > 0) {
    let bestIndex = -1
    let bestMinutes = Infinity
    let bestMode = ''

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      for (const mode of modes) {
        const estimate = await estimateTravel(mode, current, candidate, online)
        if (estimate && estimate.minutes < bestMinutes) {
          bestMinutes = estimate.minutes
          bestIndex = i
          bestMode = mode
        }
      }
    }

    if (bestIndex === -1) {
      // Nothing reachable from here with the enabled modes — note the rest
      // as unreachable and stop, rather than silently dropping them.
      unreachable.push(...remaining.map((p) => p.label))
      break
    }

    const next = remaining.splice(bestIndex, 1)[0]
    const departTime = new Date(clock)
    const arriveTime = new Date(departTime.getTime() + bestMinutes * 60_000)
    legs.push({
      from: current.label,
      to: next.label,
      mode: bestMode,
      minutes: Math.round(bestMinutes),
      departISO: departTime.toISOString(),
      arriveISO: arriveTime.toISOString(),
    })
    current = next
    clock = arriveTime.toISOString()
  }

  return {
    legs,
    totalMinutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
    unreachable,
  }
}

export function summarizeTripPlan(plan: TripPlan): string {
  if (plan.legs.length === 0) {
    return "I couldn't work out a route between those stops with your current transport settings."
  }
  const order = plan.legs.map((leg) => leg.to).join(', then ')
  let text = `Best order: ${order}. That's about ${plan.totalMinutes} min of travel in total.`
  if (plan.unreachable.length > 0) {
    text += ` I couldn't find a way to reach ${plan.unreachable.join(', ')} with your current transport settings.`
  }
  return text
}

export type { Place }
