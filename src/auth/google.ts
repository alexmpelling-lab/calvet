import { GOOGLE_CLIENT_ID, CALENDAR_SCOPES } from '../config'

const TOKEN_STORAGE_KEY = 'calvet_google_token'

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

export function isSignedIn(): boolean {
  return getStoredAccessToken() !== null
}

/**
 * Requests a Google OAuth access token with Calendar scopes via Google
 * Identity Services. Resolves once the user grants consent (or an existing
 * valid token is already cached).
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
        resolve(response.access_token)
      },
    })
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

export function signOut() {
  clearToken()
}
