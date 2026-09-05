import { GOOGLE_CLIENT_ID, CALENDAR_SCOPES } from '../config'

const TOKEN_STORAGE_KEY = 'calvet_google_token'
const EVER_SIGNED_IN_KEY = 'calvet_ever_signed_in'

interface StoredToken {
  accessToken: string
  expiresAt: number
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: { access_token?: string; expires_in?: number; error?: string }) => void
          }) => { requestAccessToken: (opts?: { prompt?: string }) => void }
        }
      }
    }
  }
}

function loadStoredToken(): StoredToken | null {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (!raw) return null
  try {
    const token = JSON.parse(raw) as StoredToken
    if (token.expiresAt > Date.now()) return token
  } catch {
    // ignore malformed token
  }
  return null
}

function saveToken(token: StoredToken) {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token))
}

export function clearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
}

export function getStoredAccessToken(): string | null {
  return loadStoredToken()?.accessToken ?? null
}

// "Signed in" for the app's purposes means the one-time consent has ever
// been granted, not that today's access token happens to still be valid —
// tokens expire hourly, but the user should only ever see the login screen
// once. A stale token is silently refreshed behind the scenes instead.
export function isSignedIn(): boolean {
  return localStorage.getItem(EVER_SIGNED_IN_KEY) === '1'
}

/**
 * Requests a Google OAuth access token with Calendar scopes via Google
 * Identity Services. Resolves once the user grants consent (or an existing
 * valid token is already cached).
 *
 * `interactive: false` attempts a silent refresh (no popup, no click) —
 * this succeeds as long as the browser still has an active Google session
 * and consent was already granted, which is the common case for a returning
 * user. It only falls back to a visible consent prompt (`interactive: true`)
 * when silent refresh isn't possible (e.g. the very first sign-in, or the
 * browser's Google session itself has been signed out).
 */
export function requestAccessToken(interactive: boolean): Promise<string> {
  const existing = loadStoredToken()
  if (existing && !interactive) return Promise.resolve(existing.accessToken)

  return new Promise((resolve, reject) => {
    if (!window.google) {
      reject(new Error('Google Identity Services script has not loaded yet.'))
      return
    }
    if (!GOOGLE_CLIENT_ID) {
      reject(new Error('Missing VITE_GOOGLE_CLIENT_ID. See .env.example.'))
      return
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: CALENDAR_SCOPES,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error ?? 'Failed to obtain access token'))
          return
        }
        const expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000 - 60_000
        saveToken({ accessToken: response.access_token, expiresAt })
        localStorage.setItem(EVER_SIGNED_IN_KEY, '1')
        resolve(response.access_token)
      },
    })
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

/** Gets a usable access token without ever showing UI, refreshing silently
 * if the cached one is stale. Throws if silent refresh isn't possible. */
export async function getFreshAccessTokenSilently(): Promise<string> {
  const cached = getStoredAccessToken()
  if (cached) return cached
  return requestAccessToken(false)
}

/** Attempts to restore a previously-granted session with no visible UI.
 * Call this once at app startup for a returning user. */
export async function trySilentSignIn(): Promise<boolean> {
  if (!isSignedIn()) return false
  if (getStoredAccessToken()) return true
  try {
    await requestAccessToken(false)
    return true
  } catch {
    return false
  }
}

export function signOut() {
  clearToken()
  localStorage.removeItem(EVER_SIGNED_IN_KEY)
}
