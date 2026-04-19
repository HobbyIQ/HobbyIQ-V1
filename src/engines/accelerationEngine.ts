
export interface AccelerationScore {
  accelerationScore: number;
  accelerationDirection: 'up' | 'down' | 'flat';
  notes: string[];
}

interface Comp {
  date: string;
  price: number;
}

export function getAccelerationScore(comps: Comp[]): AccelerationScore {
  if (!comps || comps.length < 6) {
    return { accelerationScore: 0, accelerationDirection: 'flat', notes: ['Not enough comps for acceleration analysis'] };
  }
  const sorted = comps.slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const last3 = sorted.slice(-3).map(c => c.price);
  const prev3 = sorted.slice(-6, -3).map(c => c.price);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const last3avg = avg(last3);
  const prev3avg = avg(prev3);
  const accel = last3avg - prev3avg;
  let accelerationScore = 0;
  let accelerationDirection: 'up' | 'down' | 'flat' = 'flat';
  const notes: string[] = [];
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
