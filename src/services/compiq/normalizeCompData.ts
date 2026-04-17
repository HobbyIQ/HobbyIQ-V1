export function normalizeComps(comps: any[]) {
  // Mock normalization
  return comps.map(c => ({ ...c, normalized: true }));
}
