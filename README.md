# Calvet

A voice-first secretary web app. Talk to it (or type) about your calendar only — it
reads, creates, edits, and deletes Google Calendar events, suggests meeting times,
and quietly keeps track of the people you mention. It refuses everything else.

Runs entirely in your browser: no backend server, no external AI API. Speech
recognition/synthesis use the browser's built-in Web Speech API, and the "brain"
is a small open-source LLM (Llama 3.2 3B) run fully client-side via
[WebLLM](https://github.com/mlc-ai/web-llm) — the only network calls the app makes
are to the Google Calendar API.

## Setup

A Google OAuth client ID ships baked into `src/config.ts`, registered for
`http://localhost:5173` — nothing to configure for local use.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome, Edge, or Safari 17+. Sign in with
Google (you'll see a one-time "Google hasn't verified this app" screen —
expected for a personal project; click Continue), grant Calendar access,
and you're in. First launch also downloads the local LLM weights (a few
hundred MB, cached by the browser afterwards) — this requires a
WebGPU-capable browser.

### Deploying elsewhere / using your own Google account

The bundled client ID only works from `http://localhost:5173`, and only
test users added to its consent screen can sign in. To run this under a
different domain, or let other Google accounts sign in, register your own
OAuth client (Google Cloud Console → APIs & Services → Credentials → Create
OAuth client ID → Web application → add your origin), then override the
bundled one with an environment variable:

```bash
cp .env.example .env   # set VITE_GOOGLE_CLIENT_ID to your own client ID
```

## Deploying to Cloudflare Pages

This repo includes a `wrangler.jsonc` for Cloudflare Pages. Easiest path —
no local Cloudflare credentials needed:

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick this repo. Build command: `npm run build`. Output directory: `dist`.
3. Deploy — Cloudflare gives you a `*.pages.dev` URL and redeploys on every push to `main`.
4. Register a new Google OAuth client (see above) with that `*.pages.dev` URL as
   an authorized JavaScript origin, and set `VITE_GOOGLE_CLIENT_ID` as an
   environment variable in the Pages project settings.

Or via CLI, once authenticated (`npx wrangler login`):
```bash
npm run build
npx wrangler pages deploy dist --project-name calvet
```

## Installing on your iPhone

1. Deploy the app somewhere with HTTPS (Cloudflare Pages above, Vercel, Netlify,
   etc.), or use it over your LAN during development.
2. Open the URL in **Safari** on your iPhone.
3. Tap the Share icon → **Add to Home Screen**.
4. Launch it from the home screen icon — it opens full-screen, like a native app.

## How it works

- `src/auth/google.ts` — Google Identity Services token flow (Calendar scopes only).
- `src/calendar/api.ts` — direct Google Calendar REST calls (list/create/update/delete
  events, free/busy lookup for scheduling suggestions).
- `src/voice/speech.ts` — Web Speech API wrappers for listening and speaking.
- `src/llm/agent.ts` — the on-device LLM agent loop: a strict system prompt scopes
  it to calendar + contacts only, and it emits small JSON "actions" that the app
  executes as calendar/contact tool calls before producing a final spoken reply.
- `src/db/contacts.ts` — an IndexedDB-backed contact book that grows as people are
  mentioned, with fuzzy name matching to flag possible duplicates for you to confirm.

## Notes

- The on-device model is much smaller than a cloud LLM, so responses are simpler
  and occasionally need a retry — this is the tradeoff for the assistant having
  no general internet/knowledge access.
- All calendar data and contact history stay on your device except for the
  Calendar API calls themselves, which go straight from your browser to Google.
