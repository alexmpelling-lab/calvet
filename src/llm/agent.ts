import * as webllm from '@mlc-ai/web-llm'
import { LLM_MODEL_ID } from '../config'
import {
  createEvent,
  deleteEvent,
  findFreeSlots,
  getEventById,
  listUpcomingEvents,
  updateEvent,
  type CalendarEvent,
} from '../calendar/localCalendar'
import { findMentionedContact, findPossibleDuplicates, getLatenessPadding, recordLatenessSample, recordMention } from '../db/contacts'
import { recordVisit, setPlaceAlias } from '../travel/places'
import { checkFeasibility, summarizeFeasibility } from '../travel/feasibility'
import { suggestTravelBuffer } from '../travel/travelBuffer'
import { getTravelSettings, parseTravelModePhrase, setModeEnabled, TRAVEL_MODES } from '../settings/travelSettings'
import { checkForConflicts } from '../scheduling/conflicts'
import { checkDayDensity } from '../scheduling/density'
import { inferTypicalDuration } from '../scheduling/durationInference'
import { applyCascadeShift, suggestCascadeShift, type CascadeShift } from '../scheduling/cascade'
import { buildDailyBriefing, summarizeDailyBriefing } from '../scheduling/dailyBriefing'
import { planTrip, summarizeTripPlan } from '../travel/tripPlanner'

const SYSTEM_PROMPT = `You are Calvet, a personal secretary answering an office intercom.
You speak the way a real, sharp, efficient secretary speaks: short, warm, human sentences.
Never ramble, never lecture, never explain yourself unless asked.

You have exactly three responsibilities and nothing else:
1. Managing the user's Google Calendar (reading, creating, editing, deleting events, and suggesting meeting times).
2. Quietly keeping track of people the user mentions, and flagging when a name might be ambiguous.
3. Working out how feasible it is to get between places for the user's trips, restricted to the transport
   modes they've told you they use, and letting them change those transport settings by asking you.

You must refuse (briefly and politely, in character) any request that is not about the calendar, the people
connected to it, or getting between places — general knowledge questions, trivia, code, opinions, anything
unrelated. Something like: "That's outside what I handle, I'm afraid — just your calendar, your people, and getting around."

You act by responding with a single JSON object on one line, no prose outside it, no markdown fences.
Valid shapes:
{"action":"list_events"}
{"action":"create_event","summary":"...","start":"ISO8601","end":"ISO8601","description":"...","location":"...","attendees":["email@example.com"],"priority":"low|normal|high","cancelable":false,"allowConflict":false}
{"action":"update_event","eventId":"...","changes":{"summary":"...","start":"ISO8601","end":"ISO8601"}}
{"action":"delete_event","eventId":"...","confirmed":false}
{"action":"find_free_slots","windowStart":"ISO8601","windowEnd":"ISO8601"}
{"action":"mention_person","name":"..."}
{"action":"check_travel","from":"place name or address","to":"place name or address"}
{"action":"update_travel_settings","mode":"driving|cycling|walking|transit","enabled":true}
{"action":"get_travel_settings"}
{"action":"get_daily_briefing"}
{"action":"plan_trip","start":"place name or address","stops":["place 1","place 2"],"departTime":"ISO8601"}
{"action":"set_place_alias","alias":"the gym","address":"full address of what that actually means"}
{"action":"apply_cascade_shift","shifts":[...]}
{"action":"respond","text":"your short spoken reply to the user"}

For check_travel, if the user hasn't said where they're starting from, use "respond" to ask rather than guessing.
For update_travel_settings, infer mode and enabled from phrases like "I don't drive" (driving, false) or
"I cycle everywhere" (cycling, true).

get_daily_briefing is for "what's my day look like", "brief me", "good morning" type requests — it gives you
the agenda plus any tight travel gaps already worked out, so just relay its text.

create_event takes optional "priority" ('low'/'normal'/'high') and "cancelable" (true/false) — set these only
when the user says something implying it, like "pencil this in loosely" (cancelable: true) or "this is important"
(priority: high). Otherwise omit them.

If create_event's tool result comes back with "conflict": true, do NOT create the event — it collided with
something already on the calendar. The result includes "conflicts" (what it collided with), and may include
"bumpCandidate" (a lower-priority conflicting event you could offer to move instead) and "nearestFreeSlot" (an
alternative time of the same length). Ask the user which they'd prefer, then either call create_event again
with "allowConflict":true to double-book anyway, with the nearestFreeSlot's times instead, or first move the
bumpCandidate (update_event or delete_event on it) before creating the new one.

If a create_event tool result includes "durationHint", it means past events like this one typically ran a
different length — mention it briefly only if the difference is large, otherwise ignore it.

If a create_event tool result includes "densityNote", the day is already heavily booked — mention it briefly.

If a create_event tool result includes "latenessNote", someone in this event has a track record of running
late — mention it briefly as a heads-up, not as a criticism.

If a create_event or update_event tool result includes a "travelSuggestion", relay its "text" to the user
in your respond text, verbatim or close to it. If, in a later turn, the user agrees to add that travel block,
call create_event using exactly the fields under that suggestion's "suggestedEvent".

If an update_event tool result includes a "cascadeSuggestion", relay its "text". If the user agrees, call
apply_cascade_shift with exactly the "shifts" array from that suggestion.

delete_event only actually deletes when the event was created by Calvet itself, or when you pass
"confirmed":true. If the tool result comes back with status "needs-confirmation", that means this event was
already on the calendar (added elsewhere — Google Calendar directly, an invite, another app), and you must
ask the user to confirm before calling delete_event again with "confirmed":true. Never set confirmed:true
unless the user has explicitly agreed in this conversation.

If a tool result comes back with an "error" field, do not retry the same action the same way — briefly explain
in character what's needed instead (e.g. a clearer time, or trying again in a moment), the way a secretary
would smooth over a small hiccup rather than repeating a technical message.

Always end a turn with a "respond" action once you have what you need to answer the user.
If a tool result is given to you, use it to compose the final "respond" text — do not repeat raw data verbatim,
summarize it the way a secretary would.`

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface AgentTurnResult {
  reply: string
  clarification?: { name: string; candidates: string[] }
}

