import * as webllm from '@mlc-ai/web-llm'
import { LLM_MODEL_ID } from '../config'
import { createEvent, deleteEvent, findFreeSlots, listUpcomingEvents, updateEvent } from '../calendar/localCalendar'
import { findPossibleDuplicates, recordMention } from '../db/contacts'
import { recordVisit } from '../travel/places'
import { checkFeasibility, summarizeFeasibility } from '../travel/feasibility'
import { suggestTravelBuffer } from '../travel/travelBuffer'
import { getTravelSettings, parseTravelModePhrase, setModeEnabled, TRAVEL_MODES } from '../settings/travelSettings'

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
{"action":"create_event","summary":"...","start":"ISO8601","end":"ISO8601","description":"...","location":"...","attendees":["email@example.com"]}
{"action":"update_event","eventId":"...","changes":{"summary":"...","start":"ISO8601","end":"ISO8601"}}
{"action":"delete_event","eventId":"...","confirmed":false}
{"action":"find_free_slots","windowStart":"ISO8601","windowEnd":"ISO8601"}
{"action":"mention_person","name":"..."}
{"action":"check_travel","from":"place name or address","to":"place name or address"}
{"action":"update_travel_settings","mode":"driving|cycling|walking|transit","enabled":true}
{"action":"get_travel_settings"}
{"action":"respond","text":"your short spoken reply to the user"}

For check_travel, if the user hasn't said where they're starting from, use "respond" to ask rather than guessing.
For update_travel_settings, infer mode and enabled from phrases like "I don't drive" (driving, false) or
"I cycle everywhere" (cycling, true).

delete_event only actually deletes when the event was created by Calvet itself, or when you pass
"confirmed":true. If the tool result comes back with status "needs-confirmation", that means this event was
already on the calendar (added elsewhere — Google Calendar directly, an invite, another app), and you must
ask the user to confirm before calling delete_event again with "confirmed":true. Never set confirmed:true
unless the user has explicitly agreed in this conversation.

If a create_event or update_event tool result includes a "travelSuggestion", relay its "text" to the user
in your respond text, verbatim or close to it. If, in a later turn, the user agrees to add that travel block,
call create_event using exactly the fields under that suggestion's "suggestedEvent".

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
      const event = await createEvent({
        summary,
        description: action.description ? String(action.description) : undefined,
        location,
        start: { dateTime: String(action.start) },
        end: { dateTime: String(action.end) },
        attendees: Array.isArray(action.attendees)
          ? (action.attendees as string[]).map((email) => ({ email }))
          : undefined,
      })
      // Build up place memory in the background — never blocks the reply.
      if (location) void recordVisit(location, event.start.dateTime)

      const isTravelBlock = summary.startsWith(TRAVEL_BLOCK_PREFIX)
      const travelSuggestion = location && !isTravelBlock ? await suggestTravelBuffer(event) : null
      return {
        toolResult: JSON.stringify({
          id: event.id,
          summary: event.summary,
          ...(travelSuggestion ? { travelSuggestion } : {}),
        }),
      }
    }
    case 'update_event': {
      const changes = (action.changes ?? {}) as Record<string, unknown>
      if (changes.start !== undefined || changes.end !== undefined) {
        const timeError = validateEventTimes(changes.start, changes.end)
        if (timeError) return { toolResult: JSON.stringify({ error: timeError }) }
      }
      const event = await updateEvent(String(action.eventId), changes)
      const isTravelBlock = event.summary.startsWith(TRAVEL_BLOCK_PREFIX)
      const travelSuggestion = event.location && !isTravelBlock ? await suggestTravelBuffer(event) : null
      return {
        toolResult: JSON.stringify({
          id: event.id,
          summary: event.summary,
          ...(travelSuggestion ? { travelSuggestion } : {}),
        }),
      }
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
    default:
      return { toolResult: JSON.stringify({ error: 'unknown action' }) }
  }
}

/** Runs the tool-calling loop for one user turn and returns the final spoken reply. */
export async function runAgentTurn(history: AgentMessage[], userText: string): Promise<AgentTurnResult> {
  const engine = await loadEngine()
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
