// CF-PAGINATION-CLAMP-P1 (Drew, 2026-07-26). Shared limit/pageSize
// clamping for query-string pagination. Prevents a caller from asking
// for `?limit=99999999` and forcing a runaway Cosmos scan.
//
// Each route decides its own {default, min, max} — call it per-endpoint.
// The helper accepts `unknown` because `req.query.limit` is typed as
// string | ParsedQs | string[] | undefined and every call site coerces
// differently today.

export interface ClampOptions {
  /** Value returned when the input is missing, non-numeric, or ≤ 0. */
  default: number;
  /** Lower bound (inclusive). Defaults to 1. */
  min?: number;
  /** Upper bound (inclusive). Required — routes must pick their own ceiling. */
  max: number;
}

/**
 * Clamp a raw query-string value to `[min, max]`, falling back to
 * `default` on any non-numeric / non-finite / ≤ 0 input. Floors any
 * decimal input so callers can safely pass the result to
 * `container.items.query` without worrying about half-row semantics.
 */
export function clampLimit(raw: unknown, opts: ClampOptions): number {
  const min = opts.min ?? 1;
  const max = opts.max;
  if (min > max) {
    throw new Error(`clampLimit: min (${min}) must be ≤ max (${max})`);
  }
  // Only strings + numbers count. Arrays / objects / undefined → default.
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim().length > 0) n = Number(raw);
  else return clampToRange(opts.default, min, max);
  if (!Number.isFinite(n) || n <= 0) return clampToRange(opts.default, min, max);
  return clampToRange(Math.floor(n), min, max);
}

function clampToRange(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