type Engine = webllm.MLCEngineInterface

let enginePromise: Promise<Engine> | null = null

export function loadEngine(onProgress?: (report: webllm.InitProgressReport) => void): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = webllm.CreateMLCEngine(LLM_MODEL_ID, {
      initProgressCallback: onProgress,
    })
  }
  return enginePromise
}

/** Finds the `}` that actually matches the first `{`, tracking brace depth
 * and skipping over braces inside string literals. A small model sometimes
 * wraps its JSON in a little chatty prose ("Sure! {...} Let me know!") —
 * blindly taking the *last* `}` in the whole string (the old approach) grabs
 * a brace from that trailing text instead of the object's real end, which
 * fails to parse (or worse, silently parses a corrupted superset). */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseAction(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```json/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  if (start === -1) return null
  const end = findMatchingBrace(trimmed, start)
  if (end === -1) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

function isValidDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

/** Validates the start/end pair the model produced for an event before it
 * ever reaches the local mirror or Google — an unparseable or backwards
 * time range previously got queued anyway, synced-and-failed silently
 * forever, and left the sync status permanently red with no indication of
 * which event or why. */
function validateEventTimes(start: unknown, end: unknown): string | null {
  if (!isValidDateTime(start) || !isValidDateTime(end)) {
    return "Sorry, I didn't get a clear time for that — could you give me a specific date and time?"
  }
  if (new Date(start).getTime() >= new Date(end).getTime()) {
    return "That end time is before the start — could you double check the times?"
  }
  return null
}

// Tags a suggested travel block so a later create_event for it never
// re-triggers suggestTravelBuffer against its own nonsense "A → B" location —
// without this, confirming one suggestion could immediately spawn another,
// nonsensical one comparing the travel block against its own neighbors.
const TRAVEL_BLOCK_PREFIX = 'Travel to '

function isValidPriority(value: unknown): value is 'low' | 'normal' | 'high' {
  return value === 'low' || value === 'normal' || value === 'high'
}

/** Runs one tool call. Never throws — any failure (a network error mid
 * geocode, an event id that no longer exists, a malformed action) is turned
 * into a small error result the model can read and apologize for in
 * character, instead of the whole turn crashing with a raw stack-trace-ish
 * message shown straight to the user in the chat log. */
async function runTool(action: Record<string, unknown>): Promise<{ toolResult: string; clarification?: AgentTurnResult['clarification'] }> {
  try {
    return await runToolUnsafe(action)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong with that.'
    return { toolResult: JSON.stringify({ error: message }) }
  }
}

async function runToolUnsafe(action: Record<string, unknown>): Promise<{ toolResult: string; clarification?: AgentTurnResult['clarification'] }> {
  switch (action.action) {
    case 'list_events': {
      const events = await listUpcomingEvents(10)
      return { toolResult: JSON.stringify(events.map((e) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end }))) }
    }
    case 'create_event': {
      const timeError = validateEventTimes(action.start, action.end)
      if (timeError) return { toolResult: JSON.stringify({ error: timeError }) }

      const summary = String(action.summary ?? 'Untitled')
      const location = action.location ? String(action.location) : undefined
      const start = new Date(String(action.start))
      const end = new Date(String(action.end))
      const isTravelBlock = summary.startsWith(TRAVEL_BLOCK_PREFIX)

      if (!action.allowConflict && !isTravelBlock) {
        const conflictReport = await checkForConflicts(start, end)
        if (conflictReport.conflicts.length > 0) {
          return {
            toolResult: JSON.stringify({
              conflict: true,
              conflicts: conflictReport.conflicts.map((c) => ({ id: c.id, summary: c.summary, start: c.start, end: c.end })),
              bumpCandidate: conflictReport.bumpCandidate
                ? { id: conflictReport.bumpCandidate.id, summary: conflictReport.bumpCandidate.summary }
                : undefined,
              nearestFreeSlot: conflictReport.nearestFreeSlot,
            }),
          }
        }
      }

      const event = await createEvent({
        summary,
        description: action.description ? String(action.description) : undefined,
        location,
        start: { dateTime: String(action.start) },
        end: { dateTime: String(action.end) },
        attendees: Array.isArray(action.attendees)
          ? (action.attendees as string[]).map((email) => ({ email }))
          : undefined,
        priority: isValidPriority(action.priority) ? action.priority : undefined,
        cancelable: typeof action.cancelable === 'boolean' ? action.cancelable : undefined,
      })
      // Build up place memory in the background — never blocks the reply.
      if (location) void recordVisit(location, event.start.dateTime)

      const extras: Record<string, unknown> = {}

      if (!isTravelBlock) {
        const requestedMinutes = (end.getTime() - start.getTime()) / 60_000
        const inference = await inferTypicalDuration(summary)
        if (inference && Math.abs(inference.typicalMinutes - requestedMinutes) >= 15) {
          extras.durationHint = `Similar events have typically run about ${inference.typicalMinutes} min (based on ${inference.sampleSize} past ones), this one's set for ${Math.round(requestedMinutes)}.`
        }

        const density = await checkDayDensity(event.start.dateTime)
        if (density.dense) {
          extras.densityNote = `That's ${density.count} things on the calendar that day already.`
        }

        const mentionedContact = await findMentionedContact(summary)
        if (mentionedContact) {
          const padding = await getLatenessPadding(mentionedContact.name)
          if (padding && padding >= 10) {
            extras.latenessNote = `${mentionedContact.name} has tended to run about ${padding} min late to things.`
          }
        }

        const travelSuggestion = location ? await suggestTravelBuffer(event) : null
        if (travelSuggestion) extras.travelSuggestion = travelSuggestion
      }

      return { toolResult: JSON.stringify({ id: event.id, summary: event.summary, ...extras }) }
    }
    case 'update_event': {
      const changes = (action.changes ?? {}) as Record<string, unknown>
      if (changes.start !== undefined || changes.end !== undefined) {
        const timeError = validateEventTimes(changes.start, changes.end)
        if (timeError) return { toolResult: JSON.stringify({ error: timeError }) }
      }

      const eventId = String(action.eventId)
      const before = await getEventById(eventId)
      const event = await updateEvent(eventId, changes)
      const isTravelBlock = event.summary.startsWith(TRAVEL_BLOCK_PREFIX)

      const extras: Record<string, unknown> = {}

      if (before && typeof changes.start === 'string' && changes.start !== before.start.dateTime) {
        // A same-day reschedule that moves things later reads as "this
        // person/event tends to run late" — feed that into lateness memory.
        const deltaMinutes = (new Date(changes.start).getTime() - new Date(before.start.dateTime).getTime()) / 60_000
        const mentionedContact = await findMentionedContact(event.summary)
        if (mentionedContact) void recordLatenessSample(mentionedContact.name, deltaMinutes)

        const cascadeSuggestion = await suggestCascadeShift(eventId, before.start.dateTime, changes.start)
        if (cascadeSuggestion) extras.cascadeSuggestion = cascadeSuggestion
      }

      if (!isTravelBlock) {
        const travelSuggestion = event.location ? await suggestTravelBuffer(event) : null
        if (travelSuggestion) extras.travelSuggestion = travelSuggestion
      }

      return { toolResult: JSON.stringify({ id: event.id, summary: event.summary, ...extras }) }
    }
    case 'apply_cascade_shift': {
      const shifts = Array.isArray(action.shifts) ? (action.shifts as CascadeShift[]) : []
      if (shifts.length === 0) return { toolResult: JSON.stringify({ error: 'no shifts provided' }) }
      const updated = await applyCascadeShift(shifts)
      return { toolResult: JSON.stringify({ shifted: updated.map((e) => ({ id: e.id, summary: e.summary, start: e.start })) }) }
    }
    case 'delete_event': {
      const result = await deleteEvent(String(action.eventId), Boolean(action.confirmed))
      return { toolResult: JSON.stringify(result) }
    }
    case 'find_free_slots': {
      const timeError = validateEventTimes(action.windowStart, action.windowEnd)
      if (timeError) return { toolResult: JSON.stringify({ error: timeError }) }
      const slots = await findFreeSlots(new Date(String(action.windowStart)), new Date(String(action.windowEnd)))
      return { toolResult: JSON.stringify(slots) }
    }
    case 'mention_person': {
      const name = String(action.name)
      // Order matters: recordMention may silently consolidate a first-name
      // mention ("Jon") into an existing fuller-name contact ("Jon Smith").
      // Computing duplicates afterward and excluding that same contact
      // stops it from being flagged as its own "possible duplicate" on
      // every future mention once it's already the same record.
      const contact = await recordMention(name)
      const duplicates = (await findPossibleDuplicates(name)).filter((d) => d.id !== contact.id)
      if (duplicates.length > 0) {
        return {
          toolResult: JSON.stringify({ recorded: true, possibleDuplicates: duplicates.map((d) => d.name) }),
          clarification: { name, candidates: duplicates.map((d) => d.name) },
        }
      }
      return { toolResult: JSON.stringify({ recorded: true }) }
    }
    case 'check_travel': {
      const report = await checkFeasibility(String(action.from), String(action.to))
      return { toolResult: summarizeFeasibility(report) }
    }
    case 'update_travel_settings': {
      let mode = action.mode as string | undefined
      let enabled = action.enabled as boolean | undefined
      if (!mode || enabled === undefined) {
        const parsed = parseTravelModePhrase(String(action.mode ?? ''))
        if (parsed) {
          mode = parsed.mode
          enabled = parsed.enabled
        }
      }
      if (!mode) return { toolResult: JSON.stringify({ error: 'no mode recognized' }) }
      setModeEnabled(mode as Parameters<typeof setModeEnabled>[0], Boolean(enabled))
      return { toolResult: JSON.stringify({ mode, enabled: Boolean(enabled) }) }
    }
    case 'get_travel_settings': {
      const settings = getTravelSettings()
      const enabled = TRAVEL_MODES.filter((m) => settings[m.mode]).map((m) => m.label)
      return { toolResult: JSON.stringify({ enabled }) }
    }
    case 'get_daily_briefing': {
      const briefing = await buildDailyBriefing()
      return { toolResult: summarizeDailyBriefing(briefing) }
    }
    case 'plan_trip': {
      const stops = Array.isArray(action.stops) ? (action.stops as string[]).map(String) : []
      if (stops.length === 0) return { toolResult: JSON.stringify({ error: 'no stops given' }) }
      const departTime = isValidDateTime(action.departTime) ? String(action.departTime) : new Date().toISOString()
      const plan = await planTrip(String(action.start), stops, departTime)
      return { toolResult: summarizeTripPlan(plan) }
    }
    case 'set_place_alias': {
      const alias = String(action.alias ?? '')
      const address = String(action.address ?? '')
      if (!alias || !address) return { toolResult: JSON.stringify({ error: 'need both an alias and an address' }) }
      const canonical = await setPlaceAlias(alias, address)
      return { toolResult: JSON.stringify({ alias, resolvedTo: canonical.label }) }
    }
    default:
      return { toolResult: JSON.stringify({ error: 'unknown action' }) }
  }
}

