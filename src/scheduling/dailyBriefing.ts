import { listUpcomingEvents, type CalendarEvent } from '../calendar/localCalendar'
import { suggestTravelBuffer } from '../travel/travelBuffer'
import { checkDayDensity } from './density'

function isToday(dateISO: string): boolean {
  return new Date(dateISO).toDateString() === new Date().toDateString()
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export interface DailyBriefing {
  events: CalendarEvent[]
  tightGaps: string[]
  dense: boolean
}

/** Pulls together the pieces of a "what does today look like" answer: the
 * agenda, any tight back-to-back travel gaps, and whether the day is
 * stacked enough to be worth a heads-up — composed here so the agent can
 * read this off in one pass instead of chaining several separate tool
 * calls itself. */
export async function buildDailyBriefing(): Promise<DailyBriefing> {
  const upcoming = await listUpcomingEvents(30)
  const events = upcoming.filter((e) => isToday(e.start.dateTime))

  const tightGaps: string[] = []
  for (let i = 0; i < events.length - 1; i++) {
    if (!events[i].location) continue
    const suggestion = await suggestTravelBuffer(events[i])
    if (suggestion) tightGaps.push(suggestion.text)
  }

  const density = events.length > 0 ? await checkDayDensity(events[0].start.dateTime) : { dense: false }

  return { events, tightGaps, dense: density.dense }
}

export function summarizeDailyBriefing(briefing: DailyBriefing): string {
  if (briefing.events.length === 0) return "Your day's clear."
  const agenda = briefing.events.map((e) => `${formatTime(e.start.dateTime)} ${e.summary}`).join(', ')
  let text = `Today: ${agenda}.`
  if (briefing.dense) text += ' It\'s a stacked day — worth pacing yourself.'
  if (briefing.tightGaps.length > 0) text += ' ' + briefing.tightGaps.join(' ')
  return text
}
