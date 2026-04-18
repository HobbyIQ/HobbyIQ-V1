export type EventType =
  | 'performance_hot'
  | 'performance_cold'
  | 'promotion'
  | 'ranking_up'
  | 'ranking_down'
  | 'award'
  | 'injury'
  | 'hype_spike';

export interface CardEvent {
  eventType: EventType;
  impactScore: number; // 0-1
  direction: 'positive' | 'negative';
  durationDays: number;
  confidence: number; // 0-1
}

export function getEventModel(eventType: EventType): CardEvent {
  // Deterministic, mock-safe event model
  switch (eventType) {
    case 'promotion':
      return { eventType, impactScore: 0.8, direction: 'positive', durationDays: 30, confidence: 0.85 };
    case 'performance_hot':
      return { eventType, impactScore: 0.6, direction: 'positive', durationDays: 14, confidence: 0.7 };
    case 'ranking_up':
      return { eventType, impactScore: 0.5, direction: 'positive', durationDays: 21, confidence: 0.7 };
    case 'award':
      return { eventType, impactScore: 0.9, direction: 'positive', durationDays: 60, confidence: 0.9 };
    case 'hype_spike':
      return { eventType, impactScore: 0.5, direction: 'positive', durationDays: 7, confidence: 0.6 };
    case 'injury':
      return { eventType, impactScore: 0.7, direction: 'negative', durationDays: 21, confidence: 0.8 };
    case 'performance_cold':
      return { eventType, impactScore: 0.4, direction: 'negative', durationDays: 14, confidence: 0.6 };
    case 'ranking_down':
      return { eventType, impactScore: 0.4, direction: 'negative', durationDays: 21, confidence: 0.6 };
    default:
      return { eventType, impactScore: 0.5, direction: 'positive', durationDays: 14, confidence: 0.5 };
  }
}
