interface HourlyForecast {
  time: string[]
  precipitation_probability: number[]
}

let cache: { key: string; expiresAt: number; forecast: HourlyForecast } | null = null
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 min — forecasts don't need to be fresher than that

/** Free, no-API-key weather via Open-Meteo. Only covers the next ~7 days
 * (Open-Meteo's forecast window) — anything further out or any failure
 * returns null so callers just skip the weather consideration entirely
 * rather than guessing. */
async function getHourlyForecast(lat: number, lng: number): Promise<HourlyForecast | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`
  if (cache && cache.key === key && cache.expiresAt > Date.now()) return cache.forecast

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation_probability&forecast_days=7`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const forecast: HourlyForecast = data.hourly
    if (!forecast?.time || !forecast?.precipitation_probability) return null
    cache = { key, expiresAt: Date.now() + CACHE_TTL_MS, forecast }
    return forecast
  } catch {
    return null
  }
}

/** Returns the chance of rain (0-100) at roughly the given time and place,
 * or null if it's out of forecast range, offline, or the lookup fails —
 * callers should treat null as "no weather signal available," not as "no
 * rain," so they don't quietly downgrade a mode for the wrong reason. */
export async function getRainChance(lat: number, lng: number, whenISO: string): Promise<number | null> {
  const forecast = await getHourlyForecast(lat, lng)
  if (!forecast) return null

  const targetHour = new Date(whenISO)
  targetHour.setMinutes(0, 0, 0)
  const targetISO = targetHour.toISOString().slice(0, 13) // "YYYY-MM-DDTHH"

  const index = forecast.time.findIndex((t) => t.startsWith(targetISO))
  if (index === -1) return null
  return forecast.precipitation_probability[index] ?? null
}