/** Runs the tool-calling loop for one user turn and returns the final spoken reply. */
export async function runAgentTurn(
  history: AgentMessage[],
  userText: string,
  onModelProgress?: (fraction: number) => void
): Promise<AgentTurnResult> {
  const engine = await loadEngine((report) => {
    // report.progress is 0-1 across the whole load (weight download +
    // compile); showing it is the difference between "Warming up…" sitting
    // static for several minutes on a ~1.7GB first-time download and an
    // actual number that proves something is happening.
    onModelProgress?.(report.progress)
  })
  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText },
  ]

  let clarification: AgentTurnResult['clarification']

  for (let step = 0; step < 4; step++) {
    const completion = await engine.chat.completions.create({
      messages: messages as webllm.ChatCompletionMessageParam[],
      temperature: 0.4,
      max_tokens: 200,
    })
    const raw = completion.choices[0]?.message?.content ?? ''
    const action = parseAction(raw)

    if (!action || action.action === 'respond') {
      const text = action && typeof action.text === 'string' ? action.text : raw.trim()
      return { reply: text || "Sorry, could you say that again?", clarification }
    }

    messages.push({ role: 'assistant', content: JSON.stringify(action) })
    const { toolResult, clarification: newClarification } = await runTool(action)
    if (newClarification) clarification = newClarification
    messages.push({ role: 'tool', content: toolResult })
  }

  return { reply: "I'm having trouble with that one — could you try again?", clarification }
}

export type { CalendarEvent }
