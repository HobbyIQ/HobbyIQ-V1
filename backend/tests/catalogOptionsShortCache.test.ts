// CF-CATALOG-OPTIONS-SHORT-CACHE (2026-08-21) — pin the catalogOptions cache.
//
// THE PROBLEM. /api/compiq/search prices the query through a 15-minute
// cacheWrap, then attaches `catalogOptions` (the checklist picker) from
// searchCatalog. That second lookup was deliberately left OUTSIDE the cache so
// a newly-ingested checklist row appeared immediately instead of after the
// pricing TTL. The freshness was real; the bill was that EVERY request paid
// full catalog cost, including requests that hit the pricing cache and got
// their priced answer for ~0ms. Measured on an idle box (CPU ~10%, no backfill
// running), catalogMs on requests where the engine returned from cache:
//
//     92.8s  70.6s  45.2s  23.5s  23.2s  22.5s  22.4s  22.1s ...
//
// So repeating a search cost 20-90s every single time while the priced part
// was already free.
//
// THE FIX. Cache the options too, under their OWN key, for 60s — 15x tighter
// than the pricing TTL it was written to beat, so the original intent survives
// (a checklist row ingested now is visible within a minute) while repeat
// searches stop re-running the catalog.
//
// THIS FILE PINS:
//   1. A repeated query re-uses the cached options — searchCatalog runs ONCE.
//   2. Two different queries NEVER share options. This is the exact failure
//      the original comment warned about ("serve one query's checklist to
//      another"); it is why the options get their own key rather than being
//      merged into the pricing entry.
//   3. Case and whitespace differences are the SAME query, not a cache miss.
//   4. A zero-hit lookup is NOT persisted, so a cold catalog or a transient
//      Cosmos blip cannot pin "no options" for the whole TTL.
//   5. The TTL is genuinely short, and strictly shorter than the pricing TTL.
//      If someone raises it to 15 minutes they have silently given back the
//      freshness this design was built to keep.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  cacheWrap,
  __resetMemoryCacheForTest,
  __cacheServiceInternals,
} from "../src/services/shared/cache.service.js";

// Mirrors compiq.routes.ts. Kept here so the RULES stay pinned even if the
// route around them is refactored.
const CATALOG_OPTIONS_TTL_SECONDS = 60;
const PRICING_TTL_SECONDS = 15 * 60;

function normalizeCacheKey(prefix: string, query: string): string {
  return `${prefix}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

const skipCacheWhen = (r: any) =>
  !r || !Array.isArray(r.hits) || r.hits.length === 0;

/** Stands in for the route's catalogOptions block. */
function makeLookup(impl: (q: string) => { hits: unknown[] }) {
  let calls = 0;
  const fetchOptions = (query: string) =>
    cacheWrap(
      normalizeCacheKey("compiq:catalogopts:v1", query),
      async () => {
        calls++;
        return impl(query);
      },
      { freshTtlSeconds: CATALOG_OPTIONS_TTL_SECONDS, skipCacheWhen },
    );
  return { fetchOptions, calls: () => calls };
}

beforeEach(() => {
  delete process.env.REDIS_HOST;
  __resetMemoryCacheForTest();
  __cacheServiceInternals.resetPrefixCounters();
  __cacheServiceInternals.stopEmitTimer();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __cacheServiceInternals.stopEmitTimer();
});

describe("CF-CATALOG-OPTIONS-SHORT-CACHE", () => {
  it("repeating a query does not re-run the catalog", async () => {
    const q = "2024 Bowman Chrome Blue Raywave Auto Leo De Vries";
    const { fetchOptions, calls } = makeLookup(() => ({ hits: [{ id: "hiq:a" }] }));

    const first = await fetchOptions(q);
    const second = await fetchOptions(q);

    expect(calls()).toBe(1); // the 20-90s lookup, paid once
    expect(second).toEqual(first);
  });

  it("does NOT serve one query's checklist to another", async () => {
    // The failure the original uncached design existed to avoid. Own key, so
    // two queries cannot collide no matter how close their text.
    const { fetchOptions, calls } = makeLookup((q) => ({ hits: [{ q }] }));

    const vries = await fetchOptions("2024 Bowman Chrome Auto Leo De Vries");
    const doncic = await fetchOptions("2018 Panini Prizm Silver Luka Doncic");

    expect(calls()).toBe(2);
    expect(vries.hits).toEqual([{ q: "2024 Bowman Chrome Auto Leo De Vries" }]);
    expect(doncic.hits).toEqual([{ q: "2018 Panini Prizm Silver Luka Doncic" }]);
  });

  it("treats case and spacing differences as the same query", async () => {
    const { fetchOptions, calls } = makeLookup(() => ({ hits: [{ id: "hiq:a" }] }));

    await fetchOptions("2018 Panini Prizm Luka Doncic");
    await fetchOptions("  2018   PANINI  Prizm   luka doncic  ");

    expect(calls()).toBe(1);
  });

  it("does not persist a zero-hit lookup", async () => {
    // A cold catalog or a Cosmos blip returns []. Caching that would pin
    // "no options" for the full TTL, and the next request is exactly the one
    // that would have repaired it.
    let calls = 0;
    const flaky = () =>
      cacheWrap(
        normalizeCacheKey("compiq:catalogopts:v1", "cold query"),
        async () => {
          calls++;
          return calls === 1 ? { hits: [] } : { hits: [{ id: "hiq:a" }] };
        },
        { freshTtlSeconds: CATALOG_OPTIONS_TTL_SECONDS, skipCacheWhen },
      );

    const blip = await flaky();
    expect(blip.hits).toEqual([]); // caller still gets the empty answer

    const repaired = await flaky(); // retried, not served from cache
    expect(calls).toBe(2);
    expect(repaired.hits).toEqual([{ id: "hiq:a" }]);
  });

  it("expires within a minute so new checklist rows still surface fast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));

    const { fetchOptions, calls } = makeLookup(() => ({ hits: [{ id: "hiq:a" }] }));
    const q = "2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond";

    await fetchOptions(q);
    vi.setSystemTime(new Date("2026-08-21T12:00:30Z")); // +30s
    await fetchOptions(q);
    expect(calls()).toBe(1); // still fresh

    vi.setSystemTime(new Date("2026-08-21T12:01:01Z")); // +61s
    await fetchOptions(q);
    expect(calls()).toBe(2); // re-read; a row ingested at 12:00:05 is now visible
  });

  it("stays far tighter than the pricing TTL", async () => {
    // Guards the trade-off itself. Raising this to the pricing TTL would give
    // back the checklist immediacy the uncached design was protecting.
    expect(CATALOG_OPTIONS_TTL_SECONDS).toBeLessThanOrEqual(60);
    expect(CATALOG_OPTIONS_TTL_SECONDS * 10).toBeLessThanOrEqual(PRICING_TTL_SECONDS);
  });
});
