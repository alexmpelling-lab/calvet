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

// mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC (the previous choice) 404s on
// Hugging Face as of this writing — the repo appears to have been removed
// or renamed upstream by the MLC team, independent of anything in this app.
// Qwen2.5-1.5B is also smaller (~1GB vs ~1.7GB download) with a 32k context
// window, plenty for the short tool-calling JSON this app relies on.
export const LLM_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
