import { useState } from 'react'
import { getTravelSettings, setModeEnabled, TRAVEL_MODES, type TravelMode } from '../settings/travelSettings'

interface SettingsPanelProps {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState(getTravelSettings())

  function toggle(mode: TravelMode) {
    const next = setModeEnabled(mode, !settings[mode])
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
