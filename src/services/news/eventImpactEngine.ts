export function getNewsSignal(payload: any) {
  // Mock: always positive
  return { newsSignal: 'positive', impactScore: 70, decayDays: 2, sourceCount: 3 };
}
