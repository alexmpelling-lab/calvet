export type TravelMode = 'driving' | 'cycling' | 'walking' | 'transit'

export const TRAVEL_MODES: { mode: TravelMode; label: string }[] = [
  { mode: 'driving', label: 'Driving' },
  { mode: 'cycling', label: 'Cycling' },
  { mode: 'walking', label: 'Walking' },
  { mode: 'transit', label: 'Public transit' },
]

const STORAGE_KEY = 'calvet_travel_settings'

type TravelSettings = Record<TravelMode, boolean>

const DEFAULT_SETTINGS: TravelSettings = {
  driving: true,
  cycling: true,
  walking: true,
  transit: true,
}

function load(): TravelSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function save(settings: TravelSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function getTravelSettings(): TravelSettings {
  return load()
}

export function getEnabledModes(): TravelMode[] {
  const settings = load()
  return TRAVEL_MODES.map((m) => m.mode).filter((mode) => settings[mode])
}

export function setModeEnabled(mode: TravelMode, enabled: boolean): TravelSettings {
  const settings = load()
  settings[mode] = enabled
  save(settings)
  notify()
  return settings
}

/** Best-effort parse of a spoken/typed phrase like "I don't drive" or
 * "turn off cycling" into a mode + enabled flag, for the agent's
 * update_travel_settings tool. Returns null if nothing recognizable. */
export function parseTravelModePhrase(text: string): { mode: TravelMode; enabled: boolean } | null {
  const lower = text.toLowerCase()
  const negated = /(don't|do not|no longer|stop|turn off|disable|can't|cannot)/.test(lower)
  const affirmed = /(turn on|enable|start|i do|i can)/.test(lower)
  for (const { mode, label } of TRAVEL_MODES) {
    const keyword = mode === 'transit' ? 'transit|public transport|bus|train' : label.toLowerCase()
    if (new RegExp(keyword).test(lower)) {
      return { mode, enabled: affirmed ? true : !negated }
    }
  }
  if (/drive|driving|car/.test(lower)) return { mode: 'driving', enabled: !negated }
  if (/cycl|bike|bicycle/.test(lower)) return { mode: 'cycling', enabled: !negated }
  if (/walk/.test(lower)) return { mode: 'walking', enabled: !negated }
  return null
}

const listeners = new Set<() => void>()
function notify() {
  listeners.forEach((cb) => cb())
}
export function onTravelSettingsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
