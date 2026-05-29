// Concurrency-limited parallel-async helpers.
//
// Extracted from dynamicIngestion.service.ts (where the original
// withConcurrency lived as a file-private helper) so both the
// DailyIQ ingestion path and the unified-search detail-enrichment
// path can share it. Plus a new `withConcurrencyResult` variant
// that ISOLATES per-task errors instead of throwing — needed for
// partial-failure semantics where a single failed Cardsight detail
// fetch should not kill an entire picker response.
//
// Both helpers:
//   - Preserve input ordering in the returned array
//   - Run at most `limit` tasks concurrently via a worker-pool pattern
//   - Tolerate `items.length === 0` (return empty array)
//   - Clamp limit to `[1, items.length]` to avoid spinning up
//     more workers than work
//
// Neither helper adds a dependency. ~30 lines total.

/**
 * Run `fn` over `items` with at most `limit` concurrent executions.
 * Preserves input order in the returned array.
 *
 * **Throws on individual task failure** — any error from `fn` propagates
 * and aborts in-flight work. Use `withConcurrencyResult` when partial
 * failures must be observable rather than catastrophic.
 */
export async function withConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const results: U[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Settled-result variant of `withConcurrency`. Per-task errors are
 * captured as `{ ok: false, error }` entries; successful results are
 * captured as `{ ok: true, value }`. The pool ALWAYS resolves with
 * one entry per input item, in input order.
 *
 * Use this when partial failures must be observable but should not
 * cascade. Example: Cardsight detail enrichment across N search hits
 * where a single 404 / timeout should leave the rest of the picker
 * page intact.
 */
export type PoolResult<U> =
  | { ok: true; value: U }
  | { ok: false; error: unknown };

export async function withConcurrencyResult<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<PoolResult<U>[]> {
  if (items.length === 0) return [];
  const results: PoolResult<U>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (error) {
        results[idx] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
