// Public OAuth client ID (not a secret — Google client IDs are meant to ship in
// client-side code). Registered with http://localhost:5173 as an authorized
// origin, so the app works out of the box when run locally on that port.
// Override via VITE_GOOGLE_CLIENT_ID if you register your own client for a
// different origin (e.g. a deployed domain).
const DEFAULT_GOOGLE_CLIENT_ID = '37250021145-stngnguragpikikpia19c422j726oac0.apps.googleusercontent.com'

export const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || DEFAULT_GOOGLE_CLIENT_ID

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

export const LLM_MODEL_ID = 'Llama-3.2-3B-Instruct-q4f16_1-MLC'
