export function selectComps(comps: any[]): { selected: any[], liquidityTier: string, usedInterpolation: boolean } {
  let selected = [];
  let liquidityTier = 'low';
  let usedInterpolation = false;
  if (comps.length >= 12) {
    selected = comps.slice(0, 20);
    liquidityTier = 'high';
  } else if (comps.length >= 6) {
    selected = comps;
    liquidityTier = 'medium';
  } else if (comps.length >= 3) {
    selected = comps;
    liquidityTier = 'low';
    usedInterpolation = true;
  } else {
    selected = comps;
    liquidityTier = 'very-low';
    usedInterpolation = true;
  }
  return { selected, liquidityTier, usedInterpolation };
}
