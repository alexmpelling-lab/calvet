import { useEffect, useState } from 'react'
import { getTravelSettings, onTravelSettingsChange, setModeEnabled, TRAVEL_MODES, type TravelMode } from '../settings/travelSettings'

interface SettingsPanelProps {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState(getTravelSettings())

  useEffect(() => {
    // A voice/chat change ("I don't drive") made while this panel happens to
    // be open previously left its toggles showing stale state — and worse,
    // the next tap here would silently revert that just-made change since it
    // computed the new value from the stale local snapshot.
    return onTravelSettingsChange(() => setSettings(getTravelSettings()))
  }, [])

  function toggle(mode: TravelMode) {
    const current = getTravelSettings()
    const next = setModeEnabled(mode, !current[mode])
    setSettings({ ...next })
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Settings</span>
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="settings-body">
        <div className="settings-label">How do you get around?</div>
        <div className="settings-hint">
          Calvet only considers these when working out travel times and feasibility — you can also just
          tell it in chat, like "I don't drive".
        </div>
        <div className="toggle-list">
          {TRAVEL_MODES.map(({ mode, label }) => (
            <label className="toggle-row" key={mode}>
              <span>{label}</span>
              <span className={`switch ${settings[mode] ? 'on' : ''}`} onClick={() => toggle(mode)}>
                <span className="switch-knob" />
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
