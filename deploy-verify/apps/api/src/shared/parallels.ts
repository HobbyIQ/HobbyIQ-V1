// Parallel logic for CompIQ

const PARALLEL_MULTIPLIERS: Record<string, number> = {
  Silver: 1.2,
  Gold: 1.5,
  Red: 1.7,
  Blue: 1.3,
  Green: 1.4,
  Base: 1.0,
  Auto: 1.8
};

export function getParallelMultiplier(parallel: string | null | undefined): number {
  if (!parallel) return 1.0;
  return PARALLEL_MULTIPLIERS[parallel] || 1.0;
}

export function normalizeParallel(parallel: string | null | undefined): string | null {
  if (!parallel) return null;
  return parallel.trim().toLowerCase();
}
