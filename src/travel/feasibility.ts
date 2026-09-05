import { resolvePlace, type Place } from './places'
import { estimateTravel, type TravelEstimate } from './estimate'
import { getEnabledModes, TRAVEL_MODES } from '../settings/travelSettings'
import { isOnline } from '../calendar/syncEngine'

export interface FeasibilityReport {
  from: Place
  to: Place
  estimates: TravelEstimate[]
  best: TravelEstimate | null
  repeatVisit: boolean
  visitCount: number
  lastVisited?: string
}

const MODE_LABEL = Object.fromEntries(TRAVEL_MODES.map((m) => [m.mode, m.label.toLowerCase()]))

/** Checks how feasible it is to get from one place to another, restricted
 * to the transport modes enabled in settings, and notes whether the
 * destination is a repeat visit (from calendar history) so the estimate can
 * lean on what's already known about that trip. */
export async function checkFeasibility(fromQuery: string, toQuery: string): Promise<FeasibilityReport> {
  const [from, to] = await Promise.all([resolvePlace(fromQuery), resolvePlace(toQuery)])
  const modes = getEnabledModes()
  const online = isOnline()

  const estimates: TravelEstimate[] = []
  for (const mode of modes) {
    const estimate = await estimateTravel(mode, from, to, online)
    if (estimate) estimates.push(estimate)
  }
  estimates.sort((a, b) => a.minutes - b.minutes)

  return {
    from,
    to,
    estimates,
    best: estimates[0] ?? null,
    repeatVisit: to.visitCount > 0,
    visitCount: to.visitCount,
    lastVisited: to.lastVisited,
  }
}

/** Renders a feasibility report as a short, spoken-style summary for the
 * agent to read back — never raw JSON. */
export function summarizeFeasibility(report: FeasibilityReport): string {
  if (report.estimates.length === 0) {
    return `I can't work out travel times to ${report.to.label} right now — no routes available with your current transport settings.`
  }
  const best = report.estimates[0]
  const minutesText = Math.round(best.minutes)
  let line = `${MODE_LABEL[best.mode]} is quickest, about ${minutesText} min`
  if (report.estimates.length > 1) {
    const rest = report.estimates
      .slice(1)
      .map((e) => `${MODE_LABEL[e.mode]} ~${Math.round(e.minutes)} min`)
      .join(', ')
    line += ` (${rest})`
  }
  if (report.repeatVisit) {
    line += `. You've been to ${report.to.label} ${report.visitCount} time${report.visitCount === 1 ? '' : 's'} before`
  }
  return line + '.'
}
