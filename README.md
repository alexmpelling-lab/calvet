# Calvet

A voice-first secretary web app. Talk to it (or type) about your calendar only — it
reads, creates, edits, and deletes Google Calendar events, suggests meeting times,
and quietly keeps track of the people you mention. It refuses everything else.

Runs entirely in your browser: no backend server, no external AI API. Speech
recognition uses the browser's built-in Web Speech API. Speech output uses
[Kokoro](https://github.com/hexgrad/kokoro), a small open-weight neural TTS
model (82M params) run fully client-side via Transformers.js/ONNX Runtime
Web — noticeably more natural pacing and tone than a browser's built-in
voice, though (like every realistic in-browser TTS today) it doesn't insert
literal nonverbal sounds like laughs or coughs; it falls back to the
browser's built-in voice if the neural model can't load. The "brain" is a
small open-source LLM (Llama 3.2 3B) run fully client-side via
[WebLLM](https://github.com/mlc-ai/web-llm), and travel-time estimates use
OpenStreetMap (Nominatim) for geocoding and OSRM for routing. The only
network calls the app makes are to the Google Calendar API, Nominatim, and
OSRM — plus the one-time model downloads, cached by the browser afterwards.

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

## Deploying to Cloudflare

This repo includes a `wrangler.jsonc` set up for a Workers static-assets
deploy (Cloudflare's current unified "Workers & Pages" flow, which runs
`npx wrangler deploy` rather than the older `wrangler pages deploy`).

1. Cloudflare dashboard → **Workers & Pages → Create → Connect to Git** → pick this repo.
2. In the project's **Settings**, set **Build command** to `npm run build`
   (the deploy command `npx wrangler deploy` reads `wrangler.jsonc`'s
   `assets.directory` — `./dist` — automatically, no output-directory field needed).
3. Deploy — Cloudflare gives you a live URL and redeploys on every push to `main`.
4. Register a new Google OAuth client (see above) with that URL as an
   authorized JavaScript origin, and set `VITE_GOOGLE_CLIENT_ID` as an
   environment variable in the project's settings.

Or via CLI, once authenticated (`npx wrangler login`):
```bash
npm run build
npx wrangler deploy
```

## Installing on your iPhone

1. Deploy the app somewhere with HTTPS (Cloudflare Pages above, Vercel, Netlify,
   etc.), or use it over your LAN during development.
2. Open the URL in **Safari** on your iPhone.
3. Tap the Share icon → **Add to Home Screen**.
4. Launch it from the home screen icon — it opens full-screen, like a native app.

## How it works

- `src/auth/google.ts` — Google Identity Services token flow. Sign-in is a
  one-time event from the user's perspective: once consent is granted, an
  "ever signed in" flag persists in `localStorage`, and every future launch
  silently refreshes the access token behind the scenes (no popup, no click)
  as long as the browser still has an active Google session. A visible
  consent screen only reappears if that session itself is gone.
- `src/calendar/googleCalendar.ts` — raw Google Calendar REST calls. Nothing
  else in the app calls this directly.
- `src/db/eventsDb.ts` / `src/db/db.ts` — an IndexedDB mirror of your
  calendar events, shared with the contacts store in one database.
- `src/calendar/syncEngine.ts` — the offline-first sync loop: pushes locally
  queued changes to Google, then pulls the latest events down, merging so a
  not-yet-synced local edit always wins over a stale server copy. Runs on
  startup and whenever the browser's `online` event fires.
- `src/calendar/localCalendar.ts` — the calendar API the rest of the app
  actually uses. Every read and write goes to the local IndexedDB mirror
  first — so the app works fully offline — and opportunistically triggers a
  sync when the network is up. Free/busy lookups are computed entirely from
  the local mirror.
- `src/voice/speech.ts` — Web Speech API for listening; speaking prefers the
  neural voice (`src/voice/kokoroTts.ts`) and falls back to the browser's
  built-in synthesis if that can't load.
- `src/llm/agent.ts` — the on-device LLM agent loop: a strict system prompt scopes
  it to calendar, contacts, and travel feasibility only, and it emits small JSON
  "actions" that the app executes as tool calls before producing a final spoken reply.
- `src/db/contacts.ts` — an IndexedDB-backed contact book that grows as people are
  mentioned, with fuzzy name matching to flag possible duplicates for you to confirm.
- `src/travel/places.ts` — a local place memory: geocodes a location the
  first time it's mentioned (via OpenStreetMap Nominatim, cached locally
  afterwards) and tracks repeat visits from calendar history.
- `src/travel/estimate.ts` — travel-time estimates between two places: real
  routing via OSRM when online, a distance-based estimate offline, both
  cached locally for 30 days.
- `src/travel/feasibility.ts` / `src/travel/travelBuffer.ts` — feasibility
  checks restricted to the transport modes enabled in Settings, and
  automatic detection of a tight or infeasible gap between two
  back-to-back, different-location calendar events, offering a ready-to-add
  travel block.
- `src/settings/travelSettings.ts` + `src/components/SettingsPanel.tsx` — the
  per-mode transport toggles (driving/cycling/walking/transit), editable
  from the gear icon or by asking Calvet directly ("I don't drive").

## Offline behavior

Every calendar change — create, edit, delete — is written to the local
IndexedDB mirror immediately and reflected in the UI right away, regardless
of connectivity. If you're online, that change is pushed to Google Calendar
in the background at the same time. If you're offline, it's queued with a
`pending-create` / `pending-update` / `pending-delete` marker and pushed
automatically the next time the app detects a network connection (listening
for the browser's `online` event, plus a sync attempt on every launch).
Reads (agenda listing, free/busy suggestions) always come from the local
mirror, refreshed from Google first when online — so voice and chat keep
working uninterrupted through a dropped connection.

## Delete safety rail

Every event is tagged `createdByCalvet` when it's written. Deleting an
event Calvet made itself works immediately; deleting anything else —
already on your calendar, added by another app, or from an invite —
requires the agent to ask you first and only proceeds once you've
explicitly agreed in that conversation. There's no way to delete a
pre-existing event by voice or chat in a single turn.

## Notes

- The on-device model is much smaller than a cloud LLM, so responses are simpler
  and occasionally need a retry — this is the tradeoff for the assistant having
  no general internet/knowledge access.
- All calendar data and contact history stay on your device except for the
  Calendar API calls themselves, which go straight from your browser to Google.
- The sync engine currently reflects new/changed events from Google, and
  detects events deleted through this app; an event deleted directly in
  Google Calendar (outside this app) won't disappear from the local mirror
  until it ages out of the upcoming-events window.
