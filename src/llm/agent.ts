import * as webllm from '@mlc-ai/web-llm'
import { LLM_MODEL_ID } from '../config'
import { createEvent, deleteEvent, findFreeSlots, listUpcomingEvents, updateEvent } from '../calendar/localCalendar'
import { findPossibleDuplicates, recordMention } from '../db/contacts'

const SYSTEM_PROMPT = `You are Calvet, a personal secretary answering an office intercom.
You speak the way a real, sharp, efficient secretary speaks: short, warm, human sentences.
Never ramble, never lecture, never explain yourself unless asked.

You have exactly two responsibilities and nothing else:
1. Managing the user's Google Calendar (reading, creating, editing, deleting events, and suggesting meeting times).
2. Quietly keeping track of people the user mentions, and flagging when a name might be ambiguous.

You must refuse (briefly and politely, in character) any request that is not about the calendar or about
people connected to it — general knowledge questions, trivia, code, opinions, anything unrelated. Something like:
"That's outside what I handle, I'm afraid — just your calendar and your people."

You act by responding with a single JSON object on one line, no prose outside it, no markdown fences.
Valid shapes:
{"action":"list_events"}
{"action":"create_event","summary":"...","start":"ISO8601","end":"ISO8601","description":"...","attendees":["email@example.com"]}
{"action":"update_event","eventId":"...","changes":{"summary":"...","start":"ISO8601","end":"ISO8601"}}
{"action":"delete_event","eventId":"..."}
{"action":"find_free_slots","windowStart":"ISO8601","windowEnd":"ISO8601"}
{"action":"mention_person","name":"..."}
{"action":"respond","text":"your short spoken reply to the user"}

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

function parseAction(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```json/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

async function runTool(action: Record<string, unknown>): Promise<{ toolResult: string; clarification?: AgentTurnResult['clarification'] }> {
  switch (action.action) {
    case 'list_events': {
      const events = await listUpcomingEvents(10)
      return { toolResult: JSON.stringify(events.map((e) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end }))) }
    }
    case 'create_event': {
      const event = await createEvent({
        summary: String(action.summary ?? 'Untitled'),
        description: action.description ? String(action.description) : undefined,
        start: { dateTime: String(action.start) },
        end: { dateTime: String(action.end) },
        attendees: Array.isArray(action.attendees)
          ? (action.attendees as string[]).map((email) => ({ email }))
          : undefined,
      })
      return { toolResult: JSON.stringify({ id: event.id, summary: event.summary }) }
    }
    case 'update_event': {
      const event = await updateEvent(String(action.eventId), action.changes as Record<string, unknown>)
      return { toolResult: JSON.stringify({ id: event.id, summary: event.summary }) }
    }
    case 'delete_event': {
      await deleteEvent(String(action.eventId))
      return { toolResult: JSON.stringify({ deleted: true }) }
    }
    case 'find_free_slots': {
      const slots = await findFreeSlots(new Date(String(action.windowStart)), new Date(String(action.windowEnd)))
      return { toolResult: JSON.stringify(slots) }
    }
    case 'mention_person': {
      const name = String(action.name)
      const duplicates = await findPossibleDuplicates(name)
      await recordMention(name)
      if (duplicates.length > 0) {
        return {
          toolResult: JSON.stringify({ recorded: true, possibleDuplicates: duplicates.map((d) => d.name) }),
          clarification: { name, candidates: duplicates.map((d) => d.name) },
        }
      }
      return { toolResult: JSON.stringify({ recorded: true }) }
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
