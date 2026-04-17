// Acceleration Engine
export function getAccelerationScore(comps: any[]): { accelerationScore: number, accelerationDirection: string, notes: string[] } {
  if (!comps || comps.length < 6) {
    return { accelerationScore: 0, accelerationDirection: 'flat', notes: ['Not enough comps for acceleration analysis'] };
  }
  const sorted = comps.slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const last3 = sorted.slice(-3).map(c => c.price);
  const prev3 = sorted.slice(-6, -3).map(c => c.price);
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const last3avg = avg(last3);
  const prev3avg = avg(prev3);
  const accel = last3avg - prev3avg;
  let accelerationScore = 0;
  let accelerationDirection = 'flat';
  let notes = [];
  if (accel > 0) {
    accelerationScore = Math.min(1, accel / prev3avg);
    accelerationDirection = 'up';
    notes.push('Recent comps accelerating upward');
  } else if (accel < 0) {
    accelerationScore = Math.max(-1, accel / prev3avg);
    accelerationDirection = 'down';
    notes.push('Recent comps accelerating downward');
  } else {
    notes.push('No acceleration detected');
  }
  return { accelerationScore, accelerationDirection, notes };
}
