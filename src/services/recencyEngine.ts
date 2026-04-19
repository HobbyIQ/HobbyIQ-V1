import { Comp } from '../models/compiq';

export function scoreRecency(comps: Comp[]): Comp[] {
  const now = Date.now();
  return comps.map(comp => {
    const days = (now - new Date(comp.saleDate).getTime()) / (1000 * 60 * 60 * 24);
    let recencyScore = 0;
    if (days <= 7) recencyScore = 1.0;
    else if (days <= 14) recencyScore = 0.85;
    else if (days <= 30) recencyScore = 0.7;
    else if (days <= 60) recencyScore = 0.4;
    else recencyScore = 0.1;
    return { ...comp, recencyScore };
  });
}
