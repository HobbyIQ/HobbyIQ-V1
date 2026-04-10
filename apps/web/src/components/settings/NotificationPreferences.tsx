import React, { useState } from 'react';

export type NotificationType =
  | 'price-spike'
  | 'supply-drop'
  | 'sell-signal'
  | 'buy-signal'
  | 'portfolio-roi';

const NOTIFICATION_TYPES: NotificationType[] = [
  'price-spike',
  'supply-drop',
  'sell-signal',
  'buy-signal',
  'portfolio-roi',
];

export interface NotificationPreferences {
  enabled: boolean;
  channels: {
    'in-app': boolean;
    push: boolean;
  };
  types: Partial<Record<NotificationType, boolean>>;
  quietHours?: {
    start: string;
    end: string;
  };
}

interface Props {
  preferences: NotificationPreferences;
  onChange: (prefs: NotificationPreferences) => void;
}

export const NotificationPreferencesSettings: React.FC<Props> = ({ preferences, onChange }) => {
  const [prefs, setPrefs] = useState(preferences);

  const handleToggle = (field: keyof NotificationPreferences['channels']) => {
    const updated = {
      ...prefs,
      channels: { ...prefs.channels, [field]: !prefs.channels[field] },
    };
    setPrefs(updated);
    onChange(updated);
  };

  const handleTypeToggle = (type: NotificationType) => {
    const updated = {
      ...prefs,
      types: { ...prefs.types, [type]: !prefs.types?.[type] },
    };
    setPrefs(updated);
    onChange(updated);
  };

  return (
    <div>
      <h3>Notification Preferences</h3>
      <label>
        <input
          type="checkbox"
          checked={prefs.channels['in-app']}
          onChange={() => handleToggle('in-app')}
        />
        In-App Notifications
      </label>
      <label>
        <input
          type="checkbox"
          checked={prefs.channels.push}
          onChange={() => handleToggle('push')}
        />
        Push Notifications
      </label>
      <div>
        <strong>Alert Types:</strong>
        {NOTIFICATION_TYPES.map((type) => (
          <label key={type} style={{ marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={!!prefs.types?.[type]}
              onChange={() => handleTypeToggle(type)}
            />
            {type.replace(/-/g, ' ')}
          </label>
        ))}
      </div>
      <div>
        <strong>Quiet Hours (placeholder):</strong>
        <input
          type="time"
          value={prefs.quietHours?.start || ''}
          onChange={e => {
            const updated = { ...prefs, quietHours: { ...prefs.quietHours, start: e.target.value } };
            setPrefs(updated);
            onChange(updated);
          }}
        />
        to
        <input
          type="time"
          value={prefs.quietHours?.end || ''}
          onChange={e => {
            const updated = { ...prefs, quietHours: { ...prefs.quietHours, end: e.target.value } };
            setPrefs(updated);
            onChange(updated);
          }}
        />
      </div>
    </div>
  );
};
