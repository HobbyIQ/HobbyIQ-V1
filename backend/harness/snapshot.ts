/**
 * Stable-key JSON serializer for harness snapshots.
 *
 * Goals:
 *  - Identical inputs always produce byte-identical output.
 *  - Volatile fields (timestamps, request IDs, cache keys, durations)
 *    are stripped before snapshotting.
 *  - Floats are quantized so 0.1 + 0.2 doesn't flap snapshots.
 */

/** Field names that vary across runs and must be stripped from snapshots. */
const VOLATILE_FIELDS = new Set<string>([
  "requestId",
  "traceId",
  "correlationId",
  "cacheKey",
  "computedAt",
  "generatedAt",
  "timestamp",
  "responseTimeMs",
  "elapsedMs",
  "durationMs",
  "serverTime",
  "now",
  "_etag",
  "_rid",
  "_self",
  "_attachments",
  "_ts",
]);

const FLOAT_PRECISION = 4;

function quantize(n: number): number {
  if (!Number.isFinite(n)) return n;
  if (Number.isInteger(n)) return n;
  const factor = 10 ** FLOAT_PRECISION;
  return Math.round(n * factor) / factor;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return quantize(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      if (VOLATILE_FIELDS.has(k)) continue;
      out[k] = normalize(value[k]);
    }
    return out;
  }
  // Functions, symbols, etc. — coerce to string for visibility.
  return String(value);
}

/**
 * Produce a deterministic snapshot object suitable for JSON.stringify
 * with stable byte output across runs.
 */
export function snapshot(value: unknown): unknown {
  return normalize(value);
}

/** Serialize a snapshot to its canonical on-disk string form. */
export function serializeSnapshot(value: unknown): string {
  return JSON.stringify(snapshot(value), null, 2) + "\n";
}
