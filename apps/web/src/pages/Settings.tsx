import React, { useState } from 'react';
import { NotificationPreferencesSettings, NotificationPreferences } from '../components/settings/NotificationPreferences';

const defaultPrefs: NotificationPreferences = {
  enabled: true,
  channels: { 'in-app': true, push: false },
  types: {
    'price-spike': true,
    'supply-drop': true,
    'sell-signal': true,
    'buy-signal': true,
    'portfolio-roi': true,
  },
  quietHours: { start: '', end: '' },
};

export default function SettingsPage() {
  const [prefs, setPrefs] = useState(defaultPrefs);

  return (
    <div>
      <h2>Settings</h2>
      <NotificationPreferencesSettings preferences={prefs} onChange={setPrefs} />
    </div>
  );
}
